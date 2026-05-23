import { describe, expect, test } from "vitest";
import { computeProposalPriority, sortProposalSummaries } from "../src/proposal-priority.js";

describe("skill improvement proposal priority", () => {
  test("scores high-confidence repeated failures as high priority", () => {
    const priority = computeProposalPriority({
      reason: "4/5 results failed (80%)",
      recentFailures: 4,
      dominantErrorStage: "verify",
      dominantErrorClass: "ValidationError",
      patchDrafted: true,
    });

    expect(priority.priority).toBe("high");
    expect(priority.score).toBeGreaterThanOrEqual(0.8);
    expect(priority.reasons).toContain("failure ratio 80%");
    expect(priority.reasons).toContain("4 recent failure(s)");
    expect(priority.reasons).toContain("same error_stage repeated: verify");
    expect(priority.reasons).toContain("structured patch draft generated");
  });

  test("orders proposal summaries by score before skill name", () => {
    const sorted = sortProposalSummaries([
      { skill: "medium-risk", score: 0.62 },
      { skill: "high-risk", score: 0.91 },
      { skill: "alpha-risk", score: 0.62 },
    ]);

    expect(sorted.map((proposal) => proposal.skill)).toEqual(["high-risk", "alpha-risk", "medium-risk"]);
  });
});
