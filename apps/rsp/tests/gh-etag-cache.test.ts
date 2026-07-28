import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode, type JsonValue } from "@reddb-io/toon";
import {
  ghEtagCacheDir,
  ghEtagCacheReadStats,
  ghEtagEntryPath,
  migrateLegacyGhEtagCache,
  readGhEtagEntry,
  resetGhEtagCacheReadStats,
  sweepGhEtagCache,
  writeGhEtagEntry,
  type GhEtagCacheEntry,
} from "../src/gh-etag-cache.js";

const roots: string[] = [];
const HUGE_BUDGET = 64 * 1024 * 1024;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-gh-etag-"));
  roots.push(root);
  await mkdir(join(root, ".red", "state", "rsp"), { recursive: true });
  return root;
}

function entry(index: number, bodyBytes = 512): GhEtagCacheEntry {
  const key = `${index.toString(16).padStart(4, "0")}`.repeat(16);
  return {
    key,
    request: JSON.stringify({ method: "GET", path: `repos/owner/repo/issues/${index}`, params: [] }),
    etag: `etag-${index}`,
    body: "b".repeat(bodyBytes),
    updated_at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  };
}

async function seed(root: string, count: number, bodyBytes = 512): Promise<GhEtagCacheEntry[]> {
  const seeded: GhEtagCacheEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = entry(index, bodyBytes);
    await writeGhEtagEntry(root, value, { maxBytes: HUGE_BUDGET, tmpGraceMs: HUGE_BUDGET });
    seeded.push(value);
  }
  return seeded;
}

async function cacheFiles(root: string): Promise<string[]> {
  try {
    const dirents = await readdir(ghEtagCacheDir(root), { recursive: true, withFileTypes: true });
    return dirents.filter((dirent) => dirent.isFile()).map((dirent) => join(dirent.parentPath, dirent.name));
  } catch {
    return [];
  }
}

beforeEach(() => {
  resetGhEtagCacheReadStats();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gh etag cache partitioning", () => {
  it("reads exactly one entry file per lookup, never the whole lane", async () => {
    const root = await tempRoot();
    const seeded = await seed(root, 40);

    resetGhEtagCacheReadStats();
    const found = await readGhEtagEntry(root, seeded[7]!.key);

    expect(found?.etag).toBe("etag-7");
    const stats = ghEtagCacheReadStats();
    expect(stats.files).toBe(1);
    const entrySize = (await stat(ghEtagEntryPath(root, seeded[7]!.key))).size;
    expect(stats.bytes).toBe(entrySize);
  });

  it("keeps lookup cost independent of total cache size", async () => {
    const small = await tempRoot();
    const large = await tempRoot();
    const smallSeeded = await seed(small, 4);
    const largeSeeded = await seed(large, 200);

    resetGhEtagCacheReadStats();
    await readGhEtagEntry(small, smallSeeded[1]!.key);
    const smallBytes = ghEtagCacheReadStats().bytes;

    resetGhEtagCacheReadStats();
    await readGhEtagEntry(large, largeSeeded[1]!.key);
    const largeBytes = ghEtagCacheReadStats().bytes;

    // 50x the entries must not cost 50x the read: one entry is one entry.
    expect(largeBytes).toBe(smallBytes);
    const laneBytes = (await Promise.all((await cacheFiles(large)).map(async (path) => (await stat(path)).size)))
      .reduce((total, size) => total + size, 0);
    expect(largeBytes).toBeLessThan(laneBytes / 50);
  });

  it("misses cost one failed open rather than a scan", async () => {
    const root = await tempRoot();
    await seed(root, 20);

    resetGhEtagCacheReadStats();
    expect(await readGhEtagEntry(root, "f".repeat(64))).toBeNull();
    expect(ghEtagCacheReadStats()).toEqual({ bytes: 0, files: 0 });
  });
});

