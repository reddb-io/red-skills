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
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ensureBundle,
  isCacheableVersion,
  newestPublished,
  NPM_PACKAGE,
  parseRegistryVersions,
  registryPackageUrl,
  type BundleIO,
} from "@reddb-io/shared/bundle-fetch.js";
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
  async rename(from, to) {
    await rename(from, to);
  },
};

/** The plugin name the published bundle is filed under. */
export const REDSKILLED_BUNDLE_PLUGIN = "redskilled";

export interface RedskilledEntryFetchIO {
  /** Injected so the fetch is provable without a registry. */
  readonly bundleIO?: BundleIO;
  /**
   * Which published version to materialise. Absent = resolved by
   * {@link resolveRedskilledFetchVersion}, never carried through as `""`.
   */
  readonly version?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Cache-directory listing, injected so version resolution needs no real fs. */
  readonly listCacheDir?: (path: string) => readonly string[];
}

/** Where bundles are cached, matching the resolver's own candidate root. */
export function redskilledBundleCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RED_SKILLS_CACHE_DIR) return env.RED_SKILLS_CACHE_DIR;
  const xdg = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(xdg, "red-skills", "bundles");
}

/** `<plugin>-<version>.bundle.min.mjs` in the shared cache, for any plugin. */
const CACHED_BUNDLE = /^([a-z0-9-]+)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)\.bundle\.min\.mjs$/;

/**
 * The version this host should materialise, or `null` when it cannot be told.
 *
 * **Absent was spelled `""` and nothing resolved it** (#3153): the empty string
 * travelled all the way to the filename, minted `redskilled-.bundle.min.mjs`,
 * and that entry then satisfied the cache-first test on every later boot. So
 * absent is answered here, and `null` refuses the fetch rather than inventing a
 * key.
 *
 * The cache is asked BEFORE the registry, and deliberately: the daemon bundle
 * has to match the `dev` bundle beside it — they are cut from one npm package —
 * and reading the neighbour needs no network on a host that may have none.
 */
export async function resolveRedskilledFetchVersion(
  io: RedskilledEntryFetchIO,
  cacheDir: string,
): Promise<string | null> {
  if (isCacheableVersion(io.version)) return io.version!.trim();

  const listDir = io.listCacheDir ?? listCacheDirSafe;
  const beside = newestCachedVersion(listDir(cacheDir), "dev");
  if (beside) return beside;

  try {
    const bundleIO = io.bundleIO ?? npmBundleIO;
    const text = await bundleIO.fetchText(registryPackageUrl());
    return newestPublished(parseRegistryVersions(text));
  } catch {
    // Offline, or a registry that refused. Unknown is not a version: the caller
    // keeps the resolver's own account of where it looked.
    return null;
  }
}

/** Newest cached version for `plugin` in a directory listing, or `null`. */
function newestCachedVersion(names: readonly string[], plugin: string): string | null {
  let best: string | null = null;
  for (const name of names) {
    const matched = CACHED_BUNDLE.exec(name);
    if (!matched || matched[1] !== plugin) continue;
    const version = matched[2]!;
    if (best === null || compareVersion(version, best) > 0) best = version;
  }
  return best;
}

function compareVersion(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a)!;
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b)!;
  return Number(pa[1]) - Number(pb[1]) || Number(pa[2]) - Number(pb[2]) || Number(pa[3]) - Number(pb[3]);
}

function listCacheDirSafe(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
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
  const cacheDir = redskilledBundleCacheDir(env);
  const version = await resolveRedskilledFetchVersion(io, cacheDir);
  // No version is no fetch. Materialising under a made-up key is what latched
  // this host shut in the first place (#3153).
  if (version === null) return local;
  try {
    await ensureBundle(io.bundleIO ?? npmBundleIO, {
      plugin: REDSKILLED_BUNDLE_PLUGIN,
      version,
      cacheDir,
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
