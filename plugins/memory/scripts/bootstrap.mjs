#!/usr/bin/env node
/**
 * bootstrap.mjs — dependency-free runtime resolver for the Memory plugin.
 *
 * The plugin ships as a marketplace git checkout into the cache; Claude Code /
 * Codex never run a build or install, so the compiled CLI and its 137 MB of
 * deps cannot live in the checkout. Instead the release publishes a single
 * esbuild bundle (`memory-cli.mjs`, all JS deps inlined) plus a runtime
 * manifest, and the native `red` engine binary is reused from reddb-io/reddb's
 * own releases. This script — invoked by every lifecycle hook in place of the
 * old `dist/cli.js` — fetches those artifacts once per plugin version into a
 * version-keyed cache that survives `autoUpdate`, then delegates the hook call.
 *
 * It uses only `node:` builtins because it runs before any dependency exists.
 * See ADR 0029.
 *
 * Contract preserved from the old hook: on any failure it prints `{}` on stdout
 * (the no-op the hooks expect) and logs an actionable line — never silent.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, appendFile } from "node:fs/promises";
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

/** GitHub release asset URL. */
export function assetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

/** Parse the first hex token out of a `*.sha256` file body (`<hex>  <name>`). */
export function parseSha256File(body) {
  const m = String(body).trim().match(/^[0-9a-f]{64}/i);
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
 * Ensure {cli.mjs, red} exist for `version` in the version-keyed cache and
 * return their absolute paths. Throws (caught by main) on any fetch failure.
 */
async function ensureRuntime(version) {
  const dir = join(runtimeRoot(), version);
  const cliPath = join(dir, "memory-cli.mjs");
  const redPath = join(dir, process.platform === "win32" ? "red.exe" : "red");

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

  // 3. native `red` binary (per-platform), reused from reddb-io/reddb releases.
  const key = platformKey();
  const redAsset = key && manifest.reddb?.assets?.[key];
  if (!redAsset) {
    throw new Error(`no red binary for platform ${key ?? "unknown"}`);
  }
  const redSha = parseSha256File(
    (
      await fetchBuffer(
        assetUrl(manifest.reddb.repo, manifest.reddb.tag, `${redAsset}.sha256`),
      )
    ).toString("utf8"),
  );
  await ensureFile(
    assetUrl(manifest.reddb.repo, manifest.reddb.tag, redAsset),
    redPath,
    redSha,
    { mode: 0o755 },
  );

  return { cliPath, redPath };
}

function delegate(cliPath, redPath, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      stdio: "inherit",
      env: { ...process.env, REDDB_BIN: redPath },
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    const version = await pluginVersion();
    if (!version) throw new Error("could not resolve plugin version");
    const { cliPath, redPath } = await ensureRuntime(version);
    const code = await delegate(cliPath, redPath, argv);
    process.exit(code);
  } catch (err) {
    // Preserve the hooks' no-op contract; make the failure diagnosable.
    await logLine(`${err?.message ?? err} (args: ${argv.join(" ")})`);
    process.stdout.write("{}");
    process.exit(0);
  }
}

// Only run when invoked directly (tests import the pure helpers).
if (process.argv[1] && process.argv[1].endsWith("bootstrap.mjs")) {
  main();
}
