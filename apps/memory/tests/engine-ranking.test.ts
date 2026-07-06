import { describe, expect, test } from "vitest";
import {
  PROVENANCE_TIER_WEIGHT,
  RECENCY_HALF_LIFE_MS,
  type RecallStore,
  TIER_WEIGHT,
  rankScore,
  recall,
} from "../src/engine.js";
import type { GraphRow, SearchRow, StoredNode } from "../src/graph-store.js";
import type { MemoryScope, ProvenanceTier, Tier } from "../src/schema.js";

/**
 * In-memory `RecallStore` for ranking unit tests — no RedDB, no `red` binary.
 * Holds a flat node list, an optional superseded map, and an optional edge
 * list; FTS is a no-op so the term-scan seed path drives scoring
 * deterministically.
 */
class MockStore implements RecallStore {
  readonly listNodeNowValues: Array<number | undefined> = [];
  readonly recordAccessCalls: Array<{ rids: number[]; now?: number }> = [];

  constructor(
    private nodes: StoredNode[],
    private superseded: Map<number, number> = new Map(),
    private edges: Record<string, unknown>[] = [],
    private vectorHits: SearchRow[] = [],
  ) {}
  async listNodes(now?: number): Promise<StoredNode[]> {
    this.listNodeNowValues.push(now);
    const effectiveNow = now ?? Date.now();
    return this.nodes.filter((n) => {
      if (n.properties.tier !== "ephemeral") return true;
      const expiresAt = n.properties.expires_at;
      return typeof expiresAt !== "number" || effectiveNow < expiresAt;
    });
  }
  async searchText(): Promise<SearchRow[]> {
    return [];
  }
  async searchVector(): Promise<SearchRow[]> {
    return this.vectorHits;
  }
  async neighborhood(): Promise<GraphRow[]> {
    throw new Error("recall should expand from listEdges, not per-seed graph walks");
  }
  async supersededByMany(rids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const rid of rids) {
      const to = this.superseded.get(rid);
      if (to != null) out.set(rid, to);
    }
    return out;
  }
  async recordAccess(rids: number[], now?: number): Promise<void> {
    this.recordAccessCalls.push({ rids, now });
  }
  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.edges;
  }
}

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function node(
  rid: number,
  tier: Tier,
  extra: Record<string, unknown> = {},
  scope?: MemoryScope,
): StoredNode {
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
      ...(scope ? { scope } : {}),
      ...extra,
    },
  };
}

