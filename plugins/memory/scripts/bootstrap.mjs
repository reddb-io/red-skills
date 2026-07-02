#!/usr/bin/env node
/**
 * bootstrap.mjs — dependency-free runtime resolver for the Memory plugin.
 *
 * The plugin ships as a marketplace git checkout into the cache; Claude Code /
 * Codex never run a build or install, so the compiled CLI and its 137 MB of
 * deps cannot live in the checkout. Instead the release publishes a single
 * esbuild bundle (`memory-cli.mjs`, all JS deps inlined) plus a runtime
 * manifest, and the native `red` engine binary is pinned by that manifest and
 * reused from reddb-io/reddb's own releases. This script — invoked by lifecycle
 * hooks and MCP launchers in place of built output — fetches those artifacts
 * once per plugin version into a version-keyed cache that survives `autoUpdate`,
 * then delegates the call.
 *
 * It uses only `node:` builtins because it runs before any dependency exists.
 * See ADR 0029.
 *
 * Contract preserved from the old hook: on any failure it prints `{}` on stdout
 * (the no-op the hooks expect) and logs an actionable line — never silent.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, appendFile, unlink } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RED_SKILLS_REPO = "reddb-io/red-skills";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/bootstrap.test.ts)
// ---------------------------------------------------------------------------

/** Map node's platform/arch to the reddb release asset key. null = unsupported. */
export function platformKey(plat = platform(), architecture = arch()) {
  const os = { linux: "linux", darwin: "macos", win32: "windows" }[plat];
  const cpu = { x64: "x86_64", arm64: "aarch64", arm: "armv7" }[architecture];
  if (!os || !cpu) return null;
  return `${os}-${cpu}`;
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Release host. Overridable via RED_MEMORY_RELEASE_BASE so the launcher tests
 * can point every asset URL at a local server — no real network, ever.
 */
const RELEASE_HOST = process.env.RED_MEMORY_RELEASE_BASE || "https://github.com";

/** GitHub release asset URL. */
export function assetUrl(repo, tag, name) {
  return `${RELEASE_HOST}/${repo}/releases/download/${tag}/${name}`;
}

/**
 * Which invocations may hit the network on a cache miss. Only the resolve/warm
 * points do: the once-per-session SessionStart hook, the long-lived mcp server,
 * and user-invoked CLI commands. The recurring PostToolUse / Stop / PreCompact
 * hooks are render/hot paths — they must never block on a synchronous fetch
 * (ADR 0084, the statusline-blanking lesson). On a cold cache they no-op and
 * let SessionStart warm the cache.
 */
export function mayFetchRuntime(argv) {
  if (argv[0] === "hook") return argv[1] === "SessionStart";
  return true;
}

/** Parse the first hex token out of a `*.sha256` file body (`<hex>  <name>`). */
export function parseSha256File(body) {
  const m = String(body).match(/\b[0-9a-f]{64}\b/i);
  return m ? m[0].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

function runtimeRoot() {
  const base =
    process.env.RED_MEMORY_CACHE_DIR ||
    process.env.XDG_CACHE_HOME ||
    join(homedir(), ".cache");
  return join(base, "reddb-memory");
}

async function pluginVersion() {
  const root =
    process.env.CLAUDE_PLUGIN_ROOT ||
    process.env.CODEX_PLUGIN_ROOT ||
    join(HERE, "..");
  try {
    const pj = JSON.parse(
      await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
    return pj.version;
  } catch {
    return null;
  }
}

/** Machine-readable degrade marker path — the `memory doctor` reads this. */
export function degradeMarkerPath() {
  return join(runtimeRoot(), "runtime-degraded.json");
}

/**
 * Record an offline / failed-first-fetch degrade as a machine-readable marker
 * the doctor can later report. Best-effort: writing the marker must never throw,
 * so a degrade never becomes a crash.
 */
async function writeDegradeMarker(version, err, argv) {
  try {
    await mkdir(runtimeRoot(), { recursive: true });
    await writeFile(
      degradeMarkerPath(),
      JSON.stringify(
        {
          schema: "red.memory.runtime-degraded.v1",
          plugin: "memory",
          version: version ?? null,
          reason: String(err?.message ?? err),
          argv,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* marker writing must never throw */
  }
}

/** Clear a stale degrade marker once the runtime resolves again. */
async function clearDegradeMarker() {
  await unlink(degradeMarkerPath()).catch(() => {});
}

async function logLine(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await appendFile(join(runtimeRoot(), "bootstrap.log"), line).catch(
      () => {},
    );
    process.stderr.write(`memory bootstrap: ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download `url` to `dest` and verify against `expectedSha` (hex) if given. */
async function ensureFile(url, dest, expectedSha, { mode } = {}) {
  if (existsSync(dest)) {
    if (!expectedSha) return;
    const have = sha256Hex(await readFile(dest));
    if (have === expectedSha.toLowerCase()) return;
    await logLine(`checksum drift at ${dest}, refetching`);
  }
  const buf = await fetchBuffer(url);
  if (expectedSha) {
    const got = sha256Hex(buf);
    if (got !== expectedSha.toLowerCase()) {
      throw new Error(`checksum mismatch for ${url}: ${got} != ${expectedSha}`);
    }
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  if (mode) await chmod(dest, mode);
}

/**
 * Ensure {cli.mjs, memory-mcp.mjs, red} exist for `version` in the version-keyed
 * cache and return their absolute paths. Throws (caught by main) on any fetch
 * failure.
 */
async function ensureRuntime(version, { mayFetch } = {}) {
  const dir = join(runtimeRoot(), version);
  const cliPath = join(dir, "memory-cli.mjs");
  const mcpPath = join(dir, "memory-mcp.mjs");
  const redPath = join(dir, process.platform === "win32" ? "red.exe" : "red");

  // Fast path: a fully warm cache delegates with ZERO network. The old code
  // re-fetched the manifest on *every* invocation to re-verify checksums; that
  // synchronous network hop on a render/hot path is exactly the
  // statusline-blanking class (ADR 0084). Once resolved for a version, trust the
  // cache — the first fetch already verified every checksum.
  if (existsSync(cliPath) && existsSync(mcpPath) && existsSync(redPath)) {
    return { cliPath, mcpPath, redPath };
  }

  // Cold cache on a render/hot path (recurring PostToolUse / Stop / PreCompact
  // hooks): never fetch. Defer to the SessionStart resolve point and no-op this
  // call. `null` tells the caller to honour the hook no-op contract.
  if (!mayFetch) return null;

  // 1. manifest — names + checksums for this exact plugin version.
  const tag = `v${version}`;
  const manifest = JSON.parse(
    (
      await fetchBuffer(
        assetUrl(RED_SKILLS_REPO, tag, "memory-runtime-manifest.json"),
      )
    ).toString("utf8"),
  );

  // 2. bundled CLI (platform-independent).
  await ensureFile(
    assetUrl(RED_SKILLS_REPO, tag, manifest.cli.asset),
    cliPath,
    manifest.cli.sha256,
  );

  // 3. bundled MCP server (platform-independent).
  if (manifest.mcp) {
    await ensureFile(
      assetUrl(RED_SKILLS_REPO, tag, manifest.mcp.asset),
      mcpPath,
      manifest.mcp.sha256,
    );
  }

  // 4. native `red` binary (per-platform), reused from reddb-io/reddb releases.
  const key = platformKey();
  const redAsset = key && normalizeRedAsset(manifest.reddb?.assets?.[key]);
  if (!redAsset) {
    throw new Error(`no red binary for platform ${key ?? "unknown"}`);
  }
  await ensureFile(
    assetUrl(manifest.reddb.repo, manifest.reddb.tag, redAsset.asset),
    redPath,
    redAsset.sha256,
    { mode: 0o755 },
  );

  return { cliPath, mcpPath, redPath };
}

function normalizeRedAsset(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.asset !== "string") return null;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.sha256)) return null;
  return { asset: value.asset, sha256: value.sha256.toLowerCase() };
}

// ── Per-directory plugin gate (ADR 0067) ─────────────────────────────────────
// Mirror of packages/shared/plugin-gate.ts (pluginEnabledInConfig + walk-up),
// inlined because the launcher ships dependency-free in the plugin checkout and
// cannot import the shared module at runtime. Keep the three copies in lockstep.
function stripInlineComment(value) {
  const hash = value.indexOf(" #");
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}
function flatConfigValue(text, dottedKey) {
  const stack = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const indent = line.length - line.trimStart().length;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const value = line.slice(colon + 1).trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });
    if (value && stack.map((s) => s.key).join(".") === dottedKey) {
      return stripInlineComment(value);
    }
  }
  return undefined;
}
function isPluginEnabled(cwd, plugin) {
  let dir = cwd;
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, ".red", "config.yaml");
    if (existsSync(candidate)) {
      try {
        return flatConfigValue(readFileSync(candidate, "utf8"), `plugins.${plugin}.enabled`) === "true";
      } catch {
        return false;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// ── Inert MCP server (issue #843) ────────────────────────────────────────────
// When the plugin is gated off (ADR 0067), the `cli`/`hook` paths no-op by
// printing `{}` and exiting 0. The `mcp` stdio path cannot do that: exiting
// closes the pipe before the MCP handshake, which the host reports as
// `✘ Failed to connect` ("1 error during load"). Instead, speak just enough of
// the MCP stdio protocol (newline-delimited JSON-RPC 2.0) to complete the
// handshake and expose zero tools — a valid, empty, inert server. No bundle
// fetch, no RedDB, no hooks, no tools: the only thing this does is not
// fake-fail the handshake. Exported for tests.
export function startInertMcpServer({ name, version } = {}) {
  const serverInfo = { name: name || "inert", version: version || "0.0.0" };
  let buffer = "";
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const handle = (msg) => {
    if (!msg || typeof msg !== "object") return;
    // A request carries an id; a notification (e.g. notifications/initialized)
    // does not — ignore notifications. (id may legitimately be 0.)
    if (msg.id === undefined || msg.id === null) return;
    const { id, method, params } = msg;
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo,
        },
      });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: [] } });
      return;
    }
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed frames */
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

function delegate(runtime, argv) {
  return new Promise((resolve) => {
    const target = argv[0] === "mcp" || argv[0] === "memory-mcp" ? runtime.mcpPath : runtime.cliPath;
    const targetArgv = target === runtime.mcpPath ? argv.slice(1) : argv;
    const child = spawn(process.execPath, [target, ...targetArgv], {
      stdio: "inherit",
      env: { ...process.env, REDDB_BIN: runtime.redPath },
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  // Gate FIRST (ADR 0067): if memory is not explicitly enabled in this
  // directory, stay fully inert — no version resolution, no runtime fetch, no
  // delegate — and honour the hooks' no-op contract (`{}` on stdout, exit 0).
  if (!isPluginEnabled(process.cwd(), "memory")) {
    // The mcp stdio path must complete the handshake (empty server) rather than
    // exit, or the host reports `✘ Failed to connect` (issue #843). cli/hook
    // paths keep the silent no-op exit.
    if (argv[0] === "mcp" || argv[0] === "memory-mcp") {
      startInertMcpServer({ name: "red-memory", version: await pluginVersion() });
      return;
    }
    process.stdout.write("{}");
    process.exit(0);
  }
  let version = null;
  try {
    version = await pluginVersion();
    if (!version) throw new Error("could not resolve plugin version");
    const runtime = await ensureRuntime(version, { mayFetch: mayFetchRuntime(argv) });
    if (!runtime) {
      // Render/hot-path hook on a cold cache: SessionStart will warm it. No-op.
      process.stdout.write("{}");
      process.exit(0);
    }
    // The runtime resolved: any earlier degrade is stale.
    await clearDegradeMarker();
    const code = await delegate(runtime, argv);
    process.exit(code);
  } catch (err) {
    // Preserve the hooks' no-op contract; leave a machine-readable marker the
    // doctor can report, and make the failure diagnosable in the log.
    await logLine(`${err?.message ?? err} (args: ${argv.join(" ")})`);
    await writeDegradeMarker(version, err, argv);
    process.stdout.write("{}");
    process.exit(0);
  }
}

// Only run when invoked directly (tests import the pure helpers).
if (process.argv[1] && process.argv[1].endsWith("bootstrap.mjs")) {
  main();
}
