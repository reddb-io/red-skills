#!/usr/bin/env node
/**
 * bootstrap.mjs — dependency-free runtime resolver for the Brain plugin.
 *
 * Mirrors the Memory plugin's resolver (ADR 0029): the plugin ships as a
 * marketplace git checkout into the cache; Claude Code / Codex never run a build
 * or install, so the compiled CLI/MCP and their deps cannot live in the checkout.
 * The release publishes two esbuild bundles (`brain-cli.mjs`, `brain-mcp.mjs`,
 * all JS deps inlined) plus a runtime manifest, and the native `red` engine
 * binary is pinned by that manifest and reused from reddb-io/reddb's own
 * releases. This script — invoked by the MCP launcher and lifecycle hooks in
 * place of built output — fetches those artifacts once per plugin version into a
 * version-keyed cache that survives `autoUpdate`, then delegates the call.
 *
 * A repo checkout (where `apps/brain/dist-bundle/*` or the TS source exists)
 * falls back to the local artifacts when the release fetch fails, so the plugin
 * stays runnable in this repo before its first release.
 *
 * Uses only `node:` builtins because it runs before any dependency exists. On any
 * failure it prints `{}` on stdout (the no-op the hooks expect) and logs an
 * actionable line — never silent. See ADR 0029/0038.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod, appendFile, unlink } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RED_SKILLS_REPO = "reddb-io/red-skills";
const PLUGIN = "brain";
const RUNTIME_MANIFEST = "brain-runtime-manifest.json";
const CLI_ASSET = "brain-cli.mjs";

// ADR 0091: the npm registry is the source of truth for version *discovery*.
// The brain runtime keeps shipping as pinned GitHub-release assets (it carries a
// per-platform native `red` binary that cannot live in a platform-independent
// npm tarball) — that runtime distribution is deliberately NOT redesigned here.
// ADR 0091 removes the broken hand-rolled sigstore manifest verification and the
// phantom `releases/download/v1/` self-update channel that 404'd on every boot.
const NPM_PACKAGE = "@reddb-io/red-skills";
const NPM_REGISTRY_BASE = process.env.RED_NPM_REGISTRY_BASE || "https://registry.npmjs.org";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
// The dev / pre-release local-fallback root. Derived from this launcher's own
// location by default; overridable (RED_BRAIN_REPO_ROOT) so the launcher tests
// can point it at an empty dir and simulate an installed copy with no checkout.
const REPO_ROOT = process.env.RED_BRAIN_REPO_ROOT || resolve(PLUGIN_ROOT, "..", "..");

// ---------------------------------------------------------------------------
// Pure helpers
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
 * Release host. Overridable via RED_BRAIN_RELEASE_BASE so the launcher tests
 * can point every asset URL at a local server — no real network, ever.
 */
const RELEASE_HOST = process.env.RED_BRAIN_RELEASE_BASE || "https://github.com";

/** GitHub release asset URL. */
export function assetUrl(repo, tag, name) {
  return `${RELEASE_HOST}/${repo}/releases/download/${tag}/${name}`;
}

/**
 * Which invocations may hit the network on a cache miss. Only the resolve/warm
 * points do: the once-per-session SessionStart hook, the long-lived mcp server,
 * and user-invoked CLI commands. Recurring render/hot-path hooks (PostToolUse /
 * Stop / PreCompact) must never block on a synchronous fetch (ADR 0084, the
 * statusline-blanking lesson). On a cold cache they no-op and let SessionStart
 * warm the cache.
 */
