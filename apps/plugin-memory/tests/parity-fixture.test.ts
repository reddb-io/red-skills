import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { exportGraph } from "../src/export.js";
import { MemoryStore } from "../src/graph-store.js";
import { ingestProject } from "../src/ingest.js";
import type { Confidence } from "../src/schema.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "fixtures/parity-corpus");
const SEAL_VOCABULARY: readonly Confidence[] = ["AMBIGUOUS", "EXTRACTED", "INFERRED"];

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "memory-parity-fixture-"));
  roots.push(dir);
  const store = await MemoryStore.open({
    uri: `file://${join(dir, "graph.rdb")}`,
    project: "parity-fixture",
  });
  stores.push(store);
  return { store, dir };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function sealDistribution(items: Array<{ properties?: { confidence?: unknown } }>) {
  const distribution = Object.fromEntries(SEAL_VOCABULARY.map((seal) => [seal, 0])) as Record<
    Confidence,
    number
  >;
  for (const item of items) {
    const seal = item.properties?.confidence ?? "AMBIGUOUS";
    if (seal === "EXTRACTED" || seal === "INFERRED" || seal === "AMBIGUOUS") {
      distribution[seal] += 1;
    }
  }
  return distribution;
}

describe("ADR 0096 parity fixture", () => {
  test(
    "ingests a code+docs corpus end-to-end with golden graph-structure assertions",
    async () => {
      const providerJson = JSON.stringify({
        facts: [
          {
            label: "session-gate",
            node_type: "workflow",
            title: "Session gate",
            summary: "Session enables checkout.",
            relations: [{ label: "ENABLES", target: "checkout-flow" }],
          },
          {
            label: "checkout-flow",
            node_type: "workflow",
            title: "Checkout flow",
            summary: "Checkout creates orders.",
          },
        ],
      });
      const provider = {
        async complete() {
          return providerJson;
        },
      };
      const { store, dir } = await openStore();

      const report = await ingestProject(store, {
        cwd: CORPUS,
        semantic: { enabled: true, client: provider, source: "adr-0096-parity-fixture" },
      });
      const result = await exportGraph(store, join(dir, "export"), {
        communities: true,
        now: Date.UTC(2026, 6, 10),
      });
      const graph = JSON.parse(await readFile(result.jsonPath, "utf8")) as {
        stats: { nodes: number; edges: number };
        nodes: Array<{
          node_type: string;
          community: string | null;
          properties: { confidence?: unknown };
        }>;
        edges: Array<{ properties: { confidence?: unknown } }>;
      };

      // ADR 0096 parity lane: this fixture exercises the absorbed corpus graph
      // pipeline over checked-in code+docs, including structural extraction,
      // provider-routed semantic extraction, audit seals, and native communities.
      expect(report.files).toBe(2);
      expect(report.semantic).toMatchObject({ enabled: true, nodes: 2, edges: 1 });
      expect(graph.stats).toEqual({ nodes: 8, edges: 6 });
      expect(new Set(graph.nodes.map((node) => node.community)).size).toBe(3);
      expect(Object.keys(sealDistribution(graph.nodes)).sort()).toEqual([...SEAL_VOCABULARY].sort());
      expect(sealDistribution(graph.nodes)).toEqual({
        AMBIGUOUS: 0,
        EXTRACTED: 6,
        INFERRED: 2,
      });
      expect(sealDistribution(graph.edges)).toEqual({
        AMBIGUOUS: 2,
        EXTRACTED: 3,
        INFERRED: 1,
      });
    },
    TIMEOUT,
  );
});
