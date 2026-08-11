import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RSP_BYTE_BUDGET,
  DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
  DEFAULT_RSP_TTL_DAYS,
  RSP_ELISION_COLLECTION,
  RspElisionStore,
  storageClassForCommand,
} from "../src/elision-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readStoreSnapshot<T>(path: string): Promise<T> {
  return decode(await readFile(path, "utf8")) as T;
}

describe("RspElisionStore", () => {
  it("reads legacy JSON store documents and rewrites them as TOON", async () => {
    const root = await tempRoot();
    const storePath = join(root, "store.rdb");
    const now = new Date("2026-07-10T12:00:00.000Z");
    const original = Buffer.from("legacy elision");
    const handle = "el:123456789abc";
    await writeFile(
      storePath,
      `${JSON.stringify({
        version: 1,
        records: {
          "record:123456789abc": {
            collection: RSP_ELISION_COLLECTION,
            handle,
            original: original.toString("base64"),
            original_encoding: "base64",
            original_bytes: original.length,
            command: "node legacy.js",
            created_at: now.toISOString(),
            expires_at: new Date("2026-07-17T12:00:00.000Z").toISOString(),
            loss: { level: "brief", bytes_elided: original.length },
            storage_class: "ephemeral",
          },
        },
        blobs: {},
        tombstones: {},
        index: {
          version: 1,
          records: [{
            handle,
            key: "record:123456789abc",
            bytes: original.length,
            raw_bytes: original.length,
            command: "node legacy.js",
            created_at: now.toISOString(),
            expires_at: new Date("2026-07-17T12:00:00.000Z").toISOString(),
            storage_class: "ephemeral",
          }],
        },
      })}\n`,
      "utf8",
    );

    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => now,
    });
    try {
      const recovered = await store.get(handle);
      if (!recovered || "status" in recovered) throw new Error("expected live legacy record");
      expect(recovered.original).toEqual(original);

      await store.mint(Buffer.from("new elision"), {
        command: "node current.js",
        loss: { level: "brief", bytes_elided: 11 },
      });
      const rewritten = await readFile(storePath, "utf8");
      expect(() => JSON.parse(rewritten)).toThrow();
      expect(decode(rewritten)).toMatchObject({ version: 1 });
    } finally {
      await store.close();
    }
  });

  it("stores derivable handles as git object recipes and re-derives byte-identical output", async () => {
    const root = await tempRoot();
    git(root, ["init"]);
    git(root, ["config", "user.email", "agent@example.invalid"]);
    git(root, ["config", "user.name", "Agent"]);
    await writeFile(join(root, "tracked.txt"), "tracked content\n", "utf8");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "seed"]);

    const storeRoot = await tempRoot();
    const storePath = join(storeRoot, "store.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const original = Buffer.from(Array.from({ length: 12_000 }, (_, index) => `line ${index}\n`).join(""));
      const handle = await store.mint(original, {
        command: "git log --oneline",
        loss: { level: "terse", bytes_elided: original.length },
      });

      const storeText = await readFile(storePath, "utf8");
      expect(() => JSON.parse(storeText)).toThrow();
      const raw = decode(storeText) as {
        records: Record<string, { original?: string; derivation_recipe?: { object_ids?: string[] } }>;
        index: { records: Array<{ bytes: number }> };
      };
      const [record] = Object.values(raw.records);
      expect(record?.original).toBeUndefined();
      expect(record?.derivation_recipe?.object_ids).toHaveLength(1);
      expect(raw.index.records[0]?.bytes).toBeLessThan(500);
      expect(raw.index.records[0]?.bytes).toBeLessThan(original.length / 10);

      const recovered = await store.get(handle);
      if (!recovered || "status" in recovered) throw new Error("expected live derivable record");
      expect(recovered.original).toEqual(original);
      await expect(store.stats()).resolves.toMatchObject({
        storage_classes: { derivable: { records: 1, bytes: raw.index.records[0]?.bytes } },
      });
    } finally {
      process.chdir(previousCwd);
      await store.close();
    }
  });

  it("reports the unchanged expired contract when a derivable recipe object is unreachable", async () => {
    const root = await tempRoot();
    git(root, ["init"]);

    const storeRoot = await tempRoot();
    const storePath = join(storeRoot, "store.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const original = Buffer.from("temporary derivable output\n");
      const handle = await store.mint(original, {
        command: "git diff",
        loss: { level: "terse", bytes_elided: original.length },
      });
      const raw = await readStoreSnapshot<{
        records: Record<string, { derivation_recipe?: { object_ids?: string[] } }>;
      }>(storePath);
      const oid = Object.values(raw.records)[0]?.derivation_recipe?.object_ids?.[0];
      if (!oid) throw new Error("missing derivation object id");
      await rm(join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2)), { force: true });

      await expect(store.get(handle)).resolves.toEqual({
        status: "expired",
        expired_at: "2026-07-17T12:00:00.000Z",
        command: "git diff",
      });
    } finally {
      process.chdir(previousCwd);
      await store.close();
    }
  });

  it("stores re-executable handles as recipe plus hash and marks moved state on show", async () => {
    const root = await tempRoot();
    git(root, ["init"]);
    await writeFile(join(root, "tracked.txt"), "tracked content\n", "utf8");
    git(root, ["add", "tracked.txt"]);

    const storeRoot = await tempRoot();
    const storePath = join(storeRoot, "store.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const original = Buffer.from("A  tracked.txt\n");
      const handle = await store.mint(original, {
        command: "git status --short",
        loss: { level: "terse", bytes_elided: original.length },
      });

      const raw = await readStoreSnapshot<{
        records: Record<string, {
          original?: string;
          content_hash?: string;
          reexecution_recipe?: { argv?: string[]; content_hash?: string };
        }>;
        index: { records: Array<{ bytes: number; storage_class?: string }> };
      }>(storePath);
      const [stored] = Object.values(raw.records);
      expect(stored?.original).toBeUndefined();
      expect(stored?.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.reexecution_recipe?.argv).toEqual(["git", "status", "--short"]);
      expect(stored?.reexecution_recipe?.content_hash).toBe(stored?.content_hash);
      expect(raw.index.records[0]?.storage_class).toBe("re-executable");
      expect(raw.index.records[0]?.bytes).toBeLessThan(500);

      const matching = await store.get(handle);
      if (!matching || "status" in matching) throw new Error("expected live re-executable record");
      expect(matching.original).toEqual(original);

      await writeFile(join(root, "moved.txt"), "state moved\n", "utf8");
      const moved = await store.get(handle);
      if (!moved || "status" in moved) throw new Error("expected reconstructed re-executable record");
      expect(moved.original.toString("utf8")).toBe(
        "reconstructed after state moved - current snapshot follows\nA  tracked.txt\n?? moved.txt\n",
      );
    } finally {
      process.chdir(previousCwd);
      await store.close();
    }
  });

  it("classifies only cheap read commands as re-executable", () => {
    expect(storageClassForCommand("git status --short")).toBe("re-executable");
    expect(storageClassForCommand("git branch -av")).toBe("re-executable");
    expect(storageClassForCommand("gh pr view 42")).toBe("ephemeral");
    expect(storageClassForCommand("gh issue list --label ready-for-agent")).toBe("ephemeral");
    expect(storageClassForCommand("gh pr checkout 42")).toBe("ephemeral");
    expect(storageClassForCommand("gh run watch 123")).toBe("ephemeral");
    expect(storageClassForCommand("git commit -m msg")).toBe("ephemeral");
  });

  it("mints elision handles and round-trips original bytes exactly", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({
      uri: `file://${join(root, "red.rdb")}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      const original = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0x41, 0xff, 0x0a]);
      const handle = await store.mint(original, {
        command: "printf ansi-and-nul",
        loss: { level: "terse", bytes_elided: original.length },
      });

      expect(handle).toMatch(/^el:[a-f0-9]{12}$/);
      const record = await store.get(handle);

      expect(record).toEqual(expect.objectContaining({ collection: RSP_ELISION_COLLECTION }));
      if (!record || "status" in record) throw new Error("expected live elision record");
      expect(record?.collection).toBe(RSP_ELISION_COLLECTION);
      expect(record?.original).toEqual(original);
      expect(record?.command).toBe("printf ansi-and-nul");
      expect(record?.loss).toEqual({ level: "terse", bytes_elided: original.length });
    } finally {
      await store.close();
    }
  });

  it("stores ephemeral originals as compressed content-hash blobs and deduplicates identical content", async () => {
    const root = await tempRoot();
    const storePath = join(root, "red.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      const original = Buffer.from("repeatable output\n".repeat(500));
      const first = await store.mint(original, {
        command: "vitest run --reporter verbose",
        loss: { level: "terse", bytes_elided: original.length },
      });
      const second = await store.mint(original, {
        command: "node noisy-script.mjs",
        loss: { level: "brief", bytes_elided: original.length },
      });

      expect(second).not.toBe(first);
      const raw = await readStoreSnapshot<{
        blobs?: Record<string, { bytes?: string; encoding?: string; stored_bytes?: number; original_bytes?: number }>;
        records: Record<string, { original?: string; blob_key?: string; content_hash?: string }>;
        index: { records: Array<{ bytes: number; raw_bytes?: number; blob_key?: string; storage_class?: string }> };
      }>(storePath);
      const blobs = Object.values(raw.blobs ?? {});
      expect(blobs).toHaveLength(1);
      expect(blobs[0]?.encoding).toBe("gzip+base64");
      expect(blobs[0]?.original_bytes).toBe(original.length);
      expect(blobs[0]?.stored_bytes).toBeLessThan(original.length / 4);
      expect(new Set(Object.values(raw.records).map((record) => record.blob_key)).size).toBe(1);
      expect(Object.values(raw.records).every((record) => record.original === undefined)).toBe(true);
      expect(raw.index.records.every((entry) => entry.storage_class === "ephemeral")).toBe(true);
      expect(raw.index.records.every((entry) => entry.raw_bytes === original.length)).toBe(true);

      const recoveredFirst = await store.get(first);
      const recoveredSecond = await store.get(second);
      if (!recoveredFirst || "status" in recoveredFirst || !recoveredSecond || "status" in recoveredSecond) {
        throw new Error("expected live ephemeral records");
      }
      expect(recoveredFirst.original).toEqual(original);
      expect(recoveredSecond.original).toEqual(original);

      const stats = await store.stats();
      expect(stats.records).toBe(2);
      expect(stats.storage_classes.ephemeral.records).toBe(2);
      expect(stats.storage_classes.ephemeral.raw_bytes).toBe(original.length * 2);
      expect(stats.storage_classes.ephemeral.bytes).toBe(blobs[0]?.stored_bytes);
      expect(stats.bytes).toBe(blobs[0]?.stored_bytes);
    } finally {
      await store.close();
    }
  });

  it("round-trips large elisions beyond the database value size", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({
      uri: `file://${join(root, "red.rdb")}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      const original = Buffer.from(Array.from({ length: 12_000 }, (_, i) => i % 251));
      const handle = await store.mint(original, {
        command: "git log --format=fixture",
        loss: { level: "terse", bytes_elided: original.length },
      });

      const record = await store.get(handle);

      if (!record || "status" in record) throw new Error("expected live elision record");
      expect(record.original).toEqual(original);
      const stats = await store.stats();
      expect(stats.records).toBe(1);
      expect(stats.bytes).toBeLessThan(500);
      expect(stats.bytes).toBeLessThan(original.length / 10);
      expect(stats.storage_classes.derivable).toEqual({ records: 1, bytes: stats.bytes, raw_bytes: original.length });
    } finally {
      await store.close();
    }
  });

  it("opens and writes without a RedDB subprocess", async () => {
    const root = await tempRoot();
    const previous = process.env.REDDB_BIN;
    process.env.REDDB_BIN = join(root, "missing-red-binary");
    try {
      const store = await RspElisionStore.open({
        uri: `file://${join(root, "red.rdb")}`,
        now: () => new Date("2026-07-10T12:00:00.000Z"),
      });
      try {
        const handle = await store.mint(Buffer.from("fast local write"), {
          command: "git log --terse",
          loss: { level: "terse", bytes_elided: 16 },
        });

        expect((await store.get(handle))?.original).toEqual(Buffer.from("fast local write"));
      } finally {
        await store.close();
      }
    } finally {
      if (previous === undefined) delete process.env.REDDB_BIN;
      else process.env.REDDB_BIN = previous;
    }
  });

  it("expires ephemeral records by the hours-scale TTL and reports the original command", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    const root = await tempRoot();
    const store = await RspElisionStore.open({
      uri: `file://${join(root, "red.rdb")}`,
      ttlDays: 1,
      ephemeralTtlHours: 2,
      now: () => now,
    });
    try {
      const handle = await store.mint(Buffer.from("old output"), {
        command: "old command",
        loss: { level: "terse", bytes_elided: 10 },
      });

      now = new Date("2026-07-10T15:00:00.000Z");
      await store.mint(Buffer.from("new output"), {
        command: "new command",
        loss: { level: "terse", bytes_elided: 10 },
      });

      expect(await store.get(handle)).toEqual({
        status: "expired",
        expired_at: "2026-07-10T14:00:00.000Z",
        command: "old command",
      });
    } finally {
      await store.close();
    }
  });

  it("evicts oldest records when the byte budget is exceeded on write", async () => {
    let tick = 0;
    const root = await tempRoot();
    const store = await RspElisionStore.open({
      uri: `file://${join(root, "red.rdb")}`,
      byteBudget: 40,
      now: () => new Date(Date.UTC(2026, 6, 10, 12, 0, tick++)),
    });
    try {
      const first = await store.mint(Buffer.from("123456"), {
        command: "first",
        loss: { level: "terse", bytes_elided: 6 },
      });
      const second = await store.mint(Buffer.from("abcdef"), {
        command: "second",
        loss: { level: "terse", bytes_elided: 6 },
      });

      expect(await store.get(first)).toEqual({
        status: "expired",
        expired_at: "2026-07-10T12:00:03.000Z",
        command: "first",
      });
      expect((await store.get(second))?.original).toEqual(Buffer.from("abcdef"));
    } finally {
      await store.close();
    }
  });

  it("performs zero writes to the content store on a no-expiration sweep", async () => {
    const root = await tempRoot();
    const storePath = join(root, "red.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      ttlDays: 7,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      await store.mint(Buffer.from("sweep test"), {
        command: "git log",
        loss: { level: "terse", bytes_elided: 10 },
      });

      const afterMint = await readFile(storePath, "utf8");
      const mtimeAfterMint = (await stat(storePath)).mtimeMs;

      await store.stats();
      await store.stats();
      await store.stats();

      const afterSweeps = await readFile(storePath, "utf8");
      const mtimeAfterSweeps = (await stat(storePath)).mtimeMs;

      expect(afterSweeps).toBe(afterMint);
      expect(mtimeAfterSweeps).toBe(mtimeAfterMint);
    } finally {
      await store.close();
    }
  });

  it("still writes the store when a sweep expires records", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    const root = await tempRoot();
    const storePath = join(root, "red.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      ttlDays: 1,
      now: () => now,
    });
    try {
      await store.mint(Buffer.from("will expire"), {
        command: "git diff",
        loss: { level: "terse", bytes_elided: 11 },
      });

      const afterMint = await readFile(storePath, "utf8");

      now = new Date("2026-07-12T12:00:00.000Z");
      await store.stats();

      const afterExpiry = await readFile(storePath, "utf8");
      expect(afterExpiry).not.toBe(afterMint);
      expect(await store.stats()).toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("compacts the on-disk store after repeated mint-expire-sweep cycles", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    const root = await tempRoot();
    const storePath = join(root, "red.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      byteBudget: 2_000,
      ephemeralTtlHours: 1,
      now: () => now,
    });
    try {
      for (let cycle = 0; cycle < 24; cycle += 1) {
        await store.mint(Buffer.from(`cycle ${cycle} ${"x".repeat(256)}`), {
          command: `node noisy-${cycle}.mjs`,
          loss: { level: "terse", bytes_elided: 256 },
        });
        now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        await store.stats();
      }

      expect((await stat(storePath)).size).toBeLessThanOrEqual(2_000);
      await expect(store.stats()).resolves.toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("bounds the embedded RedDB file after repeated mint-expire-sweep cycles", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    const root = await tempRoot();
    const storePath = join(root, "red-skills.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      byteBudget: 512 * 1024,
      ephemeralTtlHours: 1,
      now: () => now,
    });
    try {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        await store.mint(randomBytes(64 * 1024), {
          command: `node noisy-${cycle}.mjs`,
          loss: { level: "terse", bytes_elided: 64 * 1024 },
        });
        now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        await store.stats();
      }

      expect((await stat(storePath)).size).toBeLessThanOrEqual(512 * 1024);
      await expect(store.stats()).resolves.toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("rotates to a compact generation while preserving live records and degraded old-handle semantics", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    const root = await tempRoot();
    const storePath = join(root, "red.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      byteBudget: 2_400,
      ephemeralTtlHours: 1,
      now: () => now,
    });
    try {
      const expired: `el:${string}`[] = [];
      for (let cycle = 0; cycle < 16; cycle += 1) {
        expired.push(await store.mint(Buffer.from(`expired ${cycle} ${"x".repeat(128)}`), {
          command: `node expired-${cycle}.mjs`,
          loss: { level: "terse", bytes_elided: 128 },
        }));
        now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        await store.stats();
      }

      const live = await store.mint(Buffer.from("live record"), {
        command: "node live.mjs",
        loss: { level: "terse", bytes_elided: 11 },
      });
      await store.stats();

      const recovered = await store.get(live);
      if (!recovered || "status" in recovered) throw new Error("expected live record after rotation");
      expect(recovered.original).toEqual(Buffer.from("live record"));
      expect((await stat(storePath)).size).toBeLessThanOrEqual(2_400);
      expect(await store.get(expired[0]!)).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("cuts over an old-format json store by discarding it instead of migrating records", async () => {
    const root = await tempRoot();
    const storePath = join(root, "red.rdb");
    await writeFile(storePath, JSON.stringify({
      version: 0,
      records: {
        "record:123456789abc": {
          collection: RSP_ELISION_COLLECTION,
          handle: "el:123456789abc",
          original: Buffer.from("legacy payload").toString("base64"),
          original_encoding: "base64",
          original_bytes: 14,
          command: "git diff",
          created_at: "2026-07-10T12:00:00.000Z",
          expires_at: "2026-07-17T12:00:00.000Z",
          loss: { level: "terse", bytes_elided: 14 },
        },
      },
      tombstones: {},
      index: { version: 1, records: [] },
    }), "utf8");

    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      await expect(store.get("el:123456789abc")).resolves.toBeNull();
      const handle = await store.mint(Buffer.from("fresh"), {
        command: "node fresh.mjs",
        loss: { level: "terse", bytes_elided: 5 },
      });
      await expect(store.get(handle)).resolves.toMatchObject({ handle });
    } finally {
      await store.close();
    }
  });

  it("reports live store stats as scalar values", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({
      uri: `file://${join(root, "red.rdb")}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      await store.mint(Buffer.from("abc"), {
        command: "cmd",
        loss: { level: "terse", bytes_elided: 3 },
      });

      expect(await store.stats()).toEqual({
        records: 1,
        bytes: expect.any(Number),
        oldest: "2026-07-10T12:00:00.000Z",
        budget: DEFAULT_RSP_BYTE_BUDGET,
        storage_classes: {
          derivable: { records: 0, bytes: 0, raw_bytes: 0 },
          "re-executable": { records: 0, bytes: 0, raw_bytes: 0 },
          ephemeral: { records: 1, bytes: expect.any(Number), raw_bytes: 3 },
        },
      });
      expect(DEFAULT_RSP_TTL_DAYS).toBe(7);
      expect(DEFAULT_RSP_EPHEMERAL_TTL_HOURS).toBeLessThan(24);
    } finally {
      await store.close();
    }
  });

  it("records exactly one storage class per minted handle and reports the class breakdown", async () => {
    const root = await tempRoot();
    git(root, ["init"]);
    await writeFile(join(root, "tracked.txt"), "tracked content\n", "utf8");
    git(root, ["add", "tracked.txt"]);

    const storeRoot = await tempRoot();
    const storePath = join(storeRoot, "red.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await store.mint(Buffer.from("git history"), {
        command: "git log --oneline",
        loss: { level: "terse", bytes_elided: 11 },
      });
      await store.mint(Buffer.from("A  tracked.txt\n"), {
        command: "git status --short",
        loss: { level: "brief", bytes_elided: 15 },
      });
      await store.mint(Buffer.from("test output"), {
        command: "vitest run",
        loss: { level: "terse", bytes_elided: 11 },
      });

      const raw = await readStoreSnapshot<{
        index: { records: Array<{ storage_class?: string }> };
        records: Record<string, { storage_class?: string }>;
      }>(storePath);
      expect(raw.index.records.map((entry) => entry.storage_class).sort()).toEqual([
        "derivable",
        "ephemeral",
        "re-executable",
      ]);
      expect(Object.values(raw.records).map((record) => record.storage_class).sort()).toEqual([
        "derivable",
        "ephemeral",
        "re-executable",
      ]);
      const stats = await store.stats();
      expect(stats.records).toBe(3);
      expect(stats.storage_classes.derivable.records).toBe(1);
      expect(stats.storage_classes.derivable.bytes).toBeLessThan(500);
      expect(stats.storage_classes["re-executable"].records).toBe(1);
      expect(stats.storage_classes["re-executable"].bytes).toBeGreaterThan(15);
      expect(stats.storage_classes["re-executable"].bytes).toBeLessThan(500);
      expect(stats.storage_classes.ephemeral.records).toBe(1);
      expect(stats.storage_classes.ephemeral.raw_bytes).toBe(11);
      expect(stats.storage_classes.ephemeral.bytes).toBeLessThan(100);
      expect(stats.bytes).toBe(
        stats.storage_classes.derivable.bytes +
          stats.storage_classes["re-executable"].bytes +
          stats.storage_classes.ephemeral.bytes,
      );
    } finally {
      process.chdir(previousCwd);
      await store.close();
    }
  });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}
