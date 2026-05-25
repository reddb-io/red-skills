import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    "vector search maps projected vector rows back to memory node rids",
    async () => {
      const store = await openStore(await tempRoot());
      const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
      process.env.RED_MEMORY_VECTOR_PROVIDER = "openai";
      const raw = store.raw as unknown as {
        query: (sql: string, ...params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      };
      const query = raw.query.bind(raw);
      raw.query = async (sql: string, ...params: unknown[]) => {
        if (sql.startsWith("SEARCH SIMILAR TEXT")) {
          expect(sql).toContain("COLLECTION memory_vectors");
          expect(sql).toContain("USING openai");
          expect(sql).toContain("LIMIT 3");
          return { rows: [{ entity_id: 9, node_rid: 42, similarity: 0.82 }] };
        }
        return query(sql, ...params);
      };

      try {
        await expect(store.searchVector("semantic recall", 3)).resolves.toEqual([
          { rid: 42, score: 0.82 },
        ]);
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

      // The store file was created under .red/memory/.
      const raw = await readFile(result.configPath, "utf8");
      expect(raw).toContain('"storePath"');
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
