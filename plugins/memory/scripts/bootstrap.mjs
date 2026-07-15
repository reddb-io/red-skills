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
import { mkdir, readFile, rename, writeFile, chmod, appendFile, unlink } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RED_SKILLS_REPO = "reddb-io/red-skills";
const PLUGIN = "memory";
const RUNTIME_MANIFEST = "memory-runtime-manifest.json";
const CLI_ASSET = "memory-cli.mjs";

// ADR 0091: the npm registry is the source of truth for version *discovery*
// (which same-major version is newest). The memory runtime itself keeps shipping
// as pinned GitHub-release assets because it carries a per-platform native `red`
// binary that cannot live in a platform-independent npm tarball — that runtime
// distribution is deliberately NOT redesigned here. What ADR 0091 removes is the
// broken hand-rolled sigstore manifest verification and the phantom
// `releases/download/v1/` self-update channel that 404'd on every boot.
const NPM_PACKAGE = "@reddb-io/red-skills";
const NPM_REGISTRY_BASE = process.env.RED_NPM_REGISTRY_BASE || "https://registry.npmjs.org";

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

async function fetchRuntimeManifest(tag) {
  const raw = await fetchBuffer(assetUrl(RED_SKILLS_REPO, tag, RUNTIME_MANIFEST));
  return JSON.parse(raw.toString("utf8"));
}

async function fetchCheckedAsset(url, expectedSha) {
  const buf = await fetchBuffer(url);
  const got = sha256Hex(buf);
  if (got !== String(expectedSha).toLowerCase()) {
    throw new Error(`checksum mismatch for ${url}: ${got} != ${expectedSha}`);
  }
  return buf;
}