describe("gh etag cache ceiling", () => {
  it("evicts oldest-first once the configured byte ceiling is exceeded", async () => {
    const root = await tempRoot();
    const seeded = await seed(root, 10, 1024);
    const sizes = await Promise.all(seeded.map(async (value) => (await stat(ghEtagEntryPath(root, value.key))).size));
    const perEntry = sizes[0]!;

    const result = await sweepGhEtagCache(root, { maxBytes: perEntry * 4, tmpGraceMs: HUGE_BUDGET });

    expect(result.evicted).toBe(6);
    expect(result.bytes).toBeLessThanOrEqual(perEntry * 4);
    expect(await readGhEtagEntry(root, seeded[0]!.key)).toBeNull();
    expect(await readGhEtagEntry(root, seeded[9]!.key)).not.toBeNull();
  });

  it("bounds the lane on write without a caller-supplied ceiling", async () => {
    const root = await tempRoot();
    for (let index = 0; index < 12; index += 1) {
      await writeGhEtagEntry(root, entry(index, 1024), { maxBytes: 3 * 1024, tmpGraceMs: HUGE_BUDGET });
    }
    const files = await cacheFiles(root);
    const total = (await Promise.all(files.map(async (path) => (await stat(path)).size)))
      .reduce((sum, size) => sum + size, 0);
    expect(total).toBeLessThanOrEqual(3 * 1024);
  });

  it("reads the ceiling from the repo config", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  ghEtagCacheByteBudget: 2048\n", "utf8");
    for (let index = 0; index < 8; index += 1) {
      await writeGhEtagEntry(root, entry(index, 1024), { tmpGraceMs: HUGE_BUDGET, env: {} });
    }
    const files = await cacheFiles(root);
    const total = (await Promise.all(files.map(async (path) => (await stat(path)).size)))
      .reduce((sum, size) => sum + size, 0);
    expect(total).toBeLessThanOrEqual(2048);
  });
});

describe("gh etag cache tmp reclamation", () => {
  it("leaves no .tmp behind from an interrupted write after the next lane sweep", async () => {
    const root = await tempRoot();
    await seed(root, 2);
    const orphanInLane = join(ghEtagCacheDir(root), "aa", "aa-interrupted.toon.4242.1.tmp");
    const orphanInStateDir = join(root, ".red", "state", "rsp", "gh-etag-cache.toon.4242.1.tmp");
    await mkdir(join(ghEtagCacheDir(root), "aa"), { recursive: true });
    await writeFile(orphanInLane, "", "utf8");
    await writeFile(orphanInStateDir, "", "utf8");

    const result = await sweepGhEtagCache(root, { maxBytes: HUGE_BUDGET, tmpGraceMs: 0 });

    expect(result.reclaimedTmp).toBe(2);
    expect((await cacheFiles(root)).some((path) => path.endsWith(".tmp"))).toBe(false);
    await expect(stat(orphanInStateDir)).rejects.toThrow();
  });

  it("spares a temp still inside its grace window", async () => {
    const root = await tempRoot();
    await mkdir(join(ghEtagCacheDir(root), "aa"), { recursive: true });
    const inflight = join(ghEtagCacheDir(root), "aa", "aa-inflight.toon.4242.1.tmp");
    await writeFile(inflight, "", "utf8");

    const result = await sweepGhEtagCache(root, { maxBytes: HUGE_BUDGET, tmpGraceMs: 60_000 });

    expect(result.reclaimedTmp).toBe(0);
    await expect(stat(inflight)).resolves.toBeTruthy();
  });
});

describe("gh etag cache legacy migration", () => {
  it("folds a monolithic cache document into partitions exactly once", async () => {
    const root = await tempRoot();
    const legacyPath = join(root, ".red", "state", "rsp", "gh-etag-cache.toon");
    const entries = [entry(1), entry(2)];
    const document = {
      version: 1,
      entries: Object.fromEntries(entries.map((value) => [value.key, value])),
    };
    await writeFile(legacyPath, `${encode(document as unknown as JsonValue)}\n`, "utf8");

    resetGhEtagCacheReadStats();
    const found = await readGhEtagEntry(root, entries[1]!.key);

    expect(found?.etag).toBe("etag-2");
    await expect(stat(legacyPath)).rejects.toThrow();
    expect(await migrateLegacyGhEtagCache(root)).toBe(0);
    await expect(readFile(ghEtagEntryPath(root, entries[0]!.key), "utf8")).resolves.toContain("etag-1");
  });
});
