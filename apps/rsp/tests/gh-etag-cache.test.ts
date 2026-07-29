import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import {
  DEFAULT_GH_ETAG_CACHE_MAX_BYTES,
  enforceGhEtagCacheCeiling,
  ghEtagCacheDir,
  ghEtagEntryPath,
  readGhEtagEntry,
  resetGhEtagCacheMigrationMemo,
  sweepGhEtagCache,
  writeGhEtagEntry,
  type GhEtagCacheEntry,
} from "../src/gh-etag-cache.js";
import { overheadCounters, resetOverheadCounters } from "../src/overhead-budget.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-gh-etag-cache-"));
  roots.push(root);
  await mkdir(join(root, ".red", "state", "rsp"), { recursive: true });
  return root;
}

function entryOf(index: number, bodyBytes: number): GhEtagCacheEntry {
  return {
    key: `${index}`.padStart(64, "0"),
    request: `{"method":"GET","path":"repos/owner/repo/issues/${index}"}`,
    etag: `etag-${index}`,
    body: "b".repeat(bodyBytes),
    updated_at: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
  };
}

async function seed(root: string, count: number, bodyBytes: number): Promise<GhEtagCacheEntry[]> {
  const entries: GhEtagCacheEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = entryOf(index, bodyBytes);
    entries.push(entry);
    // Seeded directly so the ceiling never evicts while the fixture is built.
    await writeGhEtagEntry(root, entry, { maxBytes: Number.MAX_SAFE_INTEGER });
  }
  return entries;
}

async function cacheFileNames(root: string): Promise<string[]> {
  try {
    return (await readdir(ghEtagCacheDir(root))).sort();
  } catch {
    return [];
  }
}

beforeEach(() => {
  resetGhEtagCacheMigrationMemo();
  resetOverheadCounters();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gh etag cache partitioning", () => {
  it("reads one partition per lookup instead of the whole cache document", async () => {
    const root = await tempRoot();
    const bodyBytes = 50_000;
    const entries = await seed(root, 40, bodyBytes);

    resetOverheadCounters();
    const hit = await readGhEtagEntry(root, entries[20]!.key);

    expect(hit?.etag).toBe("etag-20");
    // One entry's bytes, not forty: the whole-document read cost 40x this.
    const read = overheadCounters().selfStateBytesRead;
    expect(read).toBeGreaterThan(bodyBytes);
    expect(read).toBeLessThan(bodyBytes * 2);
  });

  it("keeps lookup cost independent of total cache size", async () => {
    const small = await tempRoot();
    const large = await tempRoot();
    const bodyBytes = 20_000;
    const target = entryOf(3, bodyBytes);
    await seed(small, 5, bodyBytes);
    await seed(large, 200, bodyBytes);

    resetOverheadCounters();
    await readGhEtagEntry(small, target.key);
    const smallBytes = overheadCounters().selfStateBytesRead;

    resetOverheadCounters();
    await readGhEtagEntry(large, target.key);
    const largeBytes = overheadCounters().selfStateBytesRead;

    // A 40x larger cache must cost the same lookup, not 40x the bytes.
    expect(largeBytes).toBe(smallBytes);
    expect((await cacheFileNames(large)).length).toBe(200);
  });

  it("writes every partition as TOON, never JSON", async () => {
    const root = await tempRoot();
    const [entry] = await seed(root, 1, 64);

    const raw = await readFile(ghEtagEntryPath(root, entry!.key), "utf8");
    expect(() => JSON.parse(raw)).toThrow();
    expect(decode(raw)).toMatchObject({ etag: "etag-0" });
  });
});

describe("gh etag cache byte ceiling", () => {
  it("evicts oldest-first when the configured ceiling is exceeded", async () => {
    const root = await tempRoot();
    const bodyBytes = 10_000;
    const entries = await seed(root, 10, bodyBytes);
    // Age the partitions deterministically: oldest key first.
    for (const [index, entry] of entries.entries()) {
      const when = new Date(Date.UTC(2026, 6, 1) + index * 60_000);
      await utimes(ghEtagEntryPath(root, entry.key), when, when);
    }

    const result = await enforceGhEtagCacheCeiling(root, bodyBytes * 4);

    expect(result.bytes).toBeLessThanOrEqual(bodyBytes * 4);
    expect(result.evictedEntries).toBeGreaterThanOrEqual(6);
    const survivors = await cacheFileNames(root);
    // The four youngest survive; the six oldest are gone.
    expect(survivors).toEqual(entries.slice(-survivors.length).map((entry) => `${entry.key}.toon`).sort());
  });

  it("bounds the lane on write with the ceiling the caller configured", async () => {
    const root = await tempRoot();
    const bodyBytes = 8_000;
    await seed(root, 6, bodyBytes);

    const newest = entryOf(99, bodyBytes);
    const result = await writeGhEtagEntry(root, newest, { maxBytes: bodyBytes * 2 });

    expect(result.bytes).toBeLessThanOrEqual(bodyBytes * 2);
    // The entry just written is the newest, so it must never be the one evicted.
    expect(await readGhEtagEntry(root, newest.key)).toMatchObject({ etag: "etag-99" });
  });

  it("leaves a cache under the default ceiling untouched", async () => {
    const root = await tempRoot();
    await seed(root, 3, 1_000);

    const result = await enforceGhEtagCacheCeiling(root, DEFAULT_GH_ETAG_CACHE_MAX_BYTES);

    expect(result.evictedEntries).toBe(0);
    expect((await cacheFileNames(root)).length).toBe(3);
  });
});

