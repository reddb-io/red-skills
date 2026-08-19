import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ask, neighbors, path, recall, search, traverse } from "../src/engine.js";
import {
  EMPTY_ENGINEERING_CODE_CURATION,
  aliasEngineeringCode,
  resolveEngineeringCodeAlias,
} from "../src/code-curation.js";
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
    "codes filter restricts results to an engineering code (ADR 0035 queryable axis)",
    async () => {
      const store = await openStore();
      await seed(store);
      // Two nodes sharing query terms but different engineering codes: only the
      // `root-cause`-coded one should survive a code-filtered recall.
      await store.upsertNode({
        label: "jwt-expiry-root-cause",
        node_type: "concept",
        properties: {
          title: "jwt expiry root cause",
          content: "jwt tokens expired early because the clock skew was unbounded",
          engineering_code: "root-cause",
        },
      });
      await store.upsertNode({
        label: "jwt-rotation-decision",
        node_type: "concept",
        properties: {
          title: "jwt rotation decision",
          content: "we decided to rotate jwt signing keys every quarter",
          engineering_code: "decision",
        },
      });

      const { nodes } = await recall(store, "jwt", { codes: ["root-cause"] });
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes.every((n) => n.properties.engineering_code === "root-cause")).toBe(true);
      expect(nodes.some((n) => n.label === "jwt-expiry-root-cause")).toBe(true);
      expect(nodes.some((n) => n.label === "jwt-rotation-decision")).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "codes filter normalizes the caller's input (Root Cause ≡ root-cause)",
    async () => {
      const store = await openStore();
      await store.upsertNode({
        label: "jwt-expiry-root-cause",
        node_type: "concept",
        properties: {
          title: "jwt expiry root cause",
          content: "jwt tokens expired because of clock skew",
          engineering_code: "root-cause",
        },
      });

      const { nodes } = await recall(store, "jwt", { codes: ["Root Cause"] });
      expect(nodes.some((n) => n.label === "jwt-expiry-root-cause")).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "codes and query terms resolve explicit engineering-code aliases without rewriting stored codes",
    async () => {
      const store = await openStore();
      const curation = aliasEngineeringCode(
        EMPTY_ENGINEERING_CODE_CURATION,
        "footgun",
        "gotcha",
      ).state;
      await store.upsertNode({
        label: "jwt-clock-skew-footgun",
        node_type: "concept",
        properties: {
          title: "jwt clock skew",
          content: "tokens expired early because clock skew was unbounded",
          engineering_code: "footgun",
        },
      });

      const { nodes } = await recall(store, "gotcha", {
        codes: ["gotcha"],
        codeCanonicalize: (code) => resolveEngineeringCodeAlias(code, curation),
      });

      expect(nodes.some((n) => n.label === "jwt-clock-skew-footgun")).toBe(true);
      expect(nodes.every((n) => n.properties.engineering_code === "footgun")).toBe(true);
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

  test(
    "redirects an old-only match to the active supersession head",
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
        properties: { title: "deploy tuesdays", content: "ship windows moved to tuesdays" },
      });
      await store.supersede(old, current, "policy changed");

      const { nodes, context_md } = await recall(store, "fridays", { depth: 0 });
      const rids = nodes.map((n) => n.rid);
      expect(rids).toContain(current);
      expect(rids).not.toContain(old);
      expect(context_md).toContain("deploy tuesdays");
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
  test("grounds supported answers in recalled evidence citations and per-call cost", async () => {
    const store = {
      listNodes: async () => [
        {
          rid: 1,
          label: "jwt-rotation",
          node_type: "decision",
          properties: {
            title: "JWT rotation",
            content: "JWT tokens rotate every 90 days in staging.",
            confidence: "EXTRACTED",
            source: "docs/auth.md",
            tier: "durable",
            importance: 0.8,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        },
      ],
      searchText: async () => [{ rid: 1, score: 4 }],
      neighborhood: async () => [],
      supersededByMany: async () => new Map(),
      recordAccess: async () => {},
      listEdges: async () => [],
      ask: async (prompt: string) => {
        expect(prompt).toContain("[1] JWT rotation");
        return {
          answer: "JWT tokens rotate every 90 days in staging [1].",
          citations: [],
          cost: {
            cost_usd: 0.00042,
            prompt_tokens: 120,
            completion_tokens: 16,
            model: "gpt-4o-mini",
            provider: "openai",
            cache_hit: false,
          },
        };
      },
    } as unknown as MemoryStore;

    const result = await ask(store, "how often do jwt tokens rotate?");

    expect(result).toMatchObject({
      status: "answered",
      answer: "JWT tokens rotate every 90 days in staging [1].",
      citations: [{ marker: 1, urn: "memory_nodes:1" }],
      evidence: {
        active: [
          {
            citation: "[1]",
            rid: 1,
            label: "jwt-rotation",
            confidence: "EXTRACTED",
            source: "docs/auth.md",
          },
        ],
        superseded: [],
        contradictory: [],
        byConfidence: {
          EXTRACTED: [expect.objectContaining({ rid: 1 })],
          INFERRED: [],
          AMBIGUOUS: [],
        },
      },
      cost: {
        cost_usd: 0.00042,
        prompt_tokens: 120,
        completion_tokens: 16,
        model: "gpt-4o-mini",
        provider: "openai",
        cache_hit: false,
      },
    });
  });

  test("returns insufficient evidence without calling the provider for unsupported questions", async () => {
    const store = {
      listNodes: async () => [
        {
          rid: 1,
          label: "jwt-rotation",
          node_type: "decision",
          properties: {
            title: "JWT rotation",
            content: "JWT tokens rotate every 90 days in staging.",
            confidence: "EXTRACTED",
            tier: "durable",
          },
        },
      ],
      searchText: async () => [],
      neighborhood: async () => [],
      supersededByMany: async () => new Map(),
      recordAccess: async () => {},
      listEdges: async () => [],
      ask: async () => {
        throw new Error("provider should not be called");
      },
    } as unknown as MemoryStore;

    const result = await ask(store, "what is the database password?");

    expect(result).toMatchObject({
      status: "insufficient-evidence",
      available: true,
      answer: "Insufficient evidence in Memory to answer this question.",
      citations: [],
      evidence: {
        active: [],
        superseded: [],
        contradictory: [],
        byConfidence: { EXTRACTED: [], INFERRED: [], AMBIGUOUS: [] },
      },
      gap_analysis: {
        status: "unsupported",
        summary: "Memory has no recalled evidence for this question.",
      },
      cost: null,
    });
  });

  test("surfaces superseded and contradictory evidence distinctly", async () => {
    const store = {
      listNodes: async () => [
        {
          rid: 1,
          label: "deploy-friday",
          node_type: "decision",
          properties: {
            title: "Deploy Friday",
            content: "Deploys happen on Friday.",
            confidence: "INFERRED",
            tier: "durable",
            created_at: 1,
            updated_at: 1,
          },
        },
        {
          rid: 2,
          label: "deploy-tuesday",
          node_type: "decision",
          properties: {
            title: "Deploy Tuesday",
            content: "Deploys happen on Tuesday.",
            confidence: "AMBIGUOUS",
            tier: "durable",
            created_at: 2,
            updated_at: 2,
          },
        },
      ],
      searchText: async () => [],
      neighborhood: async () => [],
      supersededByMany: async () => new Map([[1, 2]]),
      recordAccess: async () => {},
      listEdges: async () => [
        {
          label: "CONTRADICTS",
          from_rid: 1,
          to_rid: 2,
          properties: { reason: "deployment day changed" },
        },
      ],
      ask: async (prompt: string) => {
        expect(prompt).toContain("Superseded evidence:");
        expect(prompt).toContain("Deploy Friday");
        expect(prompt).toContain("Deploy Tuesday");
        expect(prompt).toContain("Contradictions:");
        expect(prompt).toContain("contradicts");
        expect(prompt).toContain("Gap analysis:");
        expect(prompt).toContain("No EXTRACTED evidence supports the answer.");
        return {
          answer: "Current evidence says deploys happen on Tuesday [2]. Friday is superseded [1].",
          citations: [],
          cost: {
            cost_usd: 0.0001,
            prompt_tokens: 80,
            completion_tokens: 20,
            model: "gpt-4o-mini",
            provider: "openai",
            cache_hit: false,
          },
        };
      },
    } as unknown as MemoryStore;

    const result = await ask(store, "when do deploys happen?");

    expect(result.status).toBe("answered");
    expect(result.evidence.active).toEqual([
      expect.objectContaining({ rid: 2, status: "active", confidence: "AMBIGUOUS" }),
    ]);
    expect(result.evidence.superseded).toEqual([
      expect.objectContaining({ rid: 1, status: "superseded", activeRid: 2, confidence: "INFERRED" }),
    ]);
    expect(result.evidence.contradictory).toEqual([
      expect.objectContaining({
        reason: "deployment day changed",
        resolved: true,
        activeRid: 2,
      }),
    ]);
    expect(result.evidence.byConfidence.INFERRED).toEqual([
      expect.objectContaining({ rid: 1 }),
    ]);
    expect(result.evidence.byConfidence.AMBIGUOUS).toEqual([
      expect.objectContaining({ rid: 2 }),
    ]);
    expect(result.gap_analysis).toMatchObject({
      status: "partial",
      gaps: expect.arrayContaining(["No EXTRACTED evidence supports the answer."]),
    });
  });

  test(
    "degrades gracefully without an LLM key",
    async () => {
      const store = await openStore();
      await seed(store);

      const result = await ask(store, "how often do jwt tokens rotate?");
      // No LLM key in CI → not available, but the call must not throw.
      expect(result.status).toBe("provider-unavailable");
      expect(result).toHaveProperty("available");
      expect(result.answer).toContain("Evidence-only fallback: LLM provider unavailable");
      expect(result.answer).toContain("[1]");
      expect(result.answer).toContain("jwt tokens rotate every 90 days in staging");
      expect(result.answer).toContain("Gap analysis:");
      expect(result.gap_analysis.status).toBe("partial");
      expect(Array.isArray(result.citations)).toBe(true);
      expect(result.evidence.active.length).toBeGreaterThan(0);
      expect(result.cost).toBeNull();
    },
    TIMEOUT,
  );
});
