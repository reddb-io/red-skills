import { describe, expect, it } from "vitest";
import {
  renderReseedTrail,
  reseedParkMarker,
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

  it("names the Worker's branch and log as the source of truth, not itself", () => {
    const body = renderReseedTrail(view);
    expect(body).toContain("derived projection");
    // The record this line used to name no longer exists (#2788): a trail that
    // still points a human at it points them at nothing.
    expect(body).not.toMatch(/attempt/i);
    expect(body).toContain("Worker");
  });

  it("says nothing about a park while the budget still has rounds (#2732)", () => {
    const body = renderReseedTrail(view);
    expect(body).not.toContain(reseedParkMarker(9));
    expect(body).not.toContain("blocked:validation");
  });

  it("carries the blocked-validation marker and the evidence once parked (#2732)", () => {
    const body = renderReseedTrail({
      ...view,
      park: { evidence: '{"check":"test","status":"failed"}' },
    });
    expect(body).toContain(reseedParkMarker(9));
    expect(reseedParkMarker(9)).toContain("blocked:validation");
    expect(body).toContain('{"check":"test","status":"failed"}');
    // The rounds already spent stay on the park: the human reads the whole
    // correction history and the evidence that ended it in one place.
    expect(body).toContain("feedback machine gate failed");
    expect(body).toContain("blocking finding");
  });

  it("escapes a pipe in a note so one round cannot break the table", () => {
    const body = renderReseedTrail({
      ...view,
      rounds: [{ round: 1, trigger: "gate-stage", cause: "gate", note: "pnpm a | pnpm b failed" }],
    });
    expect(body).toContain("pnpm a \\| pnpm b failed");
  });
});
