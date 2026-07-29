import { describe, expect, it } from "vitest";
import {
  renderReseedTrail,
  reseedTrailMarker,
} from "../src/core/process-issue/reseed-trail.js";

describe("renderReseedTrail (#2731)", () => {
  const view = {
    issue: 9,
    branch: "afk/9-thing",
    lane: "/afk",
    ceiling: 4,
    rounds: [
      { round: 1, trigger: "gate-stage" as const, cause: "gate" as const, note: "feedback machine gate failed" },
      { round: 2, trigger: "review-finding" as const, cause: "review" as const, note: "blocking finding" },
    ],
  };

  it("carries the issue-scoped marker that makes the comment upsertable", () => {
    expect(renderReseedTrail(view)).toContain(reseedTrailMarker(9));
    expect(reseedTrailMarker(9)).not.toBe(reseedTrailMarker(10));
  });

  it("renders every round with its trigger, cause, and note", () => {
    const body = renderReseedTrail(view);
    expect(body).toContain("gate-stage");
    expect(body).toContain("feedback machine gate failed");
    expect(body).toContain("review-finding");
    expect(body).toContain("blocking finding");
    expect(body).toContain("2/4");
  });

  it("names the Attempt record as the source of truth, not itself", () => {
    expect(renderReseedTrail(view)).toContain("derived projection");
  });

  it("escapes a pipe in a note so one round cannot break the table", () => {
    const body = renderReseedTrail({
      ...view,
      rounds: [{ round: 1, trigger: "gate-stage", cause: "gate", note: "pnpm a | pnpm b failed" }],
    });
    expect(body).toContain("pnpm a \\| pnpm b failed");
  });
});
