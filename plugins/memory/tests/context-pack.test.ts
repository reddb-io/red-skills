import { describe, expect, test } from "vitest";
import { buildContextPack, type ContextPackStore } from "../src/context-pack.js";
import type { GraphRow, SearchRow, StoredNode } from "../src/graph-store.js";

class MockStore implements ContextPackStore {
  constructor(
    private readonly nodes: StoredNode[],
    private readonly superseded: Map<number, number> = new Map(),
    private readonly edges: Record<string, unknown>[] = [],
  ) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }

  async searchText(): Promise<SearchRow[]> {
    return [];
  }

  async neighborhood(): Promise<GraphRow[]> {
    throw new Error("context pack should use recall/listEdges, not per-seed graph walks");
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

function node(
  rid: number,
  node_type: StoredNode["node_type"],
  title: string,
  content: string,
  extra: Partial<StoredNode["properties"]> = {},
): StoredNode {
  return {
    rid,
    label: title.toLowerCase().replace(/\W+/g, "-"),
    node_type,
    properties: {
      title,
      content,
      confidence: "EXTRACTED",
      source: "manual",
      importance: 0.8,
      tier: "durable",
      created_at: NOW,
      ...extra,
    },
  };
}

describe("context packs", () => {
  test("groups recalled evidence into budgeted cited sections", async () => {
    const store = new MockStore([
      node(1, "concept", "Auth token constraint", "Token TTL changes must update docs/security.md."),
      node(2, "decision", "JWT library decision", "Decision: use jose for JWT verification."),
      node(3, "problem", "JWT staging pitfall", "Pitfall: staging rejects tokens when clock skew exceeds 30 seconds."),
      node(4, "fix", "JWT refresh prior work", "Similar past work: refresh rotation landed in issue 92."),
      node(5, "workflow", "Do not bypass JWT checks", "Do not bypass JWT checks in tests; use signed fixtures."),
    ]);

    const pack = await buildContextPack(store, "jwt token work", {
      budgetChars: 2_000,
      now: NOW,
    });

    expect(pack.status).toBe("ok");
    expect(pack.markdown.length).toBeLessThanOrEqual(2_000);
    expect(pack.markdown).toContain("## Hard constraints");
    expect(pack.markdown).toContain("## Prior decisions");
    expect(pack.markdown).toContain("## Known pitfalls");
    expect(pack.markdown).toContain("## Similar past work");
    expect(pack.markdown).toContain("## Do-not-do guidance");
    expect(pack.markdown).toContain("[M1]");
    expect(pack.markdown).toContain("urn: memory_nodes:1");
    expect(pack.markdown).toContain("Reason:");
    expect(pack.entries.map((entry) => entry.citation.urn)).toEqual([
      "memory_nodes:1",
      "memory_nodes:2",
      "memory_nodes:3",
      "memory_nodes:4",
      "memory_nodes:5",
    ]);
  });

  test("returns an explicit insufficient-context result for empty recall", async () => {
    const pack = await buildContextPack(new MockStore([]), "missing topic", {
      budgetChars: 500,
      now: NOW,
    });

    expect(pack.status).toBe("insufficient-context");
    expect(pack.entries).toEqual([]);
    expect(pack.markdown).toContain("Status: insufficient-context");
    expect(pack.markdown).toContain("No strong Memory evidence");
    expect(pack.markdown.length).toBeLessThanOrEqual(500);
  });

  test("surfaces superseded and contradictory evidence as warnings", async () => {
    const store = new MockStore(
      [
        node(1, "decision", "Old deploy decision", "Decision: deploy jwt changes on Fridays."),
        node(2, "decision", "Current deploy decision", "Decision: deploy jwt changes on Tuesdays."),
        node(3, "problem", "Token cache conflict", "Pitfall: token cache settings conflict with Tuesday deploys."),
      ],
      new Map([[1, 2]]),
      [
        {
          label: "CONTRADICTS",
          from: 2,
          to: 3,
          properties: { reason: "cache guidance disagrees with deploy window" },
        },
      ],
    );

    const pack = await buildContextPack(store, "jwt deploy", { budgetChars: 2_000, now: NOW });

    expect(pack.warnings).toEqual([
      expect.objectContaining({ kind: "superseded", rids: [1, 2] }),
      expect.objectContaining({ kind: "contradiction", rids: [2, 3] }),
    ]);
    expect(pack.entries.map((entry) => entry.citation.rid)).not.toContain(1);
    expect(pack.markdown).toContain("## Warnings");
    expect(pack.markdown).toContain("superseded by memory_nodes:2");
    expect(pack.markdown).toContain("contradicts memory_nodes:3");
  });

  test("keeps deterministic ranking order while enforcing the caller budget", async () => {
    const store = new MockStore([
      node(1, "decision", "High rank decision", "Decision: jwt deploy jwt rollout uses canaries."),
      node(2, "decision", "Lower rank decision", "Decision: jwt rollout keeps logs quiet."),
    ]);

    const fullPack = await buildContextPack(store, "jwt deploy", {
      budgetChars: 2_000,
      now: NOW,
    });
    expect(fullPack.entries.map((entry) => entry.citation.rid)).toEqual([1, 2]);

    const budgeted = await buildContextPack(store, "jwt deploy", {
      budgetChars: 360,
      now: NOW,
    });
    expect(budgeted.markdown.length).toBeLessThanOrEqual(360);
    expect(budgeted.entries.map((entry) => entry.citation.rid)).toEqual([1]);
    expect(budgeted.omittedEntries).toBe(1);
    expect(budgeted.warnings).toEqual([
      expect.objectContaining({ kind: "budget", rids: [2] }),
    ]);
  });
});
