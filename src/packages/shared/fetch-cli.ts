#!/usr/bin/env node
/**
 * fetch-cli.ts — the real-IO launcher behind the SessionStart hook.
 *
 * Bundled (esbuild) to repo-root `dist/red-fetch.mjs` and invoked as:
 *
 *     node dist/red-fetch.mjs <plugin> <version> [--repo owner/name] [--cache-dir DIR]
 *
 * It wires {@link ensureBundle} (pure logic in bundle-fetch.ts) to node
 * built-ins — `fetch`, `node:fs`, `node:crypto` — to resolve a plugin's built
 * bundle for the installed version, fetching it from the GitHub Release into a
 * version-keyed local cache when it is not already present and verified.
 *
 * Best-effort by design: a SessionStart hook must NEVER block session start, so
 * every failure (offline, 404, checksum mismatch) is caught, logged to the cache
 * dir's `red-fetch.log`, and the process exits 0. A committed bundle fallback may
 * be retained per plugin during the ADR-0034 migration; this launcher only
 * *populates* the cache and reports the resolved path on success.
 *
 * Cache location (first that is set):
 *   $RED_SKILLS_CACHE_DIR  ->  <dir>
 *   $XDG_CACHE_HOME        ->  <dir>/red-skills/bundles
 *   default                ->  ~/.cache/red-skills/bundles
 *
 * No runtime deps — only node:* built-ins. See ADR 0034 / ADR 0029.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BundleFetchError,
  type BundleIO,
  ensureBundle,
  resolveBundle,
} from "./bundle-fetch.js";

const DEFAULT_REPO = "reddb-io/red-skills";

function cacheRoot(override?: string): string {
  if (override) return override;
  if (process.env.RED_SKILLS_CACHE_DIR) return process.env.RED_SKILLS_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "red-skills", "bundles");
  }
  return join(homedir(), ".cache", "red-skills", "bundles");
}

const realIO: BundleIO = {
  async download(url) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async readFile(path) {
    return new Uint8Array(await readFile(path));
  },
  async writeFile(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async exists(path) {
    return existsSync(path);
  },
  sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
};

async function logLine(cacheDir: string, msg: string): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await appendFile(
      join(cacheDir, "red-fetch.log"),
      `[${new Date().toISOString()}] ${msg}\n`,
    );
  } catch {
    /* logging must never throw */
  }
  process.stderr.write(`red-fetch: ${msg}\n`);
}

interface Args {
  plugin?: string;
  version?: string;
  repo: string;
  cacheDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { repo: DEFAULT_REPO, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--repo") out.repo = argv[++i] ?? out.repo;
    else if (a === "--cache-dir") out.cacheDir = argv[++i];
    else if (!a.startsWith("-")) positional.push(a);
  }
  out.plugin = positional[0];
  out.version = positional[1];
  return out;
}

const USAGE = `red-fetch — resolve a plugin's built bundle from its GitHub Release into a local cache.

Usage:
  node red-fetch.mjs <plugin> <version> [--repo owner/name] [--cache-dir DIR]

Arguments:
  <plugin>     plugin name (e.g. dev, memory)
  <version>    plugin version without the leading v (e.g. 1.140.0)

Options:
  --repo       GitHub repo publishing the release (default: ${DEFAULT_REPO})
  --cache-dir  override the bundle cache dir
  -h, --help   show this help

Best-effort: never blocks session start. On any failure it logs to
<cache-dir>/red-fetch.log and exits 0.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cacheDir = cacheRoot(args.cacheDir);

  if (args.help || !args.plugin || !args.version) {
    process.stdout.write(`${USAGE}\n`);
    if (!args.help && (!args.plugin || !args.version)) {
      process.stdout.write("\nred-fetch: missing <plugin> and/or <version>; nothing to do.\n");
    }
    process.exit(0);
  }

  const { plugin, version } = args;
  const expected = resolveBundle({ plugin: plugin!, version: version!, cacheDir });
  try {
    const path = await ensureBundle(realIO, {
      plugin: plugin!,
      version: version!,
      repo: args.repo,
      cacheDir,
    });
    process.stdout.write(`red-fetch: bundle ready at ${path}\n`);
  } catch (err) {
    const kind = err instanceof BundleFetchError ? err.kind : "unknown";
    const msg = err instanceof Error ? err.message : String(err);
    await logLine(cacheDir, `${kind}: ${msg} (plugin=${plugin} version=${version})`);
    process.stdout.write(
      `red-fetch: could not fetch ${plugin}@${version} (${kind}); ` +
        `expected cache path ${expected}. Continuing — fetch is best-effort.\n`,
    );
  }
  // Always succeed: a SessionStart hook must not block on a failed fetch.
  process.exit(0);
}

void main();