export function mayFetchRuntime(argv) {
  if (argv[0] === "hook") return argv[1] === "SessionStart";
  return true;
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

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function runtimeRoot() {
  const base =
    process.env.RED_BRAIN_CACHE_DIR ||
    process.env.XDG_CACHE_HOME ||
    join(homedir(), ".cache");
  return join(base, "reddb-brain");
}

async function pluginVersion() {
  const root =
    process.env.CLAUDE_PLUGIN_ROOT || process.env.CODEX_PLUGIN_ROOT || PLUGIN_ROOT;
  try {
    const pj = JSON.parse(
      await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
    return pj.version;
  } catch {
    return null;
  }
}

async function logLine(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await appendFile(join(runtimeRoot(), "bootstrap.log"), line).catch(() => {});
    process.stderr.write(`brain bootstrap: ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
}

/** Machine-readable degrade marker path — a `brain doctor` can later read this. */
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
          schema: "red.brain.runtime-degraded.v1",
          plugin: "brain",
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
    { path: join(dir, "brain-cli.mjs"), sha256: manifest.cli?.sha256, label: "brain cli" },
  ];
  if (manifest.mcp) {
    checks.push({ path: join(dir, "brain-mcp.mjs"), sha256: manifest.mcp.sha256, label: "brain mcp" });
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
 * Ensure {brain-cli.mjs, brain-mcp.mjs, red} exist for `version` in the
 * version-keyed cache and return their absolute paths. Returns null when a cold
 * cache is hit on a render/hot path (`mayFetch` false) so the caller can honour
 * the hook no-op contract. Throws (caught by the caller, which falls back to
 * local artifacts) on any fetch failure.
 */
async function ensureRuntime(version, { mayFetch } = {}) {
  const dir = join(runtimeRoot(), version);
  const cliPath = join(dir, "brain-cli.mjs");
  const mcpPath = join(dir, "brain-mcp.mjs");
  const redPath = join(dir, process.platform === "win32" ? "red.exe" : "red");

  // Fast path: a complete version-keyed cache is immutable — each asset was
  // sha256-verified before it was written (ensureFile), and a published release
  // version never changes its assets. So when all three already exist, trust them
  // and skip the network entirely. Without this, every SessionStart re-fetched
  // the runtime manifest and re-validated (re-downloading the ~24 MB `red`
  // binary), making session start take ~17 s instead of being instant.
  if (existsSync(cliPath) && existsSync(mcpPath) && existsSync(redPath)) {
    return { cliPath, mcpPath, redPath };
  }

  // Cold cache on a render/hot path (recurring PostToolUse / Stop / PreCompact
  // hooks): never fetch. Defer to the SessionStart resolve point and no-op this
  // call. `null` tells the caller to honour the hook no-op contract.
  if (!mayFetch) return null;

  const tag = `v${version}`;
  const manifest = await fetchRuntimeManifest(tag);

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

  // Native `red` binary (per-platform), reused from reddb-io/reddb releases.
  const key = platformKey();
  const redAsset = key && normalizeRedAsset(manifest.reddb?.assets?.[key]);
  if (!redAsset) throw new Error(`no red binary for platform ${key ?? "unknown"}`);
  const redBytes = await fetchCheckedAsset(
    assetUrl(manifest.reddb.repo, manifest.reddb.tag, redAsset.asset),
    redAsset.sha256,
  );

  // Every asset has passed its manifest checksum — adopt the runtime.
  await writeRuntimeFile(cliPath, cliBytes);
  if (mcpBytes) await writeRuntimeFile(mcpPath, mcpBytes);
  await writeRuntimeFile(
    redPath,
    redBytes,
    { mode: 0o755 },
  );

  return { cliPath, mcpPath, redPath };
}

/** Local repo-checkout fallback: built ./dist bundle, else run the TS source via
 * tsx. Returns a spawn spec; `null` when nothing local is runnable. */
function localCandidate(kind) {
  const file = kind === "mcp" ? "brain-mcp.bundle.min.mjs" : "brain.bundle.min.mjs";
  const source = kind === "mcp" ? "src/mcp-server.ts" : "src/cli.ts";
  const candidates = [
    { command: process.execPath, args: [join(REPO_ROOT, "dist", file)] },
    { command: process.execPath, args: ["--import", "tsx", join(REPO_ROOT, "apps/brain", source)] },
  ];
  for (const c of candidates) {
    if (existsSync(c.args[c.args.length - 1])) return c;
  }
  return null;
}

function localRedBin() {
  const bin = join(
    REPO_ROOT,
    "node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/bin",
    process.platform === "win32" ? "red.exe" : "red",
  );
  return existsSync(bin) ? bin : null;
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
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

async function main() {
  const argv = process.argv.slice(2);
  // Detached in-range self-update worker (ADR 0084): resolve version + gate, run
  // the background check, exit 0. Handled before anything else so it never runs
  // a delegate or the MCP server.
  if (argv[0] === "__self-update") {
    if (isPluginEnabled(process.cwd(), "brain")) {
      await backgroundSelfUpdate(await pluginVersion());
    }
    process.exit(0);
  }
  // Gate FIRST (ADR 0067): if brain is not explicitly enabled in this directory,
  // stay fully inert — no fetch, no local fallback — and honour the hooks' no-op
  // contract (`{}` on stdout, exit 0).
  if (!isPluginEnabled(process.cwd(), "brain")) {
    // The mcp stdio path must complete the handshake (empty server) rather than
    // exit, or the host reports `✘ Failed to connect` (issue #843). cli/hook
    // paths keep the silent no-op exit.
    if (argv[0] === "mcp" || argv[0] === "brain-mcp") {
      startInertMcpServer({ name: "red-brain", version: await pluginVersion() });
      return;
    }
    process.stdout.write("{}");
    process.exit(0);
  }
  const kind = argv[0] === "mcp" || argv[0] === "brain-mcp" ? "mcp" : "cli";
  const extra = kind === "mcp" ? argv.slice(1) : argv;

  // 1. Primary: fetch the release-published runtime into the version-keyed cache.
  let version = null;
  let fetchErr = null;
  try {
    const installed = await pluginVersion();
    if (!installed) throw new Error("could not resolve plugin version");
    // Serve the in-range version a prior background update swapped in (ADR 0084);
    // LOCAL read only — never fetches, so no render/hook path blocks on network.
    version = await resolveActiveVersion(installed);
    // On session start, kick a DETACHED background in-range self-update for the
    // NEXT boot. Detached + unref'd so it never delays the hook or any surface.
    if (argv[0] === "hook" && argv[1] === "SessionStart") spawnBackgroundSelfUpdate();
    const rt = await ensureRuntime(version, { mayFetch: mayFetchRuntime(argv) });
    if (!rt) {
      // Render/hot-path hook on a cold cache: SessionStart will warm it. No-op.
      process.stdout.write("{}");
      process.exit(0);
    }
    // The runtime resolved: any earlier degrade is stale.
    await clearDegradeMarker();
    const target = kind === "mcp" ? rt.mcpPath : rt.cliPath;
    const code = await run(process.execPath, [target, ...extra], {
      ...process.env,
      REDDB_BIN: rt.redPath,
    });
    process.exit(code);
  } catch (err) {
    fetchErr = err;
    await logLine(`release fetch failed (${err?.message ?? err}); trying local checkout`);
  }

  // 2. Fallback: a repo checkout's built bundle or TS source (pre-release / dev).
  const local = localCandidate(kind);
  if (local) {
    const env = { ...process.env };
    if (!env.REDDB_BIN) {
      const red = localRedBin();
      if (red) env.REDDB_BIN = red;
    }
    const code = await run(local.command, [...local.args, ...extra], env);
    process.exit(code);
  }

  // 3. No runtime at all (installed copy, first fetch offline): honour the hook
  // no-op contract and leave a machine-readable marker the doctor can report.
  await writeDegradeMarker(version, fetchErr, argv);
  await logLine("no runnable runtime: release fetch failed and no local bundle/source found");
  process.stdout.write("{}");
  process.exit(0);
}

// Only run when invoked directly (tests may import the pure helpers).
if (process.argv[1] && process.argv[1].endsWith("bootstrap.mjs")) {
  main();
}
