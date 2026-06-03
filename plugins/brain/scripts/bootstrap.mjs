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
 * A repo checkout (where `src/apps/brain/dist-bundle/*` or the TS source exists)
 * falls back to the local artifacts when the release fetch fails, so the plugin
 * stays runnable in this repo before its first release.
 *
 * Uses only `node:` builtins because it runs before any dependency exists. On any
 * failure it prints `{}` on stdout (the no-op the hooks expect) and logs an
 * actionable line — never silent. See ADR 0029/0038.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, appendFile } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RED_SKILLS_REPO = "reddb-io/red-skills";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "..", "..");

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

/** GitHub release asset URL. */
export function assetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

function normalizeRedAsset(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.asset !== "string") return null;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.sha256)) return null;
  return { asset: value.asset, sha256: value.sha256.toLowerCase() };
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
 * Ensure {brain-cli.mjs, brain-mcp.mjs, red} exist for `version` in the
 * version-keyed cache and return their absolute paths. Throws (caught by the
 * caller, which falls back to local artifacts) on any fetch failure.
 */
async function ensureRuntime(version) {
  const dir = join(runtimeRoot(), version);
  const cliPath = join(dir, "brain-cli.mjs");
  const mcpPath = join(dir, "brain-mcp.mjs");
  const redPath = join(dir, process.platform === "win32" ? "red.exe" : "red");

  const tag = `v${version}`;
  const manifest = JSON.parse(
    (
      await fetchBuffer(assetUrl(RED_SKILLS_REPO, tag, "brain-runtime-manifest.json"))
    ).toString("utf8"),
  );

  await ensureFile(
    assetUrl(RED_SKILLS_REPO, tag, manifest.cli.asset),
    cliPath,
    manifest.cli.sha256,
  );
  if (manifest.mcp) {
    await ensureFile(
      assetUrl(RED_SKILLS_REPO, tag, manifest.mcp.asset),
      mcpPath,
      manifest.mcp.sha256,
    );
  }

  // Native `red` binary (per-platform), reused from reddb-io/reddb releases.
  const key = platformKey();
  const redAsset = key && normalizeRedAsset(manifest.reddb?.assets?.[key]);
  if (!redAsset) throw new Error(`no red binary for platform ${key ?? "unknown"}`);
  await ensureFile(
    assetUrl(manifest.reddb.repo, manifest.reddb.tag, redAsset.asset),
    redPath,
    redAsset.sha256,
    { mode: 0o755 },
  );

  return { cliPath, mcpPath, redPath };
}

/** Local repo-checkout fallback: built dist-bundle, else run the TS source via
 * tsx. Returns a spawn spec; `null` when nothing local is runnable. */
function localCandidate(kind) {
  const file = kind === "mcp" ? "brain-mcp.mjs" : "brain-cli.mjs";
  const source = kind === "mcp" ? "src/mcp-server.ts" : "src/cli.ts";
  const candidates = [
    { command: process.execPath, args: [join(REPO_ROOT, "src/apps/brain/dist-bundle", file)] },
    { command: process.execPath, args: ["--import", "tsx", join(REPO_ROOT, "src/apps/brain", source)] },
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

async function main() {
  const argv = process.argv.slice(2);
  const kind = argv[0] === "mcp" || argv[0] === "brain-mcp" ? "mcp" : "cli";
  const extra = kind === "mcp" ? argv.slice(1) : argv;

  // 1. Primary: fetch the release-published runtime into the version-keyed cache.
  try {
    const version = await pluginVersion();
    if (!version) throw new Error("could not resolve plugin version");
    const rt = await ensureRuntime(version);
    const target = kind === "mcp" ? rt.mcpPath : rt.cliPath;
    const code = await run(process.execPath, [target, ...extra], {
      ...process.env,
      REDDB_BIN: rt.redPath,
    });
    process.exit(code);
  } catch (err) {
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

  await logLine("no runnable runtime: release fetch failed and no local bundle/source found");
  process.stdout.write("{}");
  process.exit(0);
}

// Only run when invoked directly (tests may import the pure helpers).
if (process.argv[1] && process.argv[1].endsWith("bootstrap.mjs")) {
  main();
}
