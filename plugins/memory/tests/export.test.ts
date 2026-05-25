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
      await store.upsertDoc({
        path: "docs/auth.md",
        title: "Auth Guide",
        body: "JWT rotation details live in this document body and should not be fully exported.",
        frontmatter: { tags: ["auth"] },
        hash: "auth-doc-hash",
        updated_at: 123,
      });

      const out = join(dir, "export");
      const result = await exportGraph(store, out);

      expect(result.nodes).toBe(2);
      expect(result.edges).toBe(1);

      const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
      expect(json.nodes).toHaveLength(2);
      expect(json.edges).toHaveLength(1);
      expect(json.stats.nodes).toBe(2);
      expect(json.docs).toEqual([
        expect.objectContaining({
          path: "docs/auth.md",
          title: "Auth Guide",
          body_length: 81,
        }),
      ]);
      expect(JSON.stringify(json.docs)).not.toContain("should not be fully exported");
      expect(json.vector_projection).toMatchObject({
        overall: "unavailable",
        total: 3,
        nodes: expect.arrayContaining([
          expect.objectContaining({ source_collection: "memory_nodes" }),
        ]),
        docs: [
          expect.objectContaining({
            path: "docs/auth.md",
            source_collection: "memory_docs",
            status: "unavailable",
          }),
        ],
      });

      const html = await readFile(result.htmlPath, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("jwt rotation");
      expect(html).toContain("Vector projection");
      expect(html).toContain("Documents");
      expect(html).toContain("docs/auth.md");
      expect(html).not.toContain("should not be fully exported");
      // Data is inlined — no network fetch needed to navigate.
      expect(html).toContain('id="data"');

      const audit = await readFile(result.auditPath, "utf8");
      expect(audit).toContain("# Memory graph audit");
      expect(audit).toContain("REFERENCES");
      expect(audit).toContain("Nodes by type");
      expect(audit).toContain("Documents");
      expect(audit).toContain("Vector projection");
      expect(audit).toContain("docs/auth.md");
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

  test(
    "dashboard export exposes health, evidence status, conflicts, and context preview",
    async () => {
      const { store, dir } = await openStore();
      const now = Date.now();
      const active = await store.upsertNode({
        label: "current-guidance",
        node_type: "decision",
        properties: {
          title: "current deploy guidance",
          content: "Deploys happen on Tuesday.",
          confidence: "EXTRACTED",
        },
      });
      const superseded = await store.upsertNode({
        label: "old-guidance",
        node_type: "decision",
        properties: {
          title: "old deploy guidance",
          content: "Deploys happen on Friday.",
          confidence: "INFERRED",
        },
      });
      const stale = await store.upsertNode({
        label: "stale-guidance",
        node_type: "concept",
        properties: {
          title: "stale reminder",
          content: "This reminder has not been recalled.",
          confidence: "EXTRACTED",
        },
      });
      const ambiguous = await store.upsertNode({
        label: "unclear-guidance",
        node_type: "concept",
        properties: {
          title: "unclear rollout window",
          content: "The rollout window may be Wednesday.",
          confidence: "AMBIGUOUS",
        },
      });
      await store.supersede(superseded, active, "Tuesday replaced Friday");
      await store.upsertEdge({
        label: "CONTRADICTS",
        from_rid: active,
        to_rid: ambiguous,
        properties: { reason: "different rollout window" },
      });
      await store.recordAccess([active, superseded, ambiguous]);

      const result = await exportGraph(store, join(dir, "export"), {
        now: now + 91 * 24 * 60 * 60 * 1000,
      });

      const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
      expect(json.health).toMatchObject({
        state: "needs-attention",
        total_nodes: 4,
        total_edges: 2,
        stale_nodes: 1,
        superseded_nodes: 1,
        unresolved_contradictions: 1,
        ambiguous_nodes: 1,
      });
      expect(json.evidence.active.map((n: { rid: number }) => n.rid)).toContain(active);
      expect(json.evidence.superseded).toEqual([
        expect.objectContaining({ rid: superseded, active_rid: active }),
      ]);
      expect(json.evidence.stale).toEqual([expect.objectContaining({ rid: stale })]);
      expect(json.evidence.ambiguous).toEqual([expect.objectContaining({ rid: ambiguous })]);
      expect(json.contradictions).toEqual([
        expect.objectContaining({
          from_rid: active,
          to_rid: ambiguous,
          reason: "different rollout window",
          resolved: false,
        }),
      ]);
      expect(json.context_pack_preview).toMatchObject({
        representative_goal: "Preview active Memory evidence from this export",
      });
      expect(json.context_pack_preview.context_md).toContain("current deploy guidance");

      const html = await readFile(result.htmlPath, "utf8");
      expect(html).toContain("Memory health");
      expect(html).toContain("needs-attention");
      expect(html).toContain("Contradictions");
      expect(html).toContain("Tuesday replaced Friday");
      expect(html).toContain("Context pack preview");
      expect(html).toContain("stale reminder");

      const audit = await readFile(result.auditPath, "utf8");
      expect(audit).toContain("Memory health");
      expect(audit).toContain("Unresolved contradictions:** 1");
      expect(audit).toContain("Context pack preview");
    },
    TIMEOUT,
  );

  test(
    "interop export writes JSONL, GraphML, and Neo4j Cypher artifacts",
    async () => {
      const { store, dir } = await openStore();
      const auth = await store.upsertNode({
        label: "auth-service",
        node_type: "concept",
        properties: {
          title: "Auth service",
          content: "Owns token policy.",
          confidence: "EXTRACTED",
        },
      });
      const jwt = await store.upsertNode({
        label: "jwt-rotation",
        node_type: "decision",
        properties: {
          title: "JWT rotation",
          content: "Rotate keys every 90 days.",
          confidence: "EXTRACTED",
        },
      });
      await store.upsertEdge({
        label: "REFERENCES",
        from_rid: auth,
        to_rid: jwt,
        properties: { reason: "policy source" },
      });

      const result = await exportGraph(store, join(dir, "export"), { interop: true });

      expect(result.interop).toEqual({
        nodesJsonlPath: join(dir, "export", "nodes.jsonl"),
        edgesJsonlPath: join(dir, "export", "edges.jsonl"),
        graphmlPath: join(dir, "export", "graph.graphml"),
        cypherPath: join(dir, "export", "neo4j.cypher"),
      });
      const nodesJsonl = await readFile(result.interop!.nodesJsonlPath, "utf8");
      const nodeLines = nodesJsonl.trim().split("\n").map((line) => JSON.parse(line));
      expect(nodeLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rid: auth,
            label: "auth-service",
            node_type: "concept",
            evidence_statuses: ["active"],
          }),
        ]),
      );
      const edgesJsonl = await readFile(result.interop!.edgesJsonlPath, "utf8");
      expect(JSON.parse(edgesJsonl.trim())).toMatchObject({
        label: "REFERENCES",
        from: auth,
        to: jwt,
        properties: { reason: "policy source" },
      });
      const graphml = await readFile(result.interop!.graphmlPath, "utf8");
      expect(graphml).toContain("<graphml");
      expect(graphml).toContain('source="memory_nodes:');
      expect(graphml).toContain("auth-service");
      expect(graphml).toContain("REFERENCES");
      const cypher = await readFile(result.interop!.cypherPath, "utf8");
      expect(cypher).toContain("CREATE CONSTRAINT memory_node_rid");
      expect(cypher).toContain("MERGE (n:MemoryNode:Concept");
      expect(cypher).toContain("MERGE (a)-[r:REFERENCES");
      expect(cypher).toContain("RedDB remains the source of truth");

      const plain = await exportGraph(store, join(dir, "plain"));
      expect(plain.interop).toBeUndefined();
    },
    TIMEOUT,
  );
});
