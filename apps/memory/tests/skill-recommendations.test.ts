import { describe, expect, test } from "vitest";
import {
  buildSkillRecommendationsFromEvidence,
  type SkillRecommendationRecalledNode,
} from "../src/skill-recommendations.js";
import type { SkillRollup } from "../src/skill-events.js";

function rollup(name: string, overrides: Partial<SkillRollup> = {}): SkillRollup {
  return {
    name,
    source_kind: "plugin",
    path: `/plugins/dev/skills/engineering/${name.replace(/^dev:/, "")}/SKILL.md`,
    first_seen: "2026-05-22T16:00:00.000Z",
    last_activity: "2026-05-22T17:00:00.000Z",
    event_count: 4,
    view_count: 1,
    use_count: 1,
    patch_count: 0,
    change_count: 0,
    result_count: 2,
    outcome_counts: { succeeded: 2 },
    curatable_status: "active",
    archive_signal: false,
    consolidation_signal: false,
    ...overrides,
  };
}

function evidence(
  rid: number,
  title: string,
  content: string,
  tags: string[] = [],
): SkillRecommendationRecalledNode {
  return {
    rid,
    label: title.toLowerCase().replace(/\W+/g, "-"),
    node_type: "workflow",
    score: 0.85,
    excerpt: content,
    properties: {
      title,
      content,
      tags,
      confidence: "EXTRACTED",
      source: "manual",
    },
  };
}

describe("skill recommendations", () => {
  test("ranks a task-text match from Skill telemetry with citations and reasons", () => {
    const report = buildSkillRecommendationsFromEvidence(
      "use TDD for a regression fix",
      [],
      [rollup("dev:tdd")],
    );

    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0]).toMatchObject({
      name: "dev:tdd",
      evidenceStrength: "moderate",
    });
    expect(report.recommendations[0].reasons.join(" ")).toContain("task text matched");
    expect(report.recommendations[0].citations).toEqual([
      expect.objectContaining({
        kind: "telemetry",
        marker: "[T1]",
        urn: "skill-telemetry:plugin:dev:tdd",
      }),
    ]);
  });

  test("recommends a skill named by recalled Memory evidence", () => {
    const report = buildSkillRecommendationsFromEvidence(
      "debug a flaky failure",
      [
        evidence(
          42,
          "Debugging workflow",
          "When a task is about debugging or reproducing a failure, use dev:diagnose.",
          ["skill:dev:diagnose"],
        ),
      ],
      [],
    );

    expect(report.recommendations[0]).toMatchObject({
      name: "dev:diagnose",
      evidenceStrength: "moderate",
    });
    expect(report.recommendations[0].reasons.join(" ")).toContain("Memory evidence");
    expect(report.recommendations[0].citations).toEqual([
      expect.objectContaining({
        kind: "memory",
        marker: "[M1]",
        urn: "memory_nodes:42",
      }),
    ]);
  });
});
