import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { readSelfStateFile } from "./overhead-budget.js";

/**
 * The `gh` ETag cache, partitioned one file per request key.
 *
 * A single cache document made every `gh` call pay for every entry ever
 * cached — 10 MB read, decoded and rewritten per invocation (#2745). One file
 * per key makes a lookup cost one entry, and the byte ceiling below keeps the
 * lane from growing without bound in the first place.
 */

export const GH_ETAG_CACHE_DIR_NAME = "gh-etag";
export const LEGACY_GH_ETAG_CACHE_FILE = "gh-etag-cache.toon";
export const LEGACY_GH_ETAG_CACHE_JSON_FILE = "gh-etag-cache.json";
export const DEFAULT_GH_ETAG_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export interface GhEtagCacheEntry {
  key: string;
  request: string;
  etag: string;
  body: string;
  updated_at: string;
}

export interface GhEtagCacheDocument {
  version: 1;
  entries: Record<string, GhEtagCacheEntry>;
}

export interface GhEtagCacheCeilingResult {
  /** Entries removed to get back under the ceiling. */
  evictedEntries: number;
  /** Bytes the partitioned cache occupies after eviction. */
  bytes: number;
}

export interface GhEtagCacheSweepResult extends GhEtagCacheCeilingResult {
  /** Orphan `.tmp` files reclaimed from the rsp state lane. */
  reclaimedTmp: number;
  /** Entries lifted out of a legacy single-document cache. */
  migratedEntries: number;
}

export function ghEtagCacheDir(root: string): string {
  return join(rspStateDir(root), GH_ETAG_CACHE_DIR_NAME);
}

export function ghEtagEntryPath(root: string, key: string): string {
  return join(ghEtagCacheDir(root), `${entryFileStem(key)}.toon`);
}

export function legacyGhEtagCachePaths(root: string): string[] {
  const dir = rspStateDir(root);
  return [join(dir, LEGACY_GH_ETAG_CACHE_FILE), join(dir, LEGACY_GH_ETAG_CACHE_JSON_FILE)];
}

/**
 * Read one cached entry, charging only its bytes to this invocation.
 *
 * The cost is the point: the read touches a single partition, so it stays flat
 * as the cache grows instead of scaling with everything cached before it.
 */
