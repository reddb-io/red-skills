import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { diagnose, prune } from "../src/doctor.js";
import { recall } from "../src/engine.js";
import { MemoryStore } from "../src/graph-store.js";

const TIMEOUT = 30_000;
const DAY = 86_400_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-doctor-"));
  roots.push(dir);
  const store = await MemoryStore.open({
    uri: `file://${join(dir, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("doctor", () => {
  test(
    "flags a node unaccessed past the threshold and never recalled",
    async () => {
      const store = await openStore();
      const rid = await store.upsertNode({
        label: "old-fact",
        node_type: "concept",
        properties: { title: "old fact", content: "something nobody reads" },
      });

      // The node was created `now`; pretend we're 91 days in the future.
      const report = await diagnose(store, { staleDays: 90, now: Date.now() + 91 * DAY });
      const rids = report.stale.map((s) => s.rid);
      expect(rids).toContain(rid);
      expect(report.totalNodes).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "a recalled node is no longer stale (access decay)",
    async () => {
      const store = await openStore();
      await store.upsertNode({
        label: "warm-fact",
        node_type: "concept",
        properties: { title: "warm fact", content: "redis cache ttl is 300 seconds" },
      });

      // Recall bumps the access overlay → access_count > 0 → exempt from stale.
      await recall(store, "redis cache ttl");

      const report = await diagnose(store, { staleDays: 90, now: Date.now() + 91 * DAY });
      expect(report.stale).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    "pinned nodes are never stale",
    async () => {
      const store = await openStore();
      await store.upsertNode({
        label: "pinned-fact",
        node_type: "decision",
        properties: { title: "pinned fact", content: "we always do this", importance: 0.9 },
      });

      const report = await diagnose(store, { staleDays: 90, now: Date.now() + 365 * DAY });
      expect(report.stale).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    "fresh nodes are not flagged",
    async () => {
      const store = await openStore();
      await store.upsertNode({
        label: "new-fact",
        node_type: "concept",
        properties: { title: "new fact", content: "just stored" },
      });

      const report = await diagnose(store, { staleDays: 90 });
      expect(report.stale).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    "prune deletes only the confirmed stale nodes",
    async () => {
      const store = await openStore();
      const stale = await store.upsertNode({
        label: "stale-fact",
        node_type: "concept",
        properties: { title: "stale fact", content: "delete me" },
      });
      const keep = await store.upsertNode({
        label: "keep-fact",
        node_type: "concept",
        properties: { title: "keep fact", content: "redis cache ttl is 300 seconds" },
      });
      await recall(store, "redis cache ttl"); // keep-fact gets accessed

      const report = await diagnose(store, { staleDays: 90, now: Date.now() + 91 * DAY });
      expect(report.stale.map((s) => s.rid)).toEqual([stale]);

      const { pruned } = await prune(store, report.stale);
      expect(pruned).toBe(1);

      const remaining = (await store.listNodes()).map((n) => n.rid);
      expect(remaining).toContain(keep);
      expect(remaining).not.toContain(stale);
    },
    TIMEOUT,
  );
});