function provenanceNode(
  rid: number,
  provenanceTier: ProvenanceTier | undefined,
): StoredNode {
  return node(rid, "durable", {
    content: "alpha provenance parity",
    ...(provenanceTier ? { provenance_tier: provenanceTier } : {}),
  });
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

  test("provenance tier orders oracle above proxy", () => {
    const oracle = rankScore({ ...base, tier: "durable", provenanceTier: "oracle" });
    const proxy = rankScore({ ...base, tier: "durable", provenanceTier: "proxy" });
    expect(oracle).toBeGreaterThan(proxy);
    expect(proxy).toBe(PROVENANCE_TIER_WEIGHT.proxy);
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

  test("ranks oracle facts above otherwise-equivalent proxy facts", async () => {
    const store = new MockStore([
      provenanceNode(1, "proxy"),
      provenanceNode(2, "oracle"),
    ]);

    const { nodes } = await recall(store, "alpha", { depth: 0, now: NOW });

    expect(nodes.map((n) => n.rid)).toEqual([2, 1]);
  });

  test("treats legacy facts without provenance_tier as proxy", async () => {
    const store = new MockStore([
      provenanceNode(1, undefined),
      provenanceNode(2, "oracle"),
    ]);

    const { nodes } = await recall(store, "alpha", { depth: 0, now: NOW });

    expect(nodes.map((n) => n.rid)).toEqual([2, 1]);
    expect(nodes.find((n) => n.rid === 1)?.properties.provenance_tier).toBeUndefined();
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

  test("promotes the active head when only obsolete guidance matches the query", async () => {
    const store = new MockStore(
      [
        node(1, "durable", { content: "legacy deploy window was friday" }),
        node(2, "durable", { content: "current deploy window is tuesday" }),
      ],
      new Map([[1, 2]]),
    );

    const { nodes } = await recall(store, "legacy friday", { depth: 0, now: NOW });
    expect(nodes.map((n) => n.rid)).toEqual([2]);
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

  test("expands graph neighbors from the edge snapshot", async () => {
    const store = new MockStore(
      [
        node(1, "durable", { content: "needle" }),
        node(2, "durable", { content: "plain neighbor" }),
      ],
      new Map(),
      [{ from: 1, to: 2 }],
    );

    const { nodes } = await recall(store, "needle", { depth: 1, now: NOW });
    const neighbor = nodes.find((n) => n.rid === 2);
    expect(neighbor?.depth).toBe(1);
  });

  test("project recall hides narrower branch/session/agent-run facts by default", async () => {
    const store = new MockStore([
      node(1, "durable", { content: "alpha project" }, "project"),
      node(2, "durable", { content: "alpha branch" }, "branch"),
      node(3, "durable", { content: "alpha session" }, "session"),
      node(4, "durable", { content: "alpha agent run" }, "agent-run"),
    ]);

    const { nodes, context_md } = await recall(store, "alpha", { depth: 0, now: NOW });

    expect(nodes.map((n) => n.rid)).toEqual([1]);
    expect(context_md).toContain("alpha project");
    expect(context_md).not.toContain("alpha branch");
    expect(context_md).not.toContain("alpha session");
    expect(context_md).not.toContain("alpha agent run");
  });

  test("explicit narrower scope selection recalls only that scope identifier", async () => {
    const store = new MockStore([
      node(1, "durable", { content: "alpha session one", scope_id: "s1" }, "session"),
      node(2, "durable", { content: "alpha session two", scope_id: "s2" }, "session"),
      node(3, "durable", { content: "alpha branch", scope_id: "main" }, "branch"),
    ]);

    const { nodes } = await recall(store, "alpha", {
      depth: 0,
      now: NOW,
      scope: { level: "session", id: "s1" },
    });

    expect(nodes.map((n) => n.rid)).toEqual([1]);
  });

  test("explicit broad scope can include project, repo, branch, worktree, session, and agent-run facts", async () => {
    const store = new MockStore([
      node(1, "durable", { content: "alpha project" }, "project"),
      node(2, "durable", { content: "alpha repo" }, "repo"),
      node(3, "durable", { content: "alpha branch" }, "branch"),
      node(4, "durable", { content: "alpha worktree" }, "worktree"),
      node(5, "durable", { content: "alpha session" }, "session"),
      node(6, "durable", { content: "alpha agent run" }, "agent-run"),
    ]);

    const { nodes } = await recall(store, "alpha", {
      depth: 0,
      now: NOW,
      scope: { level: "project", includeNarrower: true },
    });

    expect(nodes.map((n) => n.rid).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("explicit broad scope identifier can still opt into narrower facts", async () => {
    const store = new MockStore([
      node(1, "durable", { content: "alpha selected project", scope_id: "p1" }, "project"),
      node(2, "durable", { content: "alpha other project", scope_id: "p2" }, "project"),
      node(3, "durable", { content: "alpha branch" }, "branch"),
    ]);

    const { nodes } = await recall(store, "alpha", {
      depth: 0,
      now: NOW,
      scope: { level: "project", id: "p1", includeNarrower: true },
    });

    expect(nodes.map((n) => n.rid).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  test("includes vector-only candidates as governed recall seeds", async () => {
    const store = new MockStore(
      [
        node(1, "durable", { content: "alpha direct match" }),
        node(2, "durable", { content: "semantic neighbor only" }),
      ],
      new Map(),
      [],
      [{ rid: 2, score: 0.9 }],
    );

    const { nodes, diagnostics } = await recall(store, "alpha", { depth: 0, now: NOW });

    expect(nodes.map((n) => n.rid)).toContain(1);
    expect(nodes.map((n) => n.rid)).toContain(2);
    expect(diagnostics.vector).toMatchObject({
      status: "contributed",
      candidates: 1,
      contributed: 1,
    });
  });

  test("uses the injected clock for AS-OF node visibility and access bookkeeping", async () => {
    const store = new MockStore([
      node(1, "ephemeral", { content: "alpha as-of visible", expires_at: NOW + DAY }),
      node(2, "durable", { content: "alpha durable" }),
    ]);

    const { nodes } = await recall(store, "alpha", { depth: 0, now: NOW });

    expect(nodes.map((n) => n.rid)).toContain(1);
    expect(store.listNodeNowValues).toEqual([NOW]);
    expect(store.recordAccessCalls).toEqual([
      { rids: nodes.map((n) => n.rid), now: NOW },
    ]);
  });

  test("treats doc-grounded vector candidates as governed recall seeds", async () => {
    const store = new MockStore(
      [
        node(1, "durable", { content: "alpha direct match" }),
        node(2, "durable", {
          title: "JWT security guide",
          content: "markdown root concept without lexical query overlap",
        }),
      ],
      new Map(),
      [],
      [{ rid: 2, score: 0.95 }],
    );

    const { nodes, diagnostics } = await recall(store, "semantic token rotation", {
      depth: 0,
      now: NOW,
    });

    expect(nodes.map((n) => n.rid)).toContain(2);
    expect(diagnostics.vector).toMatchObject({
      status: "contributed",
      candidates: 1,
      contributed: 1,
    });
  });

  test("filters vector candidates through scope and supersession safeguards", async () => {
    const store = new MockStore(
      [
        node(1, "durable", { content: "obsolete vector match" }, "project"),
        node(2, "durable", { content: "current guidance" }, "project"),
        node(3, "durable", { content: "branch-only guidance" }, "branch"),
      ],
      new Map([[1, 2]]),
      [],
      [
        { rid: 1, score: 0.9 },
        { rid: 3, score: 0.9 },
        { rid: 99, score: 0.9 },
      ],
    );

    const { nodes, diagnostics } = await recall(store, "no textual overlap", {
      depth: 0,
      now: NOW,
    });
    const rids = nodes.map((n) => n.rid);

    expect(rids).toContain(2);
    expect(rids).not.toContain(1);
    expect(rids).not.toContain(3);
    expect(rids).not.toContain(99);
    expect(diagnostics.vector).toMatchObject({
      status: "contributed",
      candidates: 3,
      contributed: 1,
    });
  });

  test("ranks vector candidates through governed scoring factors", async () => {
    const store = new MockStore(
      [
        node(1, "durable", { content: "vector only", confidence: "AMBIGUOUS" }),
        node(2, "durable", { content: "vector only", confidence: "EXTRACTED" }),
        node(3, "reasoning", { content: "vector only", confidence: "EXTRACTED" }),
        node(4, "durable", {
          content: "vector only",
          confidence: "EXTRACTED",
          created_at: NOW - RECENCY_HALF_LIFE_MS,
        }),
        node(5, "durable", { content: "vector only", confidence: "EXTRACTED" }),
        node(6, "durable", { content: "vector only", confidence: "EXTRACTED" }),
        node(7, "durable", { content: "centrality helper", confidence: "EXTRACTED" }),
      ],
      new Map(),
      [
        { from: 6, to: 7 },
        { from: 6, to: 5 },
      ],
      [1, 2, 3, 4, 5, 6].map((rid) => ({ rid, score: 1 })),
    );

    const { nodes } = await recall(store, "no textual overlap", { depth: 0, now: NOW });
    const byRid = new Map(nodes.map((n) => [n.rid, n]));

    expect(byRid.get(2)!.score).toBeGreaterThan(byRid.get(1)!.score);
    expect(byRid.get(2)!.score).toBeGreaterThan(byRid.get(3)!.score);
    expect(byRid.get(2)!.score).toBeGreaterThan(byRid.get(4)!.score);
    expect(byRid.get(6)!.score).toBeGreaterThan(byRid.get(5)!.score);
  });
});
