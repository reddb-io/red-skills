#!/usr/bin/env node
/**
 * afk.mjs — committed launcher bootstrap for the AFK runtime. NOT the implementation.
 *
 * The dev runtime ships as a single esbuild bundle (`dev.bundle.min.mjs`) attached
 * to each GitHub Release as an asset (ADR 0034), NOT committed to git. This file is
 * the small, dependency-free entrypoint the SKILL.md and statusline hooks invoke
 * (`node bin/afk.mjs <cmd>`). It resolves the runtime bundle and delegates to it.
 *
 * Resolution order:
 *   1. version-keyed cache — `<cacheRoot>/dev-<version>.bundle.min.mjs`
 *      (populated by red-fetch on SessionStart; mirrors bundle-fetch.ts)
 *   2. repo-root `dist/dev.bundle.min.mjs` (local dev: `pnpm -C src/apps/dev bundle`)
 *   3. cold cache → trigger `red-fetch dev <version>` once (best-effort), re-check
 *
 * Only `node:` built-ins — ships verbatim in the plugin cache, runs with no install.
 * See bin/README.md and ADR 0038.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` to the plugin root holding `.claude-plugin/plugin.json`. */
function findPluginRoot(start) {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const pluginRoot = findPluginRoot(here);
let version = "";
if (pluginRoot) {
  try {
    version =
      JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version ||
      "";
  } catch {
    /* fall through to dist fallback */
  }
}

/** Bundle cache root — must match fetch-cli.ts (`cacheRoot`). */
function cacheRoot() {
  if (process.env.RED_SKILLS_CACHE_DIR) return process.env.RED_SKILLS_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "red-skills", "bundles");
  return join(homedir(), ".cache", "red-skills", "bundles");
}

/** version-keyed cache path — must match bundle-fetch.ts (`bundleFileName`). */
function cachedBundle() {
  if (!version) return null;
  const p = join(cacheRoot(), `dev-${version}.bundle.min.mjs`);
  return existsSync(p) ? p : null;
}

/** Repo-root `dist/dev.bundle.min.mjs` fallback for local development. */
function distBundle() {
  let dir = here;
  for (let i = 0; i < 16; i++) {
    const p = join(dir, "dist", "dev.bundle.min.mjs");
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Cold cache: run the committed red-fetch once (best-effort, exits 0 on failure). */
function tryFetch() {
  if (!pluginRoot || !version) return;
  const fetcher = [
    join(pluginRoot, "hooks", "red-fetch.mjs"),
    join(pluginRoot, "dist", "red-fetch.mjs"),
  ].find(existsSync);
  if (!fetcher) return;
  spawnSync(process.execPath, [fetcher, "dev", version], { stdio: "ignore" });
}

let bundle = cachedBundle() || distBundle();
if (!bundle) {
  tryFetch();
  bundle = cachedBundle() || distBundle();
}

if (!bundle) {
  process.stderr.write(
    `afk: could not resolve the dev runtime bundle (dev-${version || "?"}.bundle.min.mjs).\n` +
      `  Looked in cache ${cacheRoot()} and repo-root dist/.\n` +
      `  The bundle ships as a GitHub Release asset (ADR 0034) fetched by red-fetch;\n` +
      `  ensure network access on first run, or build it locally:\n` +
      `    pnpm -C src/apps/dev run bundle\n`,
  );
  process.exit(1);
}

// Delegate to the resolved bundle as a subprocess (argv[1] = bundle, so its
// `import.meta.url === file://process.argv[1]` self-exec guard fires). Inherit
// stdio; forward the child's exit code and terminating signal.
const res = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.signal) {
  process.kill(process.pid, res.signal);
} else {
  process.exit(res.status ?? 1);
}
