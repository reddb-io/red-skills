import { describe, expect, test } from "vitest";
import { buildPreflightBrief, type PreflightStore } from "../src/preflight.js";
import type { GraphRow, SearchRow, StoredNode } from "../src/graph-store.js";

class MockStore implements PreflightStore {
  constructor(
    private readonly nodes: StoredNode[],
    private readonly superseded: Map<number, number> = new Map(),
    private readonly edges: Record<string, unknown>[] = [],
    private readonly access: Map<number, { count: number; accessed_at: number }> = new Map(),
  ) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }

  async searchText(): Promise<SearchRow[]> {
    return [];
  }

  async neighborhood(): Promise<GraphRow[]> {
    throw new Error("preflight should use recall/listEdges, not per-seed graph walks");
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

  async accessRecords(): Promise<Map<number, { count: number; accessed_at: number }>> {
    return this.access;
  }
}

const DAY = 86_400_000;
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
      importance: 0.6,
      tier: "durable",
      created_at: NOW,
      ...extra,
    },
  };
}

describe("Memory preflight briefs", () => {
  test("turns task text into a cited structured brief", async () => {
    const store = new MockStore([
      node(1, "decision", "Context pack decision", "Decision: context packs must cite Memory evidence."),
      node(2, "workflow", "Preflight constraint", "Rule: preflight output must stay deterministic for CI."),
      node(3, "problem", "Brief pitfall", "Pitfall: unsupported prose misleads AFK runners."),
      node(4, "validation", "Validation command", "Validation: run pnpm test for memory changes."),
      node(5, "concept", "Impacted concept", "Concept: Memory briefs prepare agents before task work."),
    ]);

    const brief = await buildPreflightBrief(store, "build memory preflight brief", {
      now: NOW,
      minEvidence: 3,
    });

    expect(brief.status).toBe("ready");
    expect(brief.task).toBe("build memory preflight brief");
    expect(brief.summary.evidenceCount).toBe(5);
    expect(brief.sections.priorDecisions).toEqual([
      expect.objectContaining({ citation: "[M1]", urn: "memory_nodes:1" }),
    ]);
    expect(brief.sections.constraints).toEqual([
      expect.objectContaining({ citation: "[M2]", urn: "memory_nodes:2" }),
    ]);
    expect(brief.sections.pitfalls).toEqual([
      expect.objectContaining({ citation: "[M3]", urn: "memory_nodes:3" }),
    ]);
    expect(brief.sections.validations).toEqual([
      expect.objectContaining({ citation: "[M4]", urn: "memory_nodes:4" }),
    ]);
    expect(brief.sections.impactedConcepts).toEqual([
      expect.objectContaining({ citation: "[M5]", urn: "memory_nodes:5" }),
    ]);
    expect(brief.evidence.map((item) => item.urn)).toEqual([
      "memory_nodes:1",
      "memory_nodes:2",
      "memory_nodes:3",
      "memory_nodes:4",
      "memory_nodes:5",
    ]);
    expect(brief.markdown).toContain("[M1]");
    expect(brief.markdown).toContain("urn: memory_nodes:1");
    expect(brief.warnings).toEqual([]);
  });

  test("warns when relevant Memory evidence is missing", async () => {
    const brief = await buildPreflightBrief(new MockStore([]), "unknown task", {
      now: NOW,
      minEvidence: 2,
    });

    expect(brief.status).toBe("needs-evidence");
    expect(brief.evidence).toEqual([]);
    expect(brief.warnings).toEqual([
      expect.objectContaining({ kind: "missing-evidence", rids: [] }),
    ]);
    expect(brief.markdown).toContain("Status: needs-evidence");
  });

  test("flags stale, superseded, and contradictory evidence", async () => {
    const store = new MockStore(
      [
        node(1, "decision", "Old brief guidance", "Decision: preflight output can be ad hoc."),
        node(2, "decision", "Current brief guidance", "Decision: preflight output must be stable JSON."),
        node(3, "problem", "Contradicting pitfall", "Pitfall: stable JSON conflicts with free prose."),
        node(4, "workflow", "Cold workflow", "Rule: preflight workflows need review.", {
          created_at: NOW - 120 * DAY,
        }),
      ],
      new Map([[1, 2]]),
      [
        {
          label: "CONTRADICTS",
          from: 2,
          to: 3,
          properties: { reason: "free prose conflicts with stable JSON" },
        },
      ],
    );

    const brief = await buildPreflightBrief(store, "preflight stable json", {
      now: NOW,
      staleDays: 90,
      minEvidence: 2,
    });

    expect(brief.status).toBe("review-warnings");
    expect(brief.warnings).toEqual([
      expect.objectContaining({ kind: "superseded", rids: [1, 2] }),
      expect.objectContaining({ kind: "contradiction", rids: [2, 3] }),
      expect.objectContaining({ kind: "stale", rids: [4] }),
    ]);
    expect(brief.evidence.find((item) => item.rid === 1)?.statuses).toContain("superseded");
    expect(brief.evidence.find((item) => item.rid === 2)?.statuses).toContain("contradictory");
    expect(brief.evidence.find((item) => item.rid === 4)?.statuses).toContain("stale");
    expect(brief.sections.priorDecisions.map((item) => item.urn)).toEqual(["memory_nodes:2"]);
  });
});
