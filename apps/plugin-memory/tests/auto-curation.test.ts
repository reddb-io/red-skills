import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  readAutoCureRunLog,
  runAutoCure,
} from "../src/auto-curation.js";
import { MemoryStore } from "../src/graph-store.js";

const TIMEOUT = 30_000;
const DAY = 86_400_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-autocure-"));
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

describe("auto-curation", () => {
  test(
    "dry-run returns proposals without mutating",
    async () => {
      const store = await openStore();
      const oldRid = await store.upsertNode({
        label: "deploy-friday",
        node_type: "decision",
        properties: {
          title: "deploys happen friday",
          content: "deploy policy A",
          created_at: Date.now() - 10 * DAY,
        },
      });
      const newRid = await store.upsertNode({
        label: "deploy-tuesday",
        node_type: "decision",
        properties: {
          title: "deploys happen tuesday",
          content: "deploy policy B",
          created_at: Date.now(),
        },
      });
      await store.upsertEdge({
        from_rid: oldRid,
        to_rid: newRid,
        label: "CONTRADICTS",
        properties: { reason: "date changed" },
      });

      const report = await runAutoCure(store);

      expect(report.schema_version).toBe("memory.autocure.v1");
      expect(report.dry_run).toBe(true);
      expect(report.actions_proposed.length).toBeGreaterThan(0);
      expect(report.actions_applied).toEqual([]);
      expect(
        report.actions_proposed.some((a) => a.kind === "supersede-contradiction"),
      ).toBe(true);
      // No mutation: SUPERSEDED_BY map still empty for the loser rid.
      expect(await store.supersededBy(oldRid)).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "apply mutates per proposal and reduces entropy on a noisy fixture",
    async () => {
      const store = await openStore();
      const oldRid = await store.upsertNode({
        label: "policy-old",
        node_type: "decision",
        properties: {
          title: "old policy",
          content: "we deploy on friday",
          created_at: Date.now() - 30 * DAY,
        },
      });
      const newRid = await store.upsertNode({
        label: "policy-new",
        node_type: "decision",
        properties: {
          title: "new policy",
          content: "we deploy on tuesday",
          created_at: Date.now(),
        },
      });
      await store.upsertEdge({
        from_rid: oldRid,
        to_rid: newRid,
        label: "CONTRADICTS",
        properties: { reason: "policy moved" },
      });

      const report = await runAutoCure(store, { apply: true });

      expect(report.dry_run).toBe(false);
      expect(report.actions_applied.length).toBeGreaterThan(0);
      expect(report.entropy_after).toBeLessThan(report.entropy_before);
      // The loser is now superseded by the winner in the persisted store.
      expect(await store.supersededBy(oldRid)).toBe(newRid);
    },
    TIMEOUT,
  );

  test(
    "claim-guarded nodes never appear in actions_applied under any input",
    async () => {
      const store = await openStore();
      const guardedOld = await store.upsertNode({
        label: "guarded-old",
        node_type: "decision",
        properties: {
          title: "guarded old",
          content: "claim-anchored statement",
          created_at: Date.now() - 30 * DAY,
          claim_guard: true,
        },
      });
      const newer = await store.upsertNode({
        label: "guarded-new",
        node_type: "decision",
        properties: {
          title: "guarded new",
          content: "newer counter statement",
          created_at: Date.now(),
        },
      });
      await store.upsertEdge({
        from_rid: guardedOld,
        to_rid: newer,
        label: "CONTRADICTS",
      });

      const apply = await runAutoCure(store, { apply: true });
      const guardedRids = new Set([guardedOld]);

      // Nothing applied touched a claim-guarded rid …
      for (const action of apply.actions_applied) {
        expect(guardedRids.has(action.target.rid)).toBe(false);
        if (action.with) expect(guardedRids.has(action.with.rid)).toBe(false);
      }
      // … and the action that *would have* run is recorded in the skipped list.
      expect(
        apply.skipped_claim_guarded.some(
          (a) =>
            a.skipped === "claim-guarded" &&
            (a.target.rid === guardedOld || a.with?.rid === guardedOld),
        ),
      ).toBe(true);
      // Persisted graph confirms: guarded node is still active (not superseded).
      expect(await store.supersededBy(guardedOld)).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "report carries per-kind breakdown and persists a run log entry",
    async () => {
      const store = await openStore();
      await store.upsertNode({
        label: "lonely",
        node_type: "concept",
        properties: { title: "lonely fact", content: "nobody contradicts me" },
      });

      const dryReport = await runAutoCure(store);
      expect(dryReport.by_kind).toMatchObject({
        "dedupe-supersede": { proposed: 0, applied: 0 },
        "supersede-contradiction": { proposed: 0, applied: 0 },
      });

      const log = await readAutoCureRunLog(store);
      expect(log.entries.length).toBeGreaterThanOrEqual(1);
      const tail = log.entries[log.entries.length - 1]!;
      expect(tail.dry_run).toBe(true);
      expect(tail.entropy_before).toBeGreaterThanOrEqual(0);
      expect(tail.entropy_after).toBeGreaterThanOrEqual(0);
    },
    TIMEOUT,
  );
});
