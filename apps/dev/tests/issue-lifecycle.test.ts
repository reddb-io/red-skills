import { describe, expect, it } from "vitest";
import {
  ISSUE_LIFECYCLE_TRANSITIONS,
  IllegalIssueLifecycleTransitionError,
  classifyIssueLifecycleState,
  validateIssueLifecycleTransition,
  type IssueLifecycleEdge,
} from "../src/core/issue-lifecycle.js";

describe("issue lifecycle transition table", () => {
  it("classifies lifecycle states from the triage label vocabulary", () => {
    expect(classifyIssueLifecycleState(["ready-for-agent"])).toBe("ready-for-agent");
    expect(classifyIssueLifecycleState(["running"])).toBe("claimed/active");
    expect(classifyIssueLifecycleState(["blocked:dependency"])).toBe("blocked:dependency");
    expect(classifyIssueLifecycleState(["ready-for-human", "blocked:validation"])).toBe("blocked:validation");
    expect(classifyIssueLifecycleState(["ready-for-human"])).toBe("ready-for-human");
    expect(classifyIssueLifecycleState(["ready-for-human", "landing:manual"])).toBe("landing:manual");
  });

  it("has table rows for every edge the runtime validates", () => {
    const edges = new Set(ISSUE_LIFECYCLE_TRANSITIONS.map((row) => row.edge));
    const expected: IssueLifecycleEdge[] = [
      "claim",
      "retry",
      "dependency-unblocked",
      "dependency-blocked",
      "preflight-blocked",
      "validation-blocked",
      "human-blocked",
      "human-delegable",
      "manual-landing",
      "close",
      "requeue",
      "requeue-mixed-blocked-refusal",
    ];
    expect([...edges].sort()).toEqual([...expected].sort());
  });

  it("accepts legal AFK runtime transitions", () => {
    expect(
      validateIssueLifecycleTransition({
        edge: "claim",
        fromLabels: ["ready-for-agent"],
        removeLabels: ["ready-for-agent"],
        addLabels: ["running"],
      }),
    ).toEqual(["running"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "validation-blocked",
        fromLabels: ["running"],
        removeLabels: ["running"],
        addLabels: ["ready-for-human", "blocked:validation"],
      }).sort(),
    ).toEqual(["blocked:validation", "ready-for-human"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "retry",
        fromLabels: ["running"],
        removeLabels: ["running"],
        addLabels: ["ready-for-agent"],
      }),
    ).toEqual(["ready-for-agent"]);
  });

  it("accepts legal requeue and HITL transitions", () => {
    expect(
      validateIssueLifecycleTransition({
        edge: "requeue",
        fromLabels: ["ready-for-human", "blocked:spec"],
        removeLabels: ["ready-for-human", "blocked:spec"],
        addLabels: ["ready-for-agent"],
      }),
    ).toEqual(["ready-for-agent"]);

    expect(
      validateIssueLifecycleTransition({
        edge: "human-delegable",
        fromLabels: ["ready-for-human", "blocked:validation"],
        removeLabels: ["ready-for-human", "blocked:validation"],
        addLabels: ["ready-for-agent"],
      }),
    ).toEqual(["ready-for-agent"]);
  });

  it("rejects illegal mixed blocked states through a table edge", () => {
    expect(() =>
      validateIssueLifecycleTransition({
        edge: "requeue-mixed-blocked-refusal",
        fromLabels: ["ready-for-human", "blocked:validation", "blocked:spec"],
        removeLabels: [],
        addLabels: [],
      }),
    ).toThrow(/mixed blocked:\* labels \[blocked:validation, blocked:spec\]/);
  });

  it("rejects illegal transitions with an actionable edge name", () => {
    let thrown: unknown;
    try {
      validateIssueLifecycleTransition({
        edge: "claim",
        fromLabels: ["ready-for-human"],
        removeLabels: ["ready-for-human"],
        addLabels: ["running"],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IllegalIssueLifecycleTransitionError);
    expect((thrown as Error).message).toContain('illegal issue lifecycle transition "claim"');
    expect((thrown as Error).message).toContain("no legal row");
  });

  it("rejects impossible queued or active blocked label combinations", () => {
    expect(() =>
      validateIssueLifecycleTransition({
        edge: "retry",
        fromLabels: ["running"],
        removeLabels: ["running"],
        addLabels: ["ready-for-agent", "blocked:validation"],
      }),
    ).toThrow(/queued\/active issue cannot also carry blocked:\*/);
  });
});
