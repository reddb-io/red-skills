import { describe, expect, test } from "vitest";
import {
  RECENCY_HALF_LIFE_MS,
  type RecallStore,
  TIER_WEIGHT,
  rankScore,
  recall,
} from "../src/engine.js";
import type { GraphRow, SearchRow, StoredNode } from "../src/graph-store.js";
import type { Tier } from "../src/schema.js";

/**
 * In-memory `RecallStore` for ranking unit tests — no RedDB, no `red` binary.
 * Holds a flat node list, an optional superseded map, and an optional edge
 * list; FTS and neighborhood are no-ops so the term-scan seed path drives
 * scoring deterministically.
 */
class MockStore implements RecallStore {
  constructor(
    private nodes: StoredNode[],
    private superseded: Map<number, number> = new Map(),
    private edges: Record<string, unknown>[] = [],
  ) {}
  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }
  async searchText(): Promise<SearchRow[]> {
    return [];
  }
  async neighborhood(): Promise<GraphRow[]> {
    return [];
  }
  async supersededByMany(rids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const rid of rids) {
      const to = this.superseded.get(rid);
      if (to != null) out.set(rid, to);
    }
    return out;
  }
  async recordAccess(): Promise<void> {}
  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.edges;
  }
}

const NOW = 1_700_000_000_000;

function node(rid: number, tier: Tier, extra: Record<string, unknown> = {}): StoredNode {
  return {
    rid,
    label: `n${rid}`,
    node_type: "concept",
    properties: {
      title: `node ${rid}`,
      content: "alpha",
      tier,
      importance: 0.5,
      created_at: NOW,
      ...extra,
    },
  };
}

describe("rankScore (#72)", () => {
  const base = { relevance: 1, importance: 1, ageMs: 0, degree: 0, maxDegree: 0 } as const;

  test("tier weight orders durable > reasoning > ephemeral", () => {
    const d = rankScore({ ...base, tier: "durable" });
    const r = rankScore({ ...base, tier: "reasoning" });
    const e = rankScore({ ...base, tier: "ephemeral" });
    expect(d).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(e);
    expect(d).toBe(TIER_WEIGHT.durable);
  });

  test("recency halves the score every half-life", () => {
    const fresh = rankScore({ ...base, tier: "durable", ageMs: 0 });
    const aged = rankScore({ ...base, tier: "durable", ageMs: RECENCY_HALF_LIFE_MS });
    expect(aged).toBeCloseTo(fresh / 2, 6);
  });

  test("centrality rewards higher degree", () => {
    const hub = rankScore({ ...base, tier: "durable", degree: 4, maxDegree: 4 });
    const leaf = rankScore({ ...base, tier: "durable", degree: 0, maxDegree: 4 });
    expect(hub).toBeGreaterThan(leaf);
  });
});

describe("recall ranking with a mock store (#72)", () => {
  test("ranks durable above reasoning above ephemeral for comparable nodes", async () => {
    // Identical relevance/importance/recency/centrality — only the tier differs.
    const store = new MockStore([
      node(1, "ephemeral"),
      node(2, "durable"),
      node(3, "reasoning"),
    ]);
    const { nodes } = await recall(store, "alpha", { depth: 0, now: NOW });
    expect(nodes.map((n) => n.rid)).toEqual([2, 3, 1]);
  });

  test("returns the head of a SUPERSEDED_BY chain by default", async () => {
    const store = new MockStore(
      [node(1, "durable"), node(2, "durable")],
      new Map([[1, 2]]),
    );
    const { nodes } = await recall(store, "alpha", { depth: 0, now: NOW });
    const rids = nodes.map((n) => n.rid);
    expect(rids).toContain(2);
    expect(rids).not.toContain(1);
  });

  test("--include-superseded returns the full chain", async () => {
    const store = new MockStore(
      [node(1, "durable"), node(2, "durable")],
      new Map([[1, 2]]),
    );
    const { nodes } = await recall(store, "alpha", {
      depth: 0,
      includeSuperseded: true,
      now: NOW,
    });
    const rids = nodes.map((n) => n.rid);
    expect(rids).toContain(1);
    expect(rids).toContain(2);
  });
});
