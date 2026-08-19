import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readConfig } from "../src/config.js";
import { graphRecall } from "../src/graph-recall.js";
import { MemoryStore, factToNode, rowToNode } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { slugify } from "../src/store.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;
const SOFT_MERGE_LABELS = ["SAME_AS", "MERGED_INTO"] as const;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-graph-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("rowToNode", () => {
  test("normalizes uppercase PROPERTIES and lowercase rid/label", () => {
    const node = rowToNode({
      rid: 42,
      label: "auth",
      node_type: "concept",
      PROPERTIES: { title: "auth", content: "jwt rotation" },
    });
    expect(node).toEqual({
      rid: 42,
      label: "auth",
      node_type: "concept",
      properties: { title: "auth", content: "jwt rotation" },
    });
  });
});

describe("MemoryStore over a file:// RedDB", () => {
  test(
    "CRUD: a stored node reads back by rid",
    async () => {
      const store = await openStore(await tempRoot());
      const rid = await store.upsertNode({
        label: "cache-ttl",
        node_type: "concept",
        properties: { title: "cache ttl", content: "the cache ttl is 300 seconds" },
      });
      expect(rid).toBeGreaterThan(0);

      const back = await store.getNode(rid);
      expect(back?.label).toBe("cache-ttl");
      expect(back?.properties.content).toContain("300 seconds");
    },
    TIMEOUT,
  );

  test(
    "dedupe: re-storing identical content returns the same rid",
    async () => {
      const store = await openStore(await tempRoot());
      const node = factToNode("postgres pool exhausted under load", slugify);

      const first = await store.upsertNode(node);
      const second = await store.upsertNode(node);
      expect(second).toBe(first);

      const { nodes } = await store.stats();
      expect(nodes).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "vector projection is best-effort when the embedding provider is unavailable",
    async () => {
      const store = await openStore(await tempRoot());
      const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
      process.env.RED_MEMORY_VECTOR_PROVIDER = "openai";
      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql.includes("WITH AUTO EMBED")) throw new Error("missing OPENAI_API_KEY");
        return query(sql, ...params);
      };

      try {
        const rid = await store.upsertNode(factToNode("vector readiness survives writes", slugify));

        await expect(store.getNode(rid)).resolves.toMatchObject({
          label: "vector-readiness-survives-writes",
        });
        await expect(store.vectorStatus()).resolves.toMatchObject({
          overall: "unavailable",
          ready: 0,
          unavailable: 1,
          failed: 0,
        });
      } finally {
        if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
        else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
      }
    },
    TIMEOUT,
  );

  test(
    "vector projection records link to nodes and reveal stale text hashes",
    async () => {
      const store = await openStore(await tempRoot());
      const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
      process.env.RED_MEMORY_VECTOR_PROVIDER = "openai";
      const vectorRows: Record<string, unknown>[] = [];
      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql.includes("WITH AUTO EMBED")) {
          const row = {
            rid: vectorRows.length + 1,
            node_rid: params[0],
            node_hash: params[1],
            text_hash: params[2],
            text: params[3],
            label: params[4],
            node_type: params[5],
            text_length: params[6],
            source_collection: params[7],
            project: params[8],
            provider: params[9],
            updated_at: params[10],
          };
          vectorRows.push(row);
          return { rows: [row] };
        }
        if (sql === "SELECT * FROM memory_vectors") return { rows: vectorRows };
        return query(sql, ...params);
      };

      try {
        const rid = await store.upsertNode(
          factToNode("vector records carry node metadata", slugify),
        );

        expect(vectorRows[0]).toMatchObject({
          node_rid: rid,
          label: "vector-records-carry-node-metadata",
          source_collection: "memory_nodes",
        });
        await expect(store.vectorStatus()).resolves.toMatchObject({
          overall: "ready",
          ready: 1,
        });

        vectorRows[0].text_hash = "old-text";
        await expect(store.vectorStatus()).resolves.toMatchObject({
          overall: "stale",
          stale: 1,
        });
      } finally {
        if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
        else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
      }
    },
    TIMEOUT,
  );

  test(
    "document chunks participate in vector projection readiness",
    async () => {
      const store = await openStore(await tempRoot());
      const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
      process.env.RED_MEMORY_VECTOR_PROVIDER = "openai";
      const vectorRows: Record<string, unknown>[] = [];
      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql.includes("WITH AUTO EMBED")) {
          const sourceCollection = String(params[8]);
          const row =
            sourceCollection === "memory_docs"
              ? {
                  rid: vectorRows.length + 1,
                  doc_rid: params[0],
                  node_hash: params[1],
                  text_hash: params[2],
                  text: params[3],
                  label: params[4],
                  path: params[5],
                  title: params[6],
                  text_length: params[7],
                  source_collection: params[8],
                  project: params[9],
                  provider: params[10],
                  updated_at: params[11],
                }
              : {
                  rid: vectorRows.length + 1,
                  node_rid: params[0],
                  node_hash: params[1],
                  text_hash: params[2],
                  text: params[3],
                  label: params[4],
                  node_type: params[5],
                  text_length: params[6],
                  source_collection: params[7],
                  project: params[8],
                  provider: params[9],
                  updated_at: params[10],
                };
          vectorRows.push(row);
          return { rows: [row] };
        }
        if (sql === "SELECT * FROM memory_vectors") return { rows: vectorRows };
        return query(sql, ...params);
      };

      try {
        const rid = await store.upsertDoc({
          path: "docs/security.md",
          title: "Security Guide",
          body: "JWT token rotation guidance lives in this document chunk.",
          frontmatter: { tags: ["security", "jwt"] },
          hash: "doc-hash-1",
          updated_at: 123,
        });

        expect(vectorRows[0]).toMatchObject({
          doc_rid: rid,
          label: "doc:docs/security.md",
          path: "docs/security.md",
          title: "Security Guide",
          source_collection: "memory_docs",
        });
        await expect(store.vectorStatus()).resolves.toMatchObject({
          overall: "ready",
          total: 1,
          ready: 1,
          nodes: [],
          docs: [
            expect.objectContaining({
              rid,
              path: "docs/security.md",
              title: "Security Guide",
              source_collection: "memory_docs",
              status: "ready",
            }),
          ],
        });

        vectorRows[0].text_hash = "old-doc-text";
        await expect(store.vectorStatus()).resolves.toMatchObject({
          overall: "stale",
          stale: 1,
          docs: [expect.objectContaining({ status: "stale" })],
        });
      } finally {
        if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
        else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
      }
    },
    TIMEOUT,
  );

  test(
    "vector search maps node rows and grounded document rows back to memory node rids",
    async () => {
      const store = await openStore(await tempRoot());
      const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
      process.env.RED_MEMORY_VECTOR_PROVIDER = "openai";
      const docRootRid = await store.upsertNode({
        label: "md:/repo/docs/jwt.md",
        node_type: "concept",
        properties: {
          title: "JWT docs",
          content: "document-root concept",
          hash: "doc-hash",
        },
      });
      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql.startsWith("SEARCH SIMILAR TEXT")) {
          expect(sql).toContain("COLLECTION memory_vectors");
          expect(sql).toContain("USING openai");
          expect(sql).toContain("LIMIT 3");
          return {
            rows: [
              { entity_id: 9, node_rid: 42, source_collection: "memory_nodes", similarity: 0.82 },
              {
                entity_id: 10,
                doc_rid: 7,
                node_hash: "doc-hash",
                source_collection: "memory_docs",
                similarity: 0.97,
              },
              {
                entity_id: 11,
                doc_rid: 8,
                node_hash: "orphan-doc-hash",
                source_collection: "memory_docs",
                similarity: 0.99,
              },
            ],
          };
        }
        return query(sql, ...params);
      };

      try {
        await expect(store.searchVector("semantic recall", 3)).resolves.toEqual([
          { rid: 42, score: 0.82 },
          { rid: docRootRid, score: 0.97 },
        ]);
      } finally {
        if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
        else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
      }
    },
    TIMEOUT,
  );

  test(
    "local vector provider stores deterministic embeddings in RedDB KV and searches them",
    async () => {
      const store = await openStore(await tempRoot());
      const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
      process.env.RED_MEMORY_VECTOR_PROVIDER = "local";
      try {
        const nodeRid = await store.upsertNode({
          label: "jwt-rotation",
          node_type: "decision",
          properties: {
            title: "JWT rotation",
            content: "JWT tokens rotate every 90 days for staging auth.",
            hash: "jwt-node-hash",
          },
        });
        const docRootRid = await store.upsertNode({
          label: "md:/repo/docs/jwt.md",
          node_type: "concept",
          properties: {
            title: "JWT docs",
            content: "document-root concept",
            hash: "doc-hash",
          },
        });
        await store.upsertDoc({
          path: "docs/jwt.md",
          title: "JWT docs",
          body: "The JWT document says tokens rotate every 90 days.",
          frontmatter: { tags: ["jwt", "auth"] },
          hash: "doc-hash",
          updated_at: 123,
        });

        await expect(store.vectorStatus()).resolves.toMatchObject({
          overall: "ready",
          total: 3,
          ready: 3,
          unavailable: 0,
          failed: 0,
        });
        const hits = await store.searchVector("jwt rotation tokens", 5);
        expect(hits.map((hit) => hit.rid)).toEqual(
          expect.arrayContaining([nodeRid, docRootRid]),
        );
        expect(hits.every((hit) => hit.score > 0)).toBe(true);
      } finally {
        if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
        else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
      }
    },
    TIMEOUT,
  );

  test(
    "local vector records stay within RedDB KV value limits for metadata-heavy docs",
    async () => {
      const store = await openStore(await tempRoot());
      const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
      process.env.RED_MEMORY_VECTOR_PROVIDER = "local";
      try {
        await store.upsertNode({
          label: "md:/repo/docs/deeply/nested/vector-heavy-memory-guide.md",
          node_type: "concept",
          properties: {
            title: "Vector-heavy Memory guide",
            content: "document-root concept",
            hash: "metadata-heavy-doc-hash",
          },
        });
        await store.upsertDoc({
          path: "docs/deeply/nested/vector-heavy-memory-guide.md",
          title: "Vector-heavy Memory guide with local embeddings and RedDB persistence",
          body: Array.from({ length: 120 }, (_, index) => `token_${index}`).join(" "),
          frontmatter: { tags: ["vectors", "memory", "reddb", "local-dev"] },
          hash: "metadata-heavy-doc-hash",
          updated_at: 123,
        });

        await expect(store.maintainVectorProjection()).resolves.toMatchObject({
          overall: "ready",
          failed: 0,
        });
        await expect(store.searchVector("local embeddings RedDB", 3)).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ score: expect.any(Number) })]),
        );
      } finally {
        if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
        else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
      }
    },
    TIMEOUT,
  );

  test(
    "strict vector maintenance fails when projection cannot be rebuilt",
    async () => {
      const store = await openStore(await tempRoot());
      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql.includes("WITH AUTO EMBED")) throw new Error("vector insert syntax error");
        return query(sql, ...params);
      };

      await store.upsertNode(factToNode("strict vector maintenance surfaces failures", slugify));

      await expect(store.maintainVectorProjection({ strict: true })).rejects.toThrow(
        "vector projection failed",
      );
      await expect(store.vectorStatus()).resolves.toMatchObject({
        overall: "failed",
        failed: 1,
      });
    },
    TIMEOUT,
  );

  test(
    "stored nodes carry explicit project scope metadata by default",
    async () => {
      const store = await openStore(await tempRoot());
      const rid = await store.upsertNode(factToNode("scoped project memory", slugify));

      const back = await store.getNode(rid);
      expect(back?.properties.scope).toBe("project");
      expect(back?.properties.scope_id).toBe("test");
    },
    TIMEOUT,
  );

  test(
    "dedupe keeps identical facts separate across scope identifiers",
    async () => {
      const store = await openStore(await tempRoot());
      const main = await store.upsertNode(
        factToNode("same scoped memory", slugify, { scope: "branch", scopeId: "main" }),
      );
      const feature = await store.upsertNode(
        factToNode("same scoped memory", slugify, { scope: "branch", scopeId: "feature" }),
      );

      expect(feature).not.toBe(main);
      const nodes = await store.listNodes();
      expect(nodes.find((n) => n.rid === main)?.properties.scope_id).toBe("main");
      expect(nodes.find((n) => n.rid === feature)?.properties.scope_id).toBe("feature");
    },
    TIMEOUT,
  );

  test(
    "listNodes reuses the node snapshot until writes invalidate it",
    async () => {
      const store = await openStore(await tempRoot());
      await store.upsertNode(factToNode("first cached node", slugify));

      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      let nodeScans = 0;
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql === "SELECT * FROM memory_nodes") nodeScans += 1;
        return query(sql, ...params);
      };

      expect(await store.listNodes()).toHaveLength(1);
      expect(await store.listNodes()).toHaveLength(1);
      expect(nodeScans).toBe(1);

      await store.upsertNode(factToNode("second cached node", slugify));
      expect(await store.listNodes()).toHaveLength(2);
      expect(nodeScans).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "edge dedupe: re-storing the same (from,to,label) returns the same rid",
    async () => {
      const store = await openStore(await tempRoot());
      const a = await store.upsertNode(factToNode("node a", slugify));
      const b = await store.upsertNode(factToNode("node b", slugify));

      const e1 = await store.upsertEdge({ label: "MENTIONS", from_rid: a, to_rid: b });
      const e2 = await store.upsertEdge({ label: "MENTIONS", from_rid: a, to_rid: b });
      expect(e2).toBe(e1);

      const { edges } = await store.stats();
      expect(edges).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "co-occurrence edges cannot be written as causal labels",
    async () => {
      const store = await openStore(await tempRoot());
      const a = await store.upsertNode(factToNode("co occurrence node a", slugify));
      const b = await store.upsertNode(factToNode("co occurrence node b", slugify));

      await expect(
        store.upsertEdge({
          label: "CAUSES",
          from_rid: a,
          to_rid: b,
          properties: { relation_kind: "co-occurrence" },
        }),
      ).rejects.toThrow(/co-occurrence edge cannot use causal label CAUSES/);
    },
    TIMEOUT,
  );

  test(
    "new writes carry provenance_tier while legacy rows read without it",
    async () => {
      const store = await openStore(await tempRoot());
      const oracleRid = await store.upsertNode({
        label: "oracle-validation",
        node_type: "validation",
        properties: {
          title: "oracle validation",
          content: "test command passed",
          confidence: "EXTRACTED",
        },
      });
      const proxyRid = await store.upsertNode(factToNode("manual legacy shaped fact", slugify));

      await expect(store.getNode(oracleRid)).resolves.toMatchObject({
        properties: { provenance_tier: "oracle" },
      });
      await expect(store.getNode(proxyRid)).resolves.toMatchObject({
        properties: { provenance_tier: "proxy" },
      });

      const legacy = rowToNode({
        rid: 999,
        label: "legacy",
        node_type: "concept",
        PROPERTIES: { title: "legacy" },
      });
      expect(legacy.properties.provenance_tier).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "listEdges reuses the edge snapshot until writes invalidate it",
    async () => {
      const store = await openStore(await tempRoot());
      const a = await store.upsertNode(factToNode("edge cache node a", slugify));
      const b = await store.upsertNode(factToNode("edge cache node b", slugify));
      await store.upsertEdge({ label: "REFERENCES", from_rid: a, to_rid: b });

      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      let edgeScans = 0;
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql === "SELECT * FROM memory_edges") edgeScans += 1;
        return query(sql, ...params);
      };

      expect(await store.listEdges()).toHaveLength(1);
      expect(await store.listEdges()).toHaveLength(1);
      expect(edgeScans).toBe(1);

      await store.upsertEdge({ label: "MENTIONS", from_rid: a, to_rid: b });
      expect(await store.listEdges()).toHaveLength(2);
      expect(edgeScans).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "supersede: recall returns the head of a SUPERSEDED_BY chain by default",
    async () => {
      const store = await openStore(await tempRoot());
      const old = await store.upsertNode(
        factToNode("we deploy on fridays", slugify),
      );
      const current = await store.upsertNode(
        factToNode("we deploy on fridays — superseded: deploys are now tuesdays", slugify),
      );
      await store.supersede(old, current, "policy changed");

      expect(await store.supersededBy(old)).toBe(current);
      expect(await store.supersededBy(current)).toBeNull();

      const hits = await graphRecall(store, "deploy fridays tuesdays");
      const rids = hits.map((h) => h.rid);
      expect(rids).toContain(current);
      expect(rids).not.toContain(old);
    },
    TIMEOUT,
  );

  test(
    "supersede: --include-superseded returns the full chain",
    async () => {
      const store = await openStore(await tempRoot());
      const old = await store.upsertNode(factToNode("we deploy on fridays", slugify));
      const current = await store.upsertNode(
        factToNode("we deploy on fridays — superseded: deploys are now tuesdays", slugify),
      );
      await store.supersede(old, current, "policy changed");

      const hits = await graphRecall(store, "deploy fridays tuesdays", 10, {
        includeSuperseded: true,
      });
      const rids = hits.map((h) => h.rid);
      expect(rids).toContain(current);
      expect(rids).toContain(old);
    },
    TIMEOUT,
  );

  test(
    "conflicting fact write archives the old belief and audit recall shows lineage",
    async () => {
      const store = await openStore(await tempRoot());
      const old = await store.upsertNode({
        label: "release-window",
        node_type: "decision",
        properties: {
          title: "release window",
          content: "release window is friday afternoon",
          created_at: 1_000,
        },
      });

      const current = await store.upsertNode({
        label: "release-window",
        node_type: "decision",
        properties: {
          title: "release window",
          content: "release window is tuesday morning",
          created_at: 2_000,
        },
      });

      expect(await store.supersededBy(old)).toBe(current);
      const archived = await store.getNode(old);
      expect(archived?.properties).toMatchObject({
        superseded_by: current,
        valid_until: expect.any(Number),
        archived_at: expect.any(Number),
      });

      const defaultHits = await graphRecall(store, "release window friday tuesday", 10);
      expect(defaultHits.map((hit) => hit.rid)).toContain(current);
      expect(defaultHits.map((hit) => hit.rid)).not.toContain(old);

      const auditHits = await graphRecall(
        store,
        "what did we believe before release window changed to tuesday",
        10,
        {
          includeSuperseded: true,
        },
      );
      const auditOld = auditHits.find((hit) => hit.rid === old);
      expect(auditOld).toMatchObject({
        superseded_by: current,
        valid_until: expect.any(Number),
      });
      expect(auditOld?.excerpt).toContain("release window is friday afternoon");
    },
    TIMEOUT,
  );

  test.each(SOFT_MERGE_LABELS)(
    "soft merge %s: recall hides the duplicate until the edge is removed",
    async (label) => {
      const store = await openStore(await tempRoot());
      const duplicate = await store.upsertNode(
        factToNode("jwt rotation duplicate carries original provenance", slugify, {
          provenance: {
            source_kind: "manual",
            writer: "agent-a",
            evidence: ["transcript:duplicate-node"],
          },
        }),
      );
      const canonical = await store.upsertNode(
        factToNode("jwt rotation canonical target keeps active guidance", slugify),
      );

      const edge = await store.upsertEdge({
        label,
        from_rid: duplicate,
        to_rid: canonical,
        properties: { reason: "approved entity merge" },
      });

      expect(edge).toBeGreaterThan(0);
      expect(await store.findEdge(duplicate, canonical, label)).toBe(edge);

      const hiddenHits = await graphRecall(
        store,
        "jwt rotation duplicate provenance canonical guidance",
        10,
      );
      const hiddenRids = hiddenHits.map((h) => h.rid);
      expect(hiddenRids).toContain(canonical);
      expect(hiddenRids).not.toContain(duplicate);

      await expect(store.getNode(duplicate)).resolves.toMatchObject({
        rid: duplicate,
        properties: {
          provenance: {
            source_kind: "manual",
            writer: "agent-a",
            evidence: ["transcript:duplicate-node"],
          },
        },
      });

      await expect(store.removeEdge(duplicate, canonical, label)).resolves.toBe(true);
      expect(await store.findEdge(duplicate, canonical, label)).toBeNull();
      expect(
        (await store.listEdges()).some(
          (e) =>
            e.label === label &&
            Number(e.from_rid ?? e.from) === duplicate &&
            Number(e.to_rid ?? e.to) === canonical,
        ),
      ).toBe(false);

      const visibleHits = await graphRecall(
        store,
        "jwt rotation duplicate original provenance",
        10,
      );
      expect(visibleHits.map((h) => h.rid)).toContain(duplicate);
    },
    TIMEOUT,
  );

  test.each(SOFT_MERGE_LABELS)(
    "soft merge %s: re-adding a removed merge hides the duplicate again",
    async (label) => {
      const store = await openStore(await tempRoot());
      const duplicate = await store.upsertNode(
        factToNode("api key duplicate remerge marker", slugify),
      );
      const canonical = await store.upsertNode(
        factToNode("api key canonical remerge target", slugify),
      );

      await store.upsertEdge({ label, from_rid: duplicate, to_rid: canonical });
      await expect(store.removeEdge(duplicate, canonical, label)).resolves.toBe(true);

      const readded = await store.upsertEdge({ label, from_rid: duplicate, to_rid: canonical });
      expect(readded).toBeGreaterThan(0);
      expect(await store.findEdge(duplicate, canonical, label)).toBe(readded);

      const hits = await graphRecall(store, "api key duplicate remerge marker", 10);
      const rids = hits.map((hit) => hit.rid);
      expect(rids).toContain(canonical);
      expect(rids).not.toContain(duplicate);
    },
    TIMEOUT,
  );

  test(
    "recordReasoning: a trace links to the entities it TOUCHED",
    async () => {
      const store = await openStore(await tempRoot());
      const auth = await store.upsertNode(factToNode("the auth service issues jwt tokens", slugify));
      const cache = await store.upsertNode(factToNode("redis cache ttl is 300 seconds", slugify));

      const { rid, edges } = await store.recordReasoning(
        {
          label: "why-shorten-ttl",
          properties: { title: "why we shortened the ttl", content: "auth churn forced it" },
        },
        [auth, cache],
      );

      // The trace defaults to the reasoning tier (why_note → reasoning, #68).
      const trace = await store.getNode(rid);
      expect(trace?.node_type).toBe("why_note");
      expect(trace?.properties.tier).toBe("reasoning");
      expect(edges).toHaveLength(2);

      // TOUCHED edges connect the trace to both affected entities.
      const neighbors = (await store.neighborhood("why-shorten-ttl", 1, "outgoing")).map(
        (n) => n.rid,
      );
      expect(neighbors).toContain(auth);
      expect(neighbors).toContain(cache);
    },
    TIMEOUT,
  );
});

describe("init graph mode + round-trip", () => {
  test(
    "initGraph writes a graph config and provisions a per-project store",
    async () => {
      const root = await tempRoot();
      const result = await initGraph(root);

      const config = await readConfig(root);
      expect(config?.mode).toBe("graph");
      expect(config?.reddb).toBe(true);
      expect(config?.hooks).toEqual({
        sessionStart: false,
        postToolUse: false,
        stop: false,
        preCompact: false,
      });
      expect(config?.mcp).toBe(false);

      // Config is the unified yaml (ADR 0042); the default store path is sparse
      // (omitted) but still resolves, and the store file was provisioned.
      expect(result.configPath.endsWith("/.red/config.yaml")).toBe(true);
      const storePath = result.storeUri.replace(/^file:\/\//, "");
      expect(storePath.endsWith("/.red/memory/graph.rdb")).toBe(true);
      expect(existsSync(storePath)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "store → recall round-trips a fact through the graph",
    async () => {
      const store = await openStore(await tempRoot());
      await store.upsertNode(
        factToNode("the staging database password rotates every 90 days", slugify),
      );

      const hits = await graphRecall(store, "database password rotation");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].excerpt).toContain("password rotates every 90 days");
    },
    TIMEOUT,
  );
});
