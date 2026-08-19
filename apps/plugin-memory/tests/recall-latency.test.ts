import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { recall } from "../src/engine.js";
import { MemoryStore } from "../src/graph-store.js";

// Seeding ~1k nodes + repeated recalls spawns the bundled `red` binary heavily;
// give it generous room. The latency assertion itself targets <100ms p50.
const TIMEOUT = 180_000;
const GRAPH_SIZE = 1_000;
const P50_TARGET_MS = Number(process.env.RED_MEMORY_RECALL_P50_TARGET_MS ?? 100);

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-latency-"));
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

function p50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe("recall latency (#72)", () => {
  // Perf test is sensitive to host load; AFK feedback gates set RED_AFK_SKIP_PERF=1
  // to skip it without masking real regressions in dev or CI perf-tracking runs.
  const skipPerf = process.env.RED_AFK_SKIP_PERF === "1";
  (skipPerf ? test.skip : test)(
    "stays under target p50 on a ~1k-node graph",
    async () => {
      const store = await openStore();

      // ~1k nodes; every 50th carries the "needle" token so a realistic query
      // matches a small subset (not the whole graph), and a few needle nodes are
      // wired together so centrality has signal.
      const needles: number[] = [];
      for (let i = 0; i < GRAPH_SIZE; i++) {
        const needle = i % 50 === 0 ? " needle" : "";
        const rid = await store.upsertNode({
          label: `node-${i}`,
          node_type: "concept",
          properties: { title: `node ${i}`, content: `fact number ${i} about the system${needle}` },
        });
        if (needle) needles.push(rid);
      }
      for (let i = 1; i < needles.length; i++) {
        await store.upsertEdge({
          label: "REFERENCES",
          from_rid: needles[i - 1],
          to_rid: needles[i],
        });
      }

      // Warm up (cold first call includes one-time engine setup), then sample.
      await recall(store, "needle");
      const samples: number[] = [];
      for (let i = 0; i < 11; i++) {
        const start = performance.now();
        const { nodes } = await recall(store, "needle");
        samples.push(performance.now() - start);
        expect(nodes.length).toBeGreaterThan(0);
      }

      const median = p50(samples);
      expect(median).toBeLessThan(P50_TARGET_MS);
    },
    TIMEOUT,
  );
});
