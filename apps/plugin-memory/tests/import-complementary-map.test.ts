import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { importComplementaryMapFile } from "../src/import-complementary-map.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPHIFY_FIXTURE = resolve(HERE, "fixtures/complementary-map/graphify-map.json");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-map-import-"));
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

describe("complementary map import", () => {
  test(
    "imports a Graphify-like map into RedDB with provenance, confidence, freshness, and normalized edges",
    async () => {
      const store = await openStore();

      const report = await importComplementaryMapFile(store, GRAPHIFY_FIXTURE, {
        rootDir: HERE,
        sourceKind: "graphify",
        now: Date.parse("2026-06-07T00:00:00.000Z"),
      });

      expect(report).toMatchObject({
        destination: "RedDB",
        source_kind: "graphify",
        nodes: { input: 3, imported: 3, overlapped: 0, skipped: 0 },
        edges: { input: 2, imported: 2, overlapped: 0, skipped: 0 },
      });

      const nodes = await store.listNodes();
      const edges = await store.listEdges();
      expect(nodes).toHaveLength(3);
      expect(edges).toHaveLength(2);

      const authPath = resolve(HERE, "src/auth.ts");
      const authFile = nodes.find((node) => node.label === `file:${authPath}`);
      const authenticateUser = nodes.find(
        (node) => node.label === `sym:${authPath}#authenticateUser`,
      );
      const sessionStore = nodes.find((node) => node.label === `sym:${authPath}#SessionStore`);
      expect(authFile?.properties.provenance).toMatchObject({
        source_kind: "external-map",
        writer: "import-complementary-map",
        confidence: "EXTRACTED",
        map_source_kind: "graphify",
        freshness: { source_updated_at: Date.parse("2026-06-01T00:00:00.000Z") },
      });
      expect(authenticateUser?.properties).toMatchObject({
        map_source_kind: "graphify",
        map_source_id: "symbol:src/auth.ts#authenticateUser",
        map_node_kind: "function",
        map_confidence: 0.88,
        map_freshness: { source_updated_at: Date.parse("2026-06-01T00:00:00.000Z") },
      });

      expect(edges).toContainEqual(
        expect.objectContaining({
          from_rid: authenticateUser?.rid,
          to_rid: authFile?.rid,
          label: "DEFINED_IN",
        }),
      );
      const calls = edges.find(
        (edge) =>
          edge.from_rid === authenticateUser?.rid &&
          edge.to_rid === sessionStore?.rid &&
          edge.label === "CALLS",
      );
      const callProps = edgeProperties(calls);
      expect(Number(calls?.weight)).toBeCloseTo(0.86);
      expect(callProps).toEqual(
        expect.objectContaining({
          original_edge_kind: "CALLS",
          map_source_kind: "graphify",
          map_confidence: 0.8,
          map_salience: 0.9,
          map_weight_normalized: 0.86,
          provenance: expect.objectContaining({
            source_kind: "external-map",
            map_source_kind: "graphify",
          }),
        }),
      );
      expect(callProps.color).toBeUndefined();

      const statsAfterFirstImport = await store.stats();
      const second = await importComplementaryMapFile(store, GRAPHIFY_FIXTURE, {
        rootDir: HERE,
        sourceKind: "graphify",
        now: Date.parse("2026-06-07T00:00:00.000Z"),
      });
      expect(second.nodes).toMatchObject({ input: 3, imported: 0, overlapped: 3, skipped: 0 });
      expect(second.edges).toMatchObject({ input: 2, imported: 0, overlapped: 2, skipped: 0 });
      await expect(store.stats()).resolves.toEqual(statsAfterFirstImport);
    },
    TIMEOUT,
  );
});

function edgeProperties(edge: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties = edge?.properties ?? edge?.PROPERTIES;
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}
