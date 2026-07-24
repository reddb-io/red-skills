import { describe, expect, test } from "vitest";
import {
  buildLearningDebtReport,
  type LearningDebtStore,
} from "../src/learning-debt.js";
import { buildLearningDebtViewerArtifact } from "../src/learning-debt-viewer.js";
import type { StoredNode } from "../src/graph-store.js";
import type { SkillRollup } from "../src/skill-events.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

class MockStore implements LearningDebtStore {
  constructor(
    private readonly nodes: StoredNode[],
    private readonly edges: Record<string, unknown>[] = [],
    private readonly superseded: Map<number, number> = new Map(),
    private readonly access: Map<number, { count: number; accessed_at: number }> = new Map(),
  ) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }

  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.edges;
  }

  async supersededByMany(rids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const rid of rids) {
      const to = this.superseded.get(rid);
      if (to != null) out.set(rid, to);
    }
    return out;
  }

  async accessRecords(): Promise<Map<number, { count: number; accessed_at: number }>> {
    return this.access;
  }
}

function node(
  rid: number,
  node_type: StoredNode["node_type"],
  title: string,
  extra: Partial<StoredNode["properties"]> = {},
): StoredNode {
  return {
    rid,
    label: title.toLowerCase().replace(/\W+/g, "-"),
    node_type,
    properties: {
      title,
      content: title,
      confidence: "EXTRACTED",
      source: "manual",
      importance: 0.4,
      tier: node_type === "worker" ? "reasoning" : "durable",
      created_at: NOW,
      accessed_at: NOW,
      access_count: 1,
      ...extra,
    },
  };
}

function rollup(name: string, failed: number, overrides: Partial<SkillRollup> = {}): SkillRollup {
  return {
    name,
    source_kind: "plugin",
    path: `/skills/${name}/SKILL.md`,
    first_seen: "2026-05-22T16:00:00.000Z",
    last_activity: "2026-05-22T16:05:00.000Z",
    event_count: failed,
    view_count: 0,
    use_count: failed,
    patch_count: 0,
    change_count: 0,
    result_count: failed,
    outcome_counts: { failed },
    curatable_status: "active",
    archive_signal: false,
    consolidation_signal: false,
    ...overrides,
  };
}

describe("Memory learning debt reports", () => {
  test("summarizes repeated failures, stale guidance, validation gaps, and skill telemetry gaps", async () => {
    const nodes = [
      node(1, "worker", "issue 10 blocked validation", {
        issue_number: 10,
        status: "blocked",
        error_class: "validation",
        touched_files: ["plugins/memory/src/cli.ts"],
      }),
      node(2, "worker", "issue 10 blocked validation again", {
        issue_number: 10,
        status: "blocked",
        error_class: "validation",
        touched_files: ["plugins/memory/src/cli.ts"],
      }),
      node(3, "workflow", "Old operational workflow", {
        content: "Rule: run memory reports before AFK merges.",
        created_at: NOW - 120 * DAY,
        accessed_at: NOW - 120 * DAY,
        access_count: 0,
      }),
      node(4, "decision", "Contradicted active decision"),
      node(5, "decision", "Opposing active decision"),
      node(6, "fix", "Implementation evidence without validation", {
        content: "Fix: add a learning debt report command.",
      }),
      node(7, "validation", "Existing validation"),
      node(8, "why_note", "Durable lesson for another failure", {
        content: "Lesson: another issue learned from a blocked run.",
      }),
    ];

    const report = await buildLearningDebtReport(new MockStore(nodes, [
      { label: "CONTRADICTS", from: 4, to: 5, properties: { reason: "new rule disagrees" } },
      { label: "LEARNED_FROM", from: 8, to: 99 },
    ]), {
      now: NOW,
      staleDays: 90,
      rollups: [rollup("dev:tdd", 3), rollup("dev:review", 2, { patch_count: 1 })],
      skillTelemetryEnabled: true,
    });

    expect(report.status).toBe("debt-found");
    expect(report.schema_version).toBe("memory.learning_debt.v1");
    expect(report.read_only).toBe(true);
    expect(report.summary).toMatchObject({
      repeatedFailurePatterns: 1,
      staleOrContradictedGuidance: 2,
      missingValidationEvidence: 1,
      skillTelemetryGaps: 1,
    });
    expect(report.categories.repeatedFailurePatterns[0]).toMatchObject({
      pattern: "issue:10 error:validation",
      attemptCount: 2,
      hasDurableLesson: false,
      citations: ["memory_nodes:1", "memory_nodes:2"],
    });
    expect(report.categories.staleOrContradictedGuidance.map((item) => item.kind)).toEqual([
      "contradicted-guidance",
      "stale-guidance",
    ]);
    expect(report.categories.missingValidationEvidence[0]).toMatchObject({
      evidence: "memory_nodes:6",
      nodeType: "fix",
    });
    expect(report.categories.skillTelemetryGaps[0]).toMatchObject({
      kind: "repeated-skill-failures",
      skill: "dev:tdd",
      failed: 3,
    });
    expect(report.markdown).toContain("# Memory learning debt");
    expect(report.markdown).toContain("Repeated Failure Patterns");

    const artifact = buildLearningDebtViewerArtifact(report);
    expect(artifact.contract).toEqual({
      name: "memory.learning_debt.viewer",
      version: "memory.learning_debt.viewer.v1",
      consumes: "memory.learning_debt.v1",
    });
    expect(artifact.html).toContain("Learning Debt");
    expect(artifact.html).toContain("issue:10 error:validation");
    expect(artifact.html).toContain("dev:tdd");
    expect(artifact.html).toContain('id="learning-debt-data"');
    expect(artifact.html).not.toContain("<script src=");
  });
});
