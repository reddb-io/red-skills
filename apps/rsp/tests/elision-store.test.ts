import { mkdtemp, rm } from "node:fs/promises";
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
      await expect(store.stats()).resolves.toMatchObject({ records: 1, bytes: original.length });
    } finally {
      await store.close();
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
      });
      expect(DEFAULT_RSP_TTL_DAYS).toBe(7);
    } finally {
      await store.close();
    }
  });
});
