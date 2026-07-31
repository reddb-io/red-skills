/**
 * entry-fetch — the rung the daemon entry resolver was missing.
 *
 * `resolveRedskilledEntry` walks local paths and nothing else: a pinned env var,
 * the caller's own entry, a sibling bundle, the bundle cache. Every one of them
 * must already exist. On a host that has never cached a `redskilled` bundle
 * there is therefore nothing to auto-spawn, and rule 7's "a daemon starts on
 * first use" quietly does not hold.
 *
 * **The dead end that made it visible.** `/red-setup` reports the daemon absent
 * and tells the operator to run `redskilled provision` — a binary that only
 * exists after the thing it is supposed to install. The instruction points at
 * its own precondition, so an operator on a fresh machine has no move.
 *
 * The fix is one rung, not a new mechanism: when every local path misses, fetch
 * the published bundle the way the dev launcher already does, then resolve
 * again. `ensureBundle` is cache-first, so a warm host pays nothing and this
 * path is reached only by the host that would otherwise have failed.
 *
 * **Fetching stays the LAST resort.** A local entry always wins — a developer
 * running from a checkout must not have a published bundle silently preferred
 * over the code in front of them.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureBundle, NPM_PACKAGE, type BundleIO } from "@reddb-io/shared/bundle-fetch.js";
import {
  isResolvedRedskilledEntry,
  resolveRedskilledEntry,
  type RedskilledEntryLookup,
  type RedskilledEntryOverride,
  type ResolvedRedskilledEntry,
  type RedskilledEntryResolution,
} from "./daemon-entry.js";

/**
 * The npm-backed IO, built HERE rather than imported from the launcher.
 *
 * `entrypoint-cli` owns an equivalent, but it is a CLI entry: importing it drags
 * a module that runs and exits into the daemon bundle, so the shipped artifact
 * stopped serving. Forty lines of duplication beats a bundle that terminates.
 */
const npmBundleIO: BundleIO = {
  async materialize(spec, stagingDir) {
    await mkdir(stagingDir, { recursive: true });
    const res = spawnSync(
      "npm",
      ["install", spec, "--prefix", stagingDir, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`npm install ${spec} -> ${res.status}: ${(res.stderr || "").trim()}`);
    return join(stagingDir, "node_modules", ...NPM_PACKAGE.split("/"));
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
  async fetchText(url) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return await res.text();
  },
};

/** The plugin name the published bundle is filed under. */
export const REDSKILLED_BUNDLE_PLUGIN = "redskilled";

export interface RedskilledEntryFetchIO {
  /** Injected so the fetch is provable without a registry. */
  readonly bundleIO?: BundleIO;
  /** Which published version to materialise. Absent = the newest stable. */
  readonly version?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Where bundles are cached, matching the resolver's own candidate root. */
export function redskilledBundleCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RED_SKILLS_CACHE_DIR) return env.RED_SKILLS_CACHE_DIR;
  const xdg = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(xdg, "red-skills", "bundles");
}

/**
 * Resolve the daemon entry, fetching the published bundle only if no local path
 * has one. Returns the unresolved resolution when the fetch cannot help, so the
 * caller still raises the same fail-closed error with the same diagnostic.
 */
export async function ensureRedskilledEntry(
  override: RedskilledEntryOverride = {},
  lookup: RedskilledEntryLookup = {},
  io: RedskilledEntryFetchIO = {},
): Promise<RedskilledEntryResolution> {
  const local = resolveRedskilledEntry(override, lookup);
  if (isResolvedRedskilledEntry(local)) return local;

  const env = io.env ?? lookup.env ?? process.env;
  try {
    await ensureBundle(io.bundleIO ?? npmBundleIO, {
      plugin: REDSKILLED_BUNDLE_PLUGIN,
      version: io.version ?? "",
      cacheDir: redskilledBundleCacheDir(env),
    });
  } catch {
    // A fetch that cannot run leaves the original unresolved answer intact: the
    // caller's error already names every path it looked at, which is the more
    // useful diagnostic than "npm failed".
    return local;
  }

  // Re-walk rather than trusting the fetch's return path, so the entry a caller
  // gets is one this resolver would have found on its own next boot.
  return resolveRedskilledEntry(override, lookup);
}

/** Resolve-or-throw, with the fetch rung. The shape the spawn path wants. */
export async function requireRedskilledEntryWithFetch(
  override: RedskilledEntryOverride = {},
  lookup: RedskilledEntryLookup = {},
  io: RedskilledEntryFetchIO = {},
): Promise<ResolvedRedskilledEntry> {
  const resolution = await ensureRedskilledEntry(override, lookup, io);
  if (isResolvedRedskilledEntry(resolution)) return resolution;
  const { RedskilledDaemonEntryError } = await import("./daemon-entry.js");
  throw new RedskilledDaemonEntryError(resolution);
}