describe("gh etag cache tmp reclamation", () => {
  it("leaves no .tmp behind from an interrupted write after the next lane sweep", async () => {
    const root = await tempRoot();
    await seed(root, 2, 512);
    // The exact shape found on disk: zero-byte temps an interrupted atomic
    // write left in both the state lane and the cache partition dir.
    const orphanInStateDir = join(root, ".red", "state", "rsp", "gh-etag-cache.toon.4242.1753000000000.tmp");
    const orphanInCacheDir = join(ghEtagCacheDir(root), "deadbeef.toon.4242.1753000000000.tmp");
    await writeFile(orphanInStateDir, "", "utf8");
    await writeFile(orphanInCacheDir, "", "utf8");

    const result = await sweepGhEtagCache(root, { maxBytes: DEFAULT_GH_ETAG_CACHE_MAX_BYTES });

    expect(result.reclaimedTmp).toBe(2);
    expect((await cacheFileNames(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await expect(stat(orphanInStateDir)).rejects.toThrow();
    await expect(stat(orphanInCacheDir)).rejects.toThrow();
    // Reclaiming temps never touches live partitions.
    expect((await cacheFileNames(root)).length).toBe(2);
  });

  it("reclaims the temp file a failed write left behind", async () => {
    const root = await tempRoot();
    const entry = entryOf(1, 128);
    // A directory where the partition file belongs makes rename fail.
    await mkdir(ghEtagEntryPath(root, entry.key), { recursive: true });

    await expect(writeGhEtagEntry(root, entry)).rejects.toThrow();

    expect((await cacheFileNames(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("gh etag cache legacy migration", () => {
  it("splits a legacy single-document cache into partitions and drops the document", async () => {
    const root = await tempRoot();
    const legacy = join(root, ".red", "state", "rsp", "gh-etag-cache.toon");
    const entry = entryOf(7, 256);
    await writeFile(
      legacy,
      `${encode({ version: 1, entries: { [entry.key]: entry } } as unknown as JsonValue)}\n`,
      "utf8",
    );

    const hit = await readGhEtagEntry(root, entry.key);

    expect(hit?.etag).toBe("etag-7");
    expect(await cacheFileNames(root)).toEqual([`${entry.key}.toon`]);
    await expect(stat(legacy)).rejects.toThrow();
  });

  it("migrates a legacy JSON document too, then never parses JSON again", async () => {
    const root = await tempRoot();
    const legacy = join(root, ".red", "state", "rsp", "gh-etag-cache.json");
    const entry = entryOf(8, 256);
    await writeFile(legacy, JSON.stringify({ version: 1, entries: { [entry.key]: entry } }), "utf8");

    expect((await readGhEtagEntry(root, entry.key))?.etag).toBe("etag-8");
    await expect(stat(legacy)).rejects.toThrow();
    const raw = await readFile(ghEtagEntryPath(root, entry.key), "utf8");
    expect(() => JSON.parse(raw)).toThrow();
  });

  it("does not probe for the legacy document on every lookup", async () => {
    const root = await tempRoot();
    const entries = await seed(root, 2, 128);
    const legacy = join(root, ".red", "state", "rsp", "gh-etag-cache.toon");
    // Written after the memo is set by the first lookup: a per-call probe would
    // pick this up and pay the whole-document read again.
    await readGhEtagEntry(root, entries[0]!.key);
    await writeFile(legacy, `${encode({ version: 1, entries: {} } as unknown as JsonValue)}\n`, "utf8");

    resetOverheadCounters();
    await readGhEtagEntry(root, entries[1]!.key);

    await expect(stat(legacy)).resolves.toBeTruthy();
    expect(overheadCounters().selfStateBytesRead).toBeLessThan(1_000);
  });
});