export async function readGhEtagEntry(root: string, key: string): Promise<GhEtagCacheEntry | undefined> {
  await migrateLegacyGhEtagCache(root);
  try {
    const parsed = decodeCacheValue(await readSelfStateFile(ghEtagEntryPath(root, key)));
    return isCacheEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Write one cached entry atomically, then hold the lane to its byte ceiling. */
export async function writeGhEtagEntry(
  root: string,
  entry: GhEtagCacheEntry,
  options: { maxBytes?: number } = {},
): Promise<GhEtagCacheCeilingResult> {
  await writeCacheFile(ghEtagEntryPath(root, entry.key), entry as unknown as JsonValue);
  return await enforceGhEtagCacheCeiling(root, options.maxBytes ?? DEFAULT_GH_ETAG_CACHE_MAX_BYTES);
}

/**
 * Evict oldest-first until the partitioned cache fits under `maxBytes`.
 *
 * Eviction only ever stats entries — it never reads their bodies — so keeping
 * the cache bounded does not reintroduce the read tax it exists to remove.
 */
export async function enforceGhEtagCacheCeiling(
  root: string,
  maxBytes: number = DEFAULT_GH_ETAG_CACHE_MAX_BYTES,
): Promise<GhEtagCacheCeilingResult> {
  const entries = await statCacheEntries(root);
  let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  if (bytes <= maxBytes) return { evictedEntries: 0, bytes };

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let evictedEntries = 0;
  for (const entry of entries) {
    if (bytes <= maxBytes) break;
    try {
      await unlink(entry.path);
      bytes -= entry.bytes;
      evictedEntries += 1;
    } catch {}
  }
  return { evictedEntries, bytes };
}

/**
 * The janitor pass for this lane: migrate, reclaim orphan temps, re-bound.
 *
 * An interrupted atomic write leaves a `.tmp` behind, and nothing reclaimed
 * them — three zero-byte orphans sat in this lane for days (#2745).
 */
export async function sweepGhEtagCache(
  root: string,
  options: { maxBytes?: number } = {},
): Promise<GhEtagCacheSweepResult> {
  const migratedEntries = await migrateLegacyGhEtagCache(root, { force: true });
  const reclaimedTmp = await reclaimOrphanTmpFiles(root);
  const ceiling = await enforceGhEtagCacheCeiling(root, options.maxBytes ?? DEFAULT_GH_ETAG_CACHE_MAX_BYTES);
  return { ...ceiling, reclaimedTmp, migratedEntries };
}

/**
 * Read a legacy single-document cache, charging its bytes to this invocation.
 *
 * Retained for migration only: without the byte accounting, a document that
 * has grown to megabytes looks identical to one that costs nothing.
 */
export async function readGhEtagCache(root: string): Promise<GhEtagCacheDocument> {
  for (const path of legacyGhEtagCachePaths(root)) {
    try {
      const parsed = decodeCacheValue(await readSelfStateFile(path));
      if (isCacheDocument(parsed)) return parsed;
    } catch {}
  }
  return { version: 1, entries: {} };
}

const migratedRoots = new Set<string>();

/**
 * Split a legacy single-document cache into partitions, once per process.
 *
 * Memoized because the whole point is that lookups stop touching the document:
 * probing for it on every call would trade a 10 MB read for a stat per call.
 */
export async function migrateLegacyGhEtagCache(
  root: string,
  options: { force?: boolean } = {},
): Promise<number> {
  if (!options.force && migratedRoots.has(root)) return 0;
  migratedRoots.add(root);
  // Synchronous existence on purpose: this probe runs at most once per root,
  // so an async fan-out here would be all cost and no benefit.
  const legacy = legacyGhEtagCachePaths(root).filter((path) => existsSync(path));
  if (legacy.length === 0) return 0;

  const document = await readGhEtagCache(root);
  let migrated = 0;
  for (const [key, entry] of Object.entries(document.entries)) {
    if (!isCacheEntry(entry)) continue;
    const path = ghEtagEntryPath(root, key);
    if (await pathExists(path)) continue;
    await writeCacheFile(path, { ...entry, key } as unknown as JsonValue);
    migrated += 1;
  }
  for (const path of legacy) await rm(path, { force: true });
  return migrated;
}

/** Forget the per-process migration memo (tests and long-lived residents). */
export function resetGhEtagCacheMigrationMemo(): void {
  migratedRoots.clear();
}

async function reclaimOrphanTmpFiles(root: string): Promise<number> {
  let reclaimed = 0;
  for (const dir of [rspStateDir(root), ghEtagCacheDir(root)]) {
    for (const name of await listDir(dir)) {
      if (!name.endsWith(".tmp")) continue;
      try {
        await unlink(join(dir, name));
        reclaimed += 1;
      } catch {}
    }
  }
  return reclaimed;
}

async function statCacheEntries(root: string): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> {
  const dir = ghEtagCacheDir(root);
  const found: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith(".toon")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile()) found.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {}
  }
  return found;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeCacheFile(path: string, value: JsonValue): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${encode(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    // A failed write must not leave the orphan this issue was filed about.
    await rm(tmp, { force: true });
    throw error;
  }
}

function entryFileStem(key: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error(`unsafe gh etag cache key: ${key}`);
  return key;
}

function decodeCacheValue(raw: string): unknown {
  // A legacy cache was written as JSON, so a legacy read must parse JSON;
  // everything this module writes is TOON.
  try {
    return JSON.parse(raw);
  } catch {
    return decode(raw);
  }
}

function isCacheDocument(value: unknown): value is GhEtagCacheDocument {
  return isRecord(value) &&
    value.version === 1 &&
    isRecord(value.entries) &&
    Object.values(value.entries).every(isCacheEntry);
}

export function isCacheEntry(value: unknown): value is GhEtagCacheEntry {
  return isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.request === "string" &&
    typeof value.etag === "string" &&
    typeof value.body === "string" &&
    typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
