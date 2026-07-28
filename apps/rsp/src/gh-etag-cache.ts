import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { resolveGhEtagCacheByteBudget } from "./config.js";

/**
 * Partitioned on-disk store for `gh` conditional-request ETags.
 *
 * One entry per file, addressed by its request key, so a lookup costs one small
 * read no matter how many entries the lane holds. The predecessor kept every
 * entry in a single document and read it whole on every `gh` call, which grew
 * to ~10 MB of read-decode-rewrite per invocation on a busy repo.
 */
export interface GhEtagCacheEntry {
  key: string;
  request: string;
  etag: string;
  body: string;
  updated_at: string;
}

export interface GhEtagCacheSweepOptions {
  /** Byte ceiling for the whole lane; entries are evicted oldest-first above it. */
  maxBytes?: number;
  /**
   * How long an unclaimed `.tmp` may survive before the sweep reclaims it. The
   * grace exists so a concurrent writer's in-flight temp is never deleted out
   * from under it; tests pass 0 to sweep synchronously.
   */
  tmpGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GhEtagCacheSweepResult {
  bytes: number;
  entries: number;
  evicted: number;
  reclaimedTmp: number;
}

const CACHE_DIR = "gh-etag";
const ENTRY_SUFFIX = ".toon";
const LEGACY_CACHE_FILES = ["gh-etag-cache.toon", "gh-etag-cache.json"] as const;
const LEGACY_TMP_PREFIX = "gh-etag-cache.";
const DEFAULT_TMP_GRACE_MS = 5 * 60_000;

let readBytes = 0;
let readFiles = 0;

/** Bytes and files this process has read from the cache — the lookup-cost probe. */
export function ghEtagCacheReadStats(): { bytes: number; files: number } {
  return { bytes: readBytes, files: readFiles };
}

export function resetGhEtagCacheReadStats(): void {
  readBytes = 0;
  readFiles = 0;
}

export function ghEtagCacheDir(root: string): string {
  return join(rspStateDir(root), CACHE_DIR);
}

export function ghEtagEntryPath(root: string, key: string): string {
  return join(ghEtagCacheDir(root), key.slice(0, 2), `${key}${ENTRY_SUFFIX}`);
}

/** Reads exactly one entry file; unknown keys cost one failed open, not a scan. */
export async function readGhEtagEntry(root: string, key: string): Promise<GhEtagCacheEntry | null> {
  await migrateLegacyGhEtagCache(root);
  try {
    const raw = await readFile(ghEtagEntryPath(root, key), "utf8");
    readBytes += Buffer.byteLength(raw);
    readFiles += 1;
    const parsed = decodeEntry(raw);
    return isCacheEntry(parsed) && parsed.key === key ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeGhEtagEntry(
  root: string,
  entry: GhEtagCacheEntry,
  options: GhEtagCacheSweepOptions = {},
): Promise<void> {
  const path = ghEtagEntryPath(root, entry.key);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${counterToken()}.tmp`;
  try {
    await writeFile(tmp, `${encode(entry as unknown as JsonValue)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await sweepGhEtagCache(root, options);
}

/**
 * Enforces the byte ceiling and reclaims orphan `.tmp` files in one pass.
 *
 * Only directory metadata is consulted — sizes and mtimes — so bounding the
 * lane never pays the cost of reading the bodies it may be about to delete.
 */
export async function sweepGhEtagCache(
  root: string,
  options: GhEtagCacheSweepOptions = {},
): Promise<GhEtagCacheSweepResult> {
  const maxBytes = options.maxBytes ?? resolveGhEtagCacheByteBudget(root, options.env ?? process.env);
  const graceMs = options.tmpGraceMs ?? DEFAULT_TMP_GRACE_MS;
  const now = Date.now();
  const dir = ghEtagCacheDir(root);
  const result: GhEtagCacheSweepResult = { bytes: 0, entries: 0, evicted: 0, reclaimedTmp: 0 };
  const live: Array<{ path: string; size: number; mtimeMs: number }> = [];

  for (const path of await listFiles(dir)) {
    const info = await statOrNull(path);
    if (!info) continue;
    if (path.endsWith(".tmp")) {
      if (now - info.mtimeMs >= graceMs) {
        await rm(path, { force: true });
        result.reclaimedTmp += 1;
      }
      continue;
    }
    if (!path.endsWith(ENTRY_SUFFIX)) continue;
    live.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    result.bytes += info.size;
  }

  // Orphans from the pre-partition writer sat directly in the state dir.
  for (const path of await listFiles(rspStateDir(root), false)) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name.startsWith(LEGACY_TMP_PREFIX) || !name.endsWith(".tmp")) continue;
    const info = await statOrNull(path);
    if (!info || now - info.mtimeMs < graceMs) continue;
    await rm(path, { force: true });
    result.reclaimedTmp += 1;
  }

  live.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let index = 0;
  while (result.bytes > maxBytes && index < live.length) {
    const victim = live[index++]!;
    await rm(victim.path, { force: true });
    result.bytes -= victim.size;
    result.evicted += 1;
  }
  result.entries = live.length - result.evicted;
  return result;
}

/**
 * Folds a pre-partition monolith into per-key entries exactly once. The whole
 * document is read here and nowhere else, and the legacy file is removed so the
 * cost is paid at most once per repo.
 */
export async function migrateLegacyGhEtagCache(root: string): Promise<number> {
  let migrated = 0;
  for (const file of LEGACY_CACHE_FILES) {
    const path = join(rspStateDir(root), file);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const parsed = decodeEntry(raw);
    const entries = isRecord(parsed) && isRecord(parsed.entries) ? Object.values(parsed.entries) : [];
    for (const entry of entries) {
      if (!isCacheEntry(entry)) continue;
      const target = ghEtagEntryPath(root, entry.key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${encode(entry as unknown as JsonValue)}\n`, { encoding: "utf8", mode: 0o600 });
      migrated += 1;
    }
    await rm(path, { force: true });
  }
  return migrated;
}

let tmpCounter = 0;

function counterToken(): string {
  tmpCounter += 1;
  return `${Date.now().toString(36)}${tmpCounter.toString(36)}`;
}

async function listFiles(dir: string, recursive = true): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dirent of dirents) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (recursive) files.push(...(await listFiles(path)));
      continue;
    }
    files.push(path);
  }
  return files;
}

async function statOrNull(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function decodeEntry(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return decode(raw);
    } catch {
      return null;
    }
  }
}

function isCacheEntry(value: unknown): value is GhEtagCacheEntry {
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
