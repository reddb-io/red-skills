import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_L2_BYTE_BUDGET,
  DEFAULT_L2_TTL_MS,
  resolveL2Policy,
} from "../src/config.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { readMemoryEvents } from "../src/memory-events.js";
import { start as sessionStart } from "../src/session-manager.js";
import { appendEvent, setRawTranscript } from "../src/working-memory.js";
import { evictL2 } from "../src/working-memory-evict.js";

const TIMEOUT = 60_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-evict-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("L2 eviction policy", () => {
  test("resolveL2Policy returns documented defaults when config is empty", () => {
    expect(resolveL2Policy(null)).toEqual({
      ttlMs: DEFAULT_L2_TTL_MS,
      byteBudget: DEFAULT_L2_BYTE_BUDGET,
    });
    expect(DEFAULT_L2_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_L2_BYTE_BUDGET).toBe(16 * 1024 * 1024);
  });

  test("resolveL2Policy honors config overrides and ignores garbage values", () => {
    expect(
      resolveL2Policy({
        version: 1,
        mode: "graph",
        notesDir: ".",
        hooks: { sessionStart: false, postToolUse: false, stop: false, preCompact: false },
        mcp: false,
        reddb: true,
        l2: { ttlMs: 5_000, byteBudget: 1024 },
      } as any),
    ).toEqual({ ttlMs: 5_000, byteBudget: 1024 });
    expect(
      resolveL2Policy({
        version: 1,
        mode: "graph",
        notesDir: ".",
        hooks: { sessionStart: false, postToolUse: false, stop: false, preCompact: false },
        mcp: false,
        reddb: true,
        l2: { ttlMs: -1, byteBudget: 0 },
      } as any),
    ).toEqual({ ttlMs: DEFAULT_L2_TTL_MS, byteBudget: DEFAULT_L2_BYTE_BUDGET });
  });
});

describe("evictL2 sweep", () => {
  test(
    "reaps L2 events past TTL, leaves L3 alone, emits one evict event per node",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "sess-ttl" });
      const store = await openStore(root);

      // L2 events appended now
      const t0 = Date.now();
      for (let i = 1; i <= 3; i++) {
        await appendEvent(store, root, { type: "tool_call", value: `payload-${i}` });
      }
      // Add an L3 node — must never be touched.
      const l3rid = await store.upsertNode({
        label: "durable-fact",
        node_type: "decision",
        properties: { title: "stays", content: "L3 fact", layer: "L3" },
      });

      // First sweep: TTL=24h, now=t0+10h → all events still in window, no eviction.
      const r1 = await evictL2(store, { ttlMs: 24 * 60 * 60 * 1000, now: t0 + 10 * 60 * 60 * 1000 });
      expect(r1.evicted).toHaveLength(0);

      // Second sweep: TTL=1h, now=t0+10h → all 3 events reaped, L3 survives.
      const r2 = await evictL2(store, {
        ttlMs: 60 * 60 * 1000,
        now: t0 + 10 * 60 * 60 * 1000,
      });
      expect(r2.evicted.length).toBeGreaterThanOrEqual(3);
      expect(r2.evicted.every((e) => e.reason === "ttl")).toBe(true);

      const remaining = await store.listNodes();
      expect(remaining.find((n) => n.rid === l3rid)).toBeDefined();
      const l2Remaining = remaining.filter((n) => n.properties.layer === "L2" && n.properties.working_kind === "event");
      expect(l2Remaining).toHaveLength(0);

      // Evict events landed on mem.events
      const events = await readMemoryEvents(store);
      const evictEvents = events.filter(
        (e: any) => e.payload?.event_type === "engine.op" && e.payload?.op === "evict",
      );
      expect(evictEvents.length).toBeGreaterThanOrEqual(3);
      for (const e of evictEvents) {
        expect((e as any).payload.layer).toBe("L2");
        expect((e as any).payload.outcome).toBe("succeeded");
      }
    },
    TIMEOUT,
  );

  test(
    "byte budget evicts oldest events per session, transcript survives, L3 untouched",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "sess-budget" });
      const store = await openStore(root);

      // Five ~200-byte events
      const blob = "x".repeat(200);
      for (let i = 1; i <= 5; i++) {
        await appendEvent(store, root, { type: "tool_call", value: blob });
      }
      // Plus a raw transcript that should survive the budget pass
      await setRawTranscript(store, root, "y".repeat(800));

      // L3 fact
      const l3rid = await store.upsertNode({
        label: "durable-rule",
        node_type: "decision",
        properties: { title: "rule", content: "stays", layer: "L3" },
      });

      // Budget = 500 bytes per session → at least the oldest 3 events should go
      const report = await evictL2(store, {
        ttlMs: Number.MAX_SAFE_INTEGER, // disable TTL pass
        byteBudget: 500,
      });
      expect(report.evicted.length).toBeGreaterThan(0);
      expect(report.evicted.every((e) => e.reason === "byte-budget")).toBe(true);

      const sess = report.by_session.find((s) => s.session_id === "sess-budget");
      expect(sess).toBeDefined();
      expect(sess!.byte_budget_triggered).toBe(true);
      expect(sess!.bytes_after).toBeLessThanOrEqual(500);

      const remaining = await store.listNodes();
      // L3 untouched
      expect(remaining.find((n) => n.rid === l3rid)).toBeDefined();
      // transcript survives
      const transcript = remaining.find(
        (n) => n.properties.layer === "L2" && n.properties.working_kind === "transcript",
      );
      expect(transcript).toBeDefined();
      // Surviving events are the most recent (highest sequence)
      const survivingEvents = remaining
        .filter((n) => n.properties.layer === "L2" && n.properties.working_kind === "event")
        .map((n) => Number(n.properties.sequence ?? 0))
        .sort((a, b) => a - b);
      if (survivingEvents.length > 0) {
        expect(Math.min(...survivingEvents)).toBeGreaterThan(1);
      }
    },
    TIMEOUT,
  );

  test("empty sweep emits no events and returns scanned_nodes=0", async () => {
    const root = await tempRoot();
    await initGraph(root);
    const store = await openStore(root);
    const report = await evictL2(store, { ttlMs: 1000, byteBudget: 1000 });
    expect(report.scanned_nodes).toBe(0);
    expect(report.evicted).toHaveLength(0);
  });
});
