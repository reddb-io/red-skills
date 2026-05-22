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
    "--communities colours nodes by native Louvain cluster",
    async () => {
      const { store, dir } = await openStore();
      // Two triangles joined by a single bridge edge → two communities.
      const mk = (l: string) =>
        store.upsertNode({ label: l, node_type: "concept", properties: { title: l, content: l } });
      const [a, b, c, x, y, z] = await Promise.all(["a", "b", "c", "x", "y", "z"].map(mk));
      const e = (from: number, to: number) =>
        store.upsertEdge({ label: "REFERENCES", from_rid: from, to_rid: to });
      await e(a, b); await e(b, c); await e(c, a);
      await e(x, y); await e(y, z); await e(z, x);
      await e(c, x); // bridge

      const result = await exportGraph(store, join(dir, "export"), { communities: true });

      const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
      const byRid: Record<number, string | null> = Object.fromEntries(
        json.nodes.map((n: { rid: number; community: string | null }) => [n.rid, n.community]),
      );
      // Every node carries a community id, and exactly two distinct clusters formed.
      for (const rid of [a, b, c, x, y, z]) expect(byRid[rid]).toBeTypeOf("string");
      const distinct = new Set(Object.values(byRid));
      expect(distinct.size).toBe(2);
      // The triangles split: a/b/c agree, x/y/z agree, and the two differ.
      expect(byRid[a]).toBe(byRid[b]);
      expect(byRid[b]).toBe(byRid[c]);
      expect(byRid[x]).toBe(byRid[y]);
      expect(byRid[y]).toBe(byRid[z]);
      expect(byRid[a]).not.toBe(byRid[x]);

      // graph.html carries a colour palette keyed by community id.
      const html = await readFile(result.htmlPath, "utf8");
      expect(html).toContain('"palette"');
      expect(html).toContain("hsl(");

      // Default export (no flag) stays community-free.
      const plain = await exportGraph(store, join(dir, "plain"));
      const plainJson = JSON.parse(await readFile(plain.jsonPath, "utf8"));
      expect(plainJson.nodes[0]).not.toHaveProperty("community");
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
