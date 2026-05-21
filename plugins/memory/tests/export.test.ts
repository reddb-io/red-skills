import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportGraph } from "../src/export.js";
import { MemoryStore } from "../src/graph-store.js";

const TIMEOUT = 30_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "memory-export-"));
  roots.push(dir);
  const store = await MemoryStore.open({
    uri: `file://${join(dir, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return { store, dir };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("export", () => {
  test(
    "emits graph.json + graph.html + audit.md",
    async () => {
      const { store, dir } = await openStore();
      const auth = await store.upsertNode({
        label: "auth-service",
        node_type: "concept",
        properties: { title: "auth service", content: "issues jwt tokens" },
      });
      const jwt = await store.upsertNode({
        label: "jwt-rotation",
        node_type: "concept",
        properties: { title: "jwt rotation", content: "rotate every 90 days" },
      });
      await store.upsertEdge({ label: "REFERENCES", from_rid: auth, to_rid: jwt });

      const out = join(dir, "export");
      const result = await exportGraph(store, out);

      expect(result.nodes).toBe(2);
      expect(result.edges).toBe(1);

      const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
      expect(json.nodes).toHaveLength(2);
      expect(json.edges).toHaveLength(1);
      expect(json.stats.nodes).toBe(2);

      const html = await readFile(result.htmlPath, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("jwt rotation");
      // Data is inlined — no network fetch needed to navigate.
      expect(html).toContain('id="data"');

      const audit = await readFile(result.auditPath, "utf8");
      expect(audit).toContain("# Memory graph audit");
      expect(audit).toContain("REFERENCES");
      expect(audit).toContain("Nodes by type");
    },
    TIMEOUT,
  );

  test(
    "audit reports orphan nodes",
    async () => {
      const { store, dir } = await openStore();
      await store.upsertNode({
        label: "lonely",
        node_type: "concept",
        properties: { title: "lonely note", content: "no edges" },
      });

      const result = await exportGraph(store, join(dir, "export"));
      const audit = await readFile(result.auditPath, "utf8");
      expect(audit).toContain("Orphan nodes (no edges):** 1");
    },
    TIMEOUT,
  );
});
