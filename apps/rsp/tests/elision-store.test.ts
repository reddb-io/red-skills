import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RSP_BYTE_BUDGET,
  DEFAULT_RSP_TTL_DAYS,
  RSP_ELISION_COLLECTION,
  RspElisionStore,
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

describe("RspElisionStore", () => {
  it("stores derivable handles as git object recipes and re-derives byte-identical output", async () => {
    const root = await tempRoot();
    git(root, ["init"]);
    git(root, ["config", "user.email", "agent@example.invalid"]);
    git(root, ["config", "user.name", "Agent"]);
    await writeFile(join(root, "tracked.txt"), "tracked content\n", "utf8");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "seed"]);

    const storePath = join(root, "store.rdb");
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

      const raw = JSON.parse(await readFile(storePath, "utf8")) as {
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

    const storePath = join(root, "store.rdb");
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
      const raw = JSON.parse(await readFile(storePath, "utf8")) as {
        records: Record<string, { derivation_recipe?: { object_ids?: string[] } }>;
      };
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
      expect(stats.storage_classes.derivable).toEqual({ records: 1, bytes: stats.bytes });
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

  it("expires records by TTL on amortized write and reports the original command", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    const root = await tempRoot();
    const store = await RspElisionStore.open({
      uri: `file://${join(root, "red.rdb")}`,
      ttlDays: 1,
      now: () => now,
    });
    try {
      const handle = await store.mint(Buffer.from("old output"), {
        command: "old command",
        loss: { level: "terse", bytes_elided: 10 },
      });

      now = new Date("2026-07-12T12:00:00.000Z");
      await store.mint(Buffer.from("new output"), {
        command: "new command",
        loss: { level: "terse", bytes_elided: 10 },
      });

      expect(await store.get(handle)).toEqual({
        status: "expired",
        expired_at: "2026-07-11T12:00:00.000Z",
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
      byteBudget: 10,
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
        bytes: 3,
        oldest: "2026-07-10T12:00:00.000Z",
        budget: DEFAULT_RSP_BYTE_BUDGET,
        storage_classes: {
          derivable: { records: 0, bytes: 0 },
          "re-executable": { records: 0, bytes: 0 },
          ephemeral: { records: 1, bytes: 3 },
        },
      });
      expect(DEFAULT_RSP_TTL_DAYS).toBe(7);
    } finally {
      await store.close();
    }
  });

  it("records exactly one storage class per minted handle and reports the class breakdown", async () => {
    const root = await tempRoot();
    const storePath = join(root, "red.rdb");
    const store = await RspElisionStore.open({
      uri: `file://${storePath}`,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      await store.mint(Buffer.from("git history"), {
        command: "git log --oneline",
        loss: { level: "terse", bytes_elided: 11 },
      });
      await store.mint(Buffer.from("remote pr"), {
        command: "gh pr view 42",
        loss: { level: "brief", bytes_elided: 9 },
      });
      await store.mint(Buffer.from("test output"), {
        command: "vitest run",
        loss: { level: "terse", bytes_elided: 11 },
      });

      const raw = JSON.parse(await readFile(storePath, "utf8")) as {
        index: { records: Array<{ storage_class?: string }> };
        records: Record<string, { storage_class?: string }>;
      };
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
      expect(stats.storage_classes["re-executable"]).toEqual({ records: 1, bytes: 9 });
      expect(stats.storage_classes.ephemeral).toEqual({ records: 1, bytes: 11 });
      expect(stats.bytes).toBe(
        stats.storage_classes.derivable.bytes +
          stats.storage_classes["re-executable"].bytes +
          stats.storage_classes.ephemeral.bytes,
      );
    } finally {
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
