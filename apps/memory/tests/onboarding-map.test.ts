import { describe, expect, test } from "vitest";
import {
  buildOnboardingMap,
  type OnboardingMapStore,
} from "../src/onboarding-map.js";
import { buildOnboardingMapViewerArtifact } from "../src/onboarding-map-viewer.js";
import type { StoredNode } from "../src/graph-store.js";
import type { SkillRollup } from "../src/skill-events.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

class MockStore implements OnboardingMapStore {
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
      content: `${title} evidence body`,
      summary: `${title} summary`,
      confidence: "EXTRACTED",
      source: "manual",
      importance: 0.4,
      tier: "durable",
      created_at: NOW,
      accessed_at: NOW,
      access_count: 1,
      ...extra,
    },
  };
}

function rollup(name: string, overrides: Partial<SkillRollup> = {}): SkillRollup {
  return {
    name,
    source_kind: "plugin",
    path: `/plugins/dev/skills/${name}/SKILL.md`,
    first_seen: "2026-05-22T16:00:00.000Z",
    last_activity: "2026-05-22T16:05:00.000Z",
    event_count: 3,
    view_count: 1,
    use_count: 1,
    patch_count: 0,
    change_count: 0,
    result_count: 1,
    outcome_counts: { succeeded: 1 },
    curatable_status: "active",
    archive_signal: false,
    consolidation_signal: false,
    ...overrides,
  };
}

describe("Memory onboarding map", () => {
  test("builds stable cited sections and flags stale, superseded, and contradictory evidence", async () => {
    const nodes = [
      node(1, "concept", "Memory graph mode"),
      node(2, "workflow", "AFK handoff workflow", {
        content: "Agents read handoff files before planning.",
        created_at: NOW - 120 * DAY,
        accessed_at: NOW - 120 * DAY,
        access_count: 0,
      }),
      node(3, "decision", "Old CLI report shape"),
      node(4, "decision", "Current CLI report shape"),
      node(5, "problem", "Recall latency risk"),
      node(6, "problem", "Opposing risk note"),
      node(7, "validation", "Onboarding map tests"),
    ];

    const map = await buildOnboardingMap(
      new MockStore(
        nodes,
        [{ label: "CONTRADICTS", from: 5, to: 6, properties: { reason: "risk owner disagrees" } }],
        new Map([[3, 4]]),
      ),
      {
        now: NOW,
        staleDays: 90,
        rollups: [rollup("dev:tdd"), rollup("dev:review", { use_count: 0, result_count: 0 })],
      },
    );

    expect(Object.keys(map.sections)).toEqual([
      "concepts",
      "workflows",
      "decisions",
      "risks",
      "validations",
      "suggestedSkills",
    ]);
    expect(map).toMatchObject({
      schema_version: "memory.onboarding_map.v1",
      read_only: true,
    });
    expect(map.summary).toMatchObject({
      concepts: 1,
      workflows: 1,
      decisions: 2,
      risks: 2,
      validations: 1,
      suggestedSkills: 1,
      warnings: 3,
    });
    expect(map.sections.concepts[0]).toMatchObject({
      citation: "[M1]",
      urn: "memory_nodes:1",
      title: "Memory graph mode",
      statuses: ["active"],
    });
    expect(map.sections.workflows[0].statuses).toEqual(["active", "stale"]);
    expect(map.sections.decisions.map((item) => item.statuses)).toEqual([
      ["superseded"],
      ["active"],
    ]);
    expect(map.sections.risks.map((item) => item.statuses)).toEqual([
      ["active", "contradictory"],
      ["active", "contradictory"],
    ]);
    expect(map.sections.suggestedSkills[0]).toMatchObject({
      citation: "[S1]",
      name: "dev:tdd",
      evidence: "skill-rollup:dev:tdd",
      reason: "dev:tdd has Memory skill telemetry with 1 use(s) and 1 result(s).",
    });
    expect(map.warnings.map((warning) => warning.kind)).toEqual([
      "superseded",
      "contradiction",
      "stale",
    ]);
    expect(map.markdown).toContain("# Memory onboarding map");
    expect(map.markdown).toContain("## Suggested Skills");
    expect(map.markdown).toContain("[M5] Recall latency risk");

    const artifact = buildOnboardingMapViewerArtifact(map);
    expect(artifact.contract).toEqual({
      name: "memory.onboarding_map.viewer",
      version: "memory.onboarding_map.viewer.v1",
      consumes: "memory.onboarding_map.v1",
    });
    expect(artifact.html).toContain("Onboarding Map");
    expect(artifact.html).toContain("Recall latency risk");
    expect(artifact.html).toContain('id="onboarding-map-data"');
    expect(artifact.html).not.toContain("<script src=");
  });
});
