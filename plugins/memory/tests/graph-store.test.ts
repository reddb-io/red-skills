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
