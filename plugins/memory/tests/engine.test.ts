import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ask, neighbors, path, recall, search, traverse } from "../src/engine.js";
import { MemoryStore } from "../src/graph-store.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-engine-"));
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

/**
 * Seed a small graph:
 *
 *   auth-service ──REFERENCES──▶ jwt-rotation ──REFERENCES──▶ cache-ttl
 *   redis-eviction (isolated)
 *
 * Returns the rid of every node by label.
 */
async function seed(store: MemoryStore): Promise<Record<string, number>> {
  const node = (label: string, content: string, node_type = "concept") =>
    store.upsertNode({
      label,
      node_type: node_type as never,
      properties: { title: label.replace(/-/g, " "), content },
    });

  const auth = await node("auth-service", "the auth service issues jwt tokens on login");
  const jwt = await node("jwt-rotation", "jwt tokens rotate every 90 days in staging");
  const cache = await node("cache-ttl", "redis cache ttl is 300 seconds");
  const evict = await node("redis-eviction", "redis evicts keys with an lru policy");

  await store.upsertEdge({ label: "REFERENCES", from_rid: auth, to_rid: jwt });
  await store.upsertEdge({ label: "REFERENCES", from_rid: jwt, to_rid: cache });

  return { auth, jwt, cache, evict };
}

describe("recall", () => {
  test(
    "ranks a direct text match above a graph-only neighbor",
    async () => {
      const store = await openStore();
      const ids = await seed(store);

      // "rotate 90 days" matches jwt-rotation directly; auth-service has no such
      // terms and only surfaces as a one-hop neighbor.
      const { nodes, context_md } = await recall(store, "rotate 90 days staging");
      const byRid = new Map(nodes.map((n) => [n.rid, n]));

      expect(nodes[0].rid).toBe(ids.jwt);
      expect(byRid.has(ids.auth)).toBe(true);
      expect(byRid.get(ids.jwt)!.score).toBeGreaterThan(byRid.get(ids.auth)!.score);
      expect(context_md).toContain("jwt rotation");
    },
    TIMEOUT,
  );

  test(
    "expands a unique-token seed to its neighbor",
    async () => {
      const store = await openStore();
      const ids = await seed(store);

      // "300 seconds" only matches cache-ttl; jwt-rotation surfaces via the edge.
      const { nodes } = await recall(store, "300 seconds", { depth: 1 });
      const rids = nodes.map((n) => n.rid);
      expect(rids).toContain(ids.cache);
      expect(rids).toContain(ids.jwt);
      expect(rids).not.toContain(ids.evict);
    },
    TIMEOUT,
  );

  test(
    "depth 0 disables neighborhood expansion",
    async () => {
      const store = await openStore();
      const ids = await seed(store);

      const { nodes } = await recall(store, "300 seconds", { depth: 0 });
      const rids = nodes.map((n) => n.rid);
      expect(rids).toContain(ids.cache);
      expect(rids).not.toContain(ids.jwt);
    },
    TIMEOUT,
  );

  test(
    "types filter restricts results",
    async () => {
      const store = await openStore();
      await seed(store);
      await store.upsertNode({
        label: "deploy-tuesdays",
        node_type: "decision",
        properties: { title: "deploy tuesdays", content: "we deploy jwt changes on tuesdays" },
      });

      const { nodes } = await recall(store, "jwt", { types: ["decision"] });
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes.every((n) => n.node_type === "decision")).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "hides a superseded node behind its successor",
    async () => {
      const store = await openStore();
      const old = await store.upsertNode({
        label: "deploy-fridays",
        node_type: "decision",
        properties: { title: "deploy fridays", content: "we deploy on fridays" },
      });
      const current = await store.upsertNode({
        label: "deploy-tuesdays",
        node_type: "decision",
        properties: { title: "deploy tuesdays", content: "we deploy on tuesdays now" },
      });
      await store.supersede(old, current, "policy changed");

      const { nodes } = await recall(store, "deploy fridays tuesdays");
      const rids = nodes.map((n) => n.rid);
      expect(rids).toContain(current);
      expect(rids).not.toContain(old);
    },
    TIMEOUT,
  );
});

describe("search", () => {
  test(
    "returns nodes matching the query text",
    async () => {
      const store = await openStore();
      const ids = await seed(store);

      const hits = await search(store, "redis");
      const rids = hits.map((h) => h.rid);
      expect(rids).toContain(ids.cache);
      expect(rids).toContain(ids.evict);
      expect(rids).not.toContain(ids.auth);
    },
    TIMEOUT,
  );
});

describe("neighbors / traverse", () => {
  test(
    "neighbors returns the one-hop neighborhood",
    async () => {
      const store = await openStore();
      const ids = await seed(store);

      const rows = await neighbors(store, "jwt-rotation", 1, "both");
      const rids = rows.map((n) => n.rid);
      expect(rids).toContain(ids.auth);
      expect(rids).toContain(ids.cache);
      expect(rids).not.toContain(ids.evict);
    },
    TIMEOUT,
  );

  test(
    "traverse walks outgoing edges in depth order",
    async () => {
      const store = await openStore();
      const ids = await seed(store);

      const rows = await traverse(store, "auth-service", {
        depth: 3,
        strategy: "bfs",
        direction: "outgoing",
      });
      const rids = rows.map((n) => n.rid);
      expect(rids).toEqual([ids.auth, ids.jwt, ids.cache]);
      // Depth is monotonically non-decreasing along the walk.
      const depths = rows.map((n) => n.depth ?? 0);
      expect(depths).toEqual([...depths].sort((a, b) => a - b));
    },
    TIMEOUT,
  );
});

describe("path", () => {
  test(
    "finds the shortest path between connected nodes",
    async () => {
      const store = await openStore();
      await seed(store);

      const result = await path(store, "auth-service", "cache-ttl", "bfs");
      expect(result?.reachable).toBe(true);
      expect(result?.hopCount).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "reports unreachable for disconnected nodes",
    async () => {
      const store = await openStore();
      await seed(store);

      const result = await path(store, "auth-service", "redis-eviction", "bfs");
      expect(result?.reachable).toBe(false);
    },
    TIMEOUT,
  );
});

describe("ask", () => {
  test(
    "degrades gracefully without an LLM key",
    async () => {
      const store = await openStore();
      await seed(store);

      const result = await ask(store, "how often do jwt tokens rotate?");
      // No LLM key in CI → not available, but the call must not throw.
      expect(result).toHaveProperty("available");
      expect(Array.isArray(result.citations)).toBe(true);
    },
    TIMEOUT,
  );
});