async function writeRuntimeFile(dest, bytes, { mode } = {}) {
  if (existsSync(dest)) {
    const have = sha256Hex(await readFile(dest));
    if (have === sha256Hex(bytes)) {
      if (mode) await chmod(dest, mode);
      return;
    }
    await logLine(`checksum drift at ${dest}, refetching`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  if (mode) await chmod(dest, mode);
}

async function assertRuntimeCacheMatches(version, manifest) {
  const dir = join(runtimeRoot(), version);
  const checks = [
    { path: join(dir, "memory-cli.mjs"), sha256: manifest.cli?.sha256, label: "memory cli" },
  ];
  if (manifest.mcp) {
    checks.push({ path: join(dir, "memory-mcp.mjs"), sha256: manifest.mcp.sha256, label: "memory mcp" });
  }
  const key = platformKey();
  const redAsset = key && normalizeRedAsset(manifest.reddb?.assets?.[key]);
  if (!redAsset) throw new Error(`no red binary for platform ${key ?? "unknown"}`);
  checks.push({
    path: join(dir, process.platform === "win32" ? "red.exe" : "red"),
    sha256: redAsset.sha256,
    label: "red binary",
  });
  for (const check of checks) {
    if (!check.sha256) throw new Error(`missing checksum for ${check.label}`);
    const got = sha256Hex(await readFile(check.path));
    if (got !== String(check.sha256).toLowerCase()) {
      throw new Error(`cached ${check.label} checksum mismatch: ${got} != ${check.sha256}`);
    }
  }
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

  // 1. manifest — names + checksums for this exact plugin version. Integrity
  // comes from the per-asset sha256 in the manifest (and reddb's own `.sha256`
  // for the native binary); ADR 0091 removed the broken sigstore layer.
  const tag = `v${version}`;
  const manifest = await fetchRuntimeManifest(tag);

  // 2. Download + checksum-verify every runtime asset before adopting anything.
  const cliBytes = await fetchCheckedAsset(
    assetUrl(RED_SKILLS_REPO, tag, manifest.cli.asset),
    manifest.cli.sha256,
  );

  let mcpBytes = null;
  if (manifest.mcp) {
    mcpBytes = await fetchCheckedAsset(
      assetUrl(RED_SKILLS_REPO, tag, manifest.mcp.asset),
      manifest.mcp.sha256,
    );
  }

  const key = platformKey();
  const redAsset = key && normalizeRedAsset(manifest.reddb?.assets?.[key]);
  if (!redAsset) {
    throw new Error(`no red binary for platform ${key ?? "unknown"}`);
  }
  const redBytes = await fetchCheckedAsset(
    assetUrl(manifest.reddb.repo, manifest.reddb.tag, redAsset.asset),
    redAsset.sha256,
  );

  // 3. Every asset has passed its manifest checksum — adopt the runtime.
  await writeRuntimeFile(cliPath, cliBytes);
  if (mcpBytes) await writeRuntimeFile(mcpPath, mcpBytes);
  await writeRuntimeFile(
    redPath,
    redBytes,
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

// ── In-range self-update (ADR 0084) ──────────────────────────────────────────
// Mirror of packages/shared/self-update.ts, inlined because the launcher ships
// dependency-free in the plugin checkout. Keep the copies in lockstep. On an
// enabled session start the launcher spawns a DETACHED background check for a
// newer in-range (same-major) runtime and atomically swaps a pointer so the NEXT
// session serves it; the current session and out-of-range majors are untouched,
// and resolution (resolveActiveVersion) is a LOCAL read that can never fetch.

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}
export function sameMajor(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  return !!pa && !!pb && pa.major === pb.major;
}
/** Newest in-range candidate strictly newer than `current`, else null. */
export function selectInRangeUpdate(installed, current, candidate) {
  if (!candidate || !sameMajor(installed, candidate)) return null;
  if (compareSemver(candidate, current) <= 0) return null;
  return candidate;
}
/** npm registry metadata URL for the package (scoped name is `%2F`-escaped). */
export function registryPackageUrl(pkg = NPM_PACKAGE) {
  return `${NPM_REGISTRY_BASE}/${pkg.replace("/", "%2F")}`;
}
/** Newest published SAME-major version from registry metadata JSON, else null. */
export function newestSameMajorFromRegistry(metadataText, installed) {
  let parsed;
  try {
    parsed = JSON.parse(metadataText);
  } catch {
    return null;
  }
  const versions = parsed && typeof parsed.versions === "object" ? Object.keys(parsed.versions) : [];
  const pi = parseSemver(installed);
  if (!pi) return null;
  let best = null;
  for (const v of versions) {
    const pv = parseSemver(v);
    if (!pv || pv.major !== pi.major) continue;
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}
export function pointerFileName(plugin) {
  return `${plugin}-stable.current`;
}
export function readPointerVersion(text) {
  const t = String(text).trim();
  try {
    const o = JSON.parse(t);
    if (o && typeof o.version === "string") return o.version.trim();
  } catch {
    /* fall through to a bare-version tolerance */
  }
  return /^\d+\.\d+\.\d+/.test(t) ? t : "";
}

function pointerPath() {
  return join(runtimeRoot(), pointerFileName(PLUGIN));
}

/**
 * The runtime version to serve right now, using only LOCAL reads (no network).
 * Honours the self-update pointer only when it is a real in-range, non-downgrade
 * version whose runtime is actually present; otherwise the installed version.
 */
async function resolveActiveVersion(installed) {
  if (!parseSemver(installed)) return installed;
  const ptr = pointerPath();
  if (!existsSync(ptr)) return installed;
  let pointed;
  try {
    pointed = readPointerVersion(await readFile(ptr, "utf8"));
  } catch {
    return installed;
  }
  if (!pointed || !sameMajor(installed, pointed) || compareSemver(pointed, installed) < 0) {
    return installed;
  }
  return existsSync(join(runtimeRoot(), pointed, CLI_ASSET)) ? pointed : installed;
}

/**
 * Best-effort background in-range self-update. Never throws: any failure leaves
 * the cache/pointer untouched so the cached runtime keeps serving and the check
 * retries on a later boot. Runs only in the detached `__self-update` child.
 */
async function backgroundSelfUpdate(installed) {
  if (!parseSemver(installed)) return;
  try {
    const current = await resolveActiveVersion(installed);
    // ADR 0091: discover the newest same-major version from the npm registry
    // (the phantom `releases/download/v1/` channel is gone). The runtime itself
    // still comes from that version's pinned GitHub release.
    const metadataText = (await fetchBuffer(registryPackageUrl())).toString("utf8");
    const candidate = newestSameMajorFromRegistry(metadataText, installed);
    const target = selectInRangeUpdate(installed, current, candidate);
    if (!target) return;
    const targetManifest = await fetchRuntimeManifest(`v${target}`);
    await ensureRuntime(target, { mayFetch: true }); // fetch + checksum-verify the target runtime
    await assertRuntimeCacheMatches(target, targetManifest);
    const ptr = pointerPath();
    const tmp = `${ptr}.${target}.tmp`;
    await mkdir(dirname(ptr), { recursive: true });
    await writeFile(tmp, JSON.stringify({ version: target }));
    await rename(tmp, ptr); // atomic swap: pointer flips last, all-or-nothing
    await logLine(`self-update: swapped to ${target} for next boot`);
  } catch (err) {
    await logLine(`self-update check failed (${err?.message ?? err}); cached runtime keeps serving`);
  }
}

/** Fire-and-forget the detached background self-update; never blocks the caller. */
function spawnBackgroundSelfUpdate() {
  try {
    const self = process.argv[1];
    if (!self) return;
    const child = spawn(process.execPath, [self, "__self-update"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

function hasPendingToonMigration(cwd) {
  return (
    existsSync(join(cwd, ".red", "memory", "config.json")) &&
    !existsSync(join(cwd, ".red", "memory", "config.toon"))
  );
}

function resolveDevEntrypoint() {
  const override = process.env.RED_DEV_ENTRYPOINT;
  if (override && existsSync(override)) return override;
  const candidates = [
    join(REPO_ROOT, "plugins", "dev", "skills", "engineering", "afk", "bin", "afk.mjs"),
    resolve(PLUGIN_ROOT, "..", "dev", "skills", "engineering", "afk", "bin", "afk.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Fire-and-forget the plugin-owned TOON migration trigger; never blocks hooks. */
function spawnBackgroundToonMigration(cwd) {
  try {
    if (!hasPendingToonMigration(cwd)) return;
    const entrypoint = resolveDevEntrypoint();
    if (!entrypoint) return;
    const child = spawn(
      process.execPath,
      [entrypoint, "toon-migrate", "--plugin", "memory", "--root", cwd, "--triggered-by", "bootstrap"],
      {
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    child.unref();
  } catch {
    /* best-effort */
  }
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
  // Detached in-range self-update worker (ADR 0084): resolve version + gate, run
  // the background check, exit 0. Handled before anything else so it never runs
  // a delegate or the MCP server.
  if (argv[0] === "__self-update") {
    if (isPluginEnabled(process.cwd(), "memory")) {
      await backgroundSelfUpdate(await pluginVersion());
    }
    process.exit(0);
  }
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
    const installed = await pluginVersion();
    if (!installed) throw new Error("could not resolve plugin version");
    // Serve the in-range version a prior background update swapped in (ADR 0084);
    // LOCAL read only — never fetches, so no render/hook path blocks on network.
    version = await resolveActiveVersion(installed);
    // On session start, kick a DETACHED background in-range self-update for the
    // NEXT boot. Detached + unref'd so it never delays the hook or any surface.
    if (argv[0] === "hook" && argv[1] === "SessionStart") spawnBackgroundSelfUpdate();
    if (argv[0] === "hook" && argv[1] === "SessionStart") spawnBackgroundToonMigration(process.cwd());
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
