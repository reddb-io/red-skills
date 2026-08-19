import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { diagnose } from "../src/doctor.js";
import { MemoryStore } from "../src/graph-store.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;
const DAY = 86_400_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(opts: { ephemeralTtlMs?: number } = {}): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-tier-"));
  roots.push(dir);
  const store = await MemoryStore.open({
    uri: `file://${join(dir, "graph.rdb")}`,
    project: "test",
    ...opts,
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("memory tier (#68)", () => {
  test(
    "an ephemeral node expires past its TTL horizon and survives before it",
    async () => {
      const store = await openStore({ ephemeralTtlMs: DAY });
      const createdAt = Date.now();
      const rid = await store.upsertNode({
        label: "session-msg",
        node_type: "session",
        properties: { title: "session message", content: "transient", created_at: createdAt },
      });

      // Default tier for `session` is ephemeral → carries a TTL horizon.
      const live = await store.getNode(rid);
      expect(live?.properties.tier).toBe("ephemeral");
      expect(live?.properties.expires_at).toBe(createdAt + DAY);

      // Before the horizon: still listed.
      const before = await store.listNodes(createdAt + DAY - 1);
      expect(before.map((n) => n.rid)).toContain(rid);

      // At/after the horizon: gone from every read path that observes that time.
      const after = await store.listNodes(createdAt + DAY + 1);
      expect(after.map((n) => n.rid)).not.toContain(rid);
    },
    TIMEOUT,
  );

  test(
    "durable and reasoning nodes carry no TTL and persist indefinitely",
    async () => {
      const store = await openStore({ ephemeralTtlMs: DAY });
      const createdAt = Date.now();
      const durable = await store.upsertNode({
        label: "a-fact",
        node_type: "concept",
        properties: { title: "a durable fact", content: "facts persist", created_at: createdAt },
      });
      const reasoning = await store.upsertNode({
        label: "a-trace",
        node_type: "why_note",
        properties: { title: "a reasoning trace", content: "why we did it", created_at: createdAt },
      });

      const d = await store.getNode(durable);
      const r = await store.getNode(reasoning);
      expect(d?.properties.tier).toBe("durable");
      expect(r?.properties.tier).toBe("reasoning");
      expect(d?.properties.expires_at).toBeUndefined();
      expect(r?.properties.expires_at).toBeUndefined();

      // Far past any ephemeral horizon, both are still present.
      const live = (await store.listNodes(createdAt + 365 * DAY)).map((n) => n.rid);
      expect(live).toContain(durable);
      expect(live).toContain(reasoning);
    },
    TIMEOUT,
  );

  test(
    "an explicit tier on write overrides the node_type default",
    async () => {
      const store = await openStore();
      // A `concept` would default to durable; pin it ephemeral instead.
      const rid = await store.upsertNode({
        label: "pinned-ephemeral",
        node_type: "concept",
        properties: { title: "forced ephemeral", content: "x", tier: "ephemeral" },
      });
      const node = await store.getNode(rid);
      expect(node?.properties.tier).toBe("ephemeral");
      expect(typeof node?.properties.expires_at).toBe("number");
    },
    TIMEOUT,
  );

  test(
    "doctor flags a stale durable node but never an ephemeral one, and never deletes",
    async () => {
      const store = await openStore({ ephemeralTtlMs: 365 * DAY });
      const createdAt = Date.now();
      const durable = await store.upsertNode({
        label: "cold-fact",
        node_type: "concept",
        properties: { title: "cold durable fact", content: "nobody reads", created_at: createdAt },
      });
      // Ephemeral, unaccessed and old — but the doctor must not flag it; TTL owns it.
      await store.upsertNode({
        label: "old-session",
        node_type: "session",
        properties: { title: "old session", content: "chatter", created_at: createdAt },
      });

      const report = await diagnose(store, { staleDays: 90, now: createdAt + 91 * DAY });
      const flagged = report.stale.map((s) => s.rid);
      expect(flagged).toContain(durable);
      expect(report.stale).toHaveLength(1);

      // diagnose is read-only — both nodes are still present afterwards.
      expect((await store.listNodes(createdAt + 91 * DAY)).map((n) => n.rid)).toContain(durable);
    },
    TIMEOUT,
  );
});
