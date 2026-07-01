import { describe, expect, it } from "vitest";
import {
  advisoryReviewPending,
  decideShipMergeGate,
  isShipWorktreePath,
  issueNumberFromBranch,
  normalizeRollupEntry,
  shipChecksAreGreen,
  decidePrePrShipGate,
  isPrePrFindingMechanical,
  runShipPipeline,
  classifyFix,
  decideFixApplication,
  SHIP_PIPELINE_STAGES,
  type PrePrFinding,
} from "../src/core/ship.js";

describe("decideShipMergeGate", () => {
  it("merges when checks are green and protection does not require approval", () => {
    expect(decideShipMergeGate({
      branchProtectionSatisfied: true,
      changesRequested: false,
      checksGreen: true,
      timedOut: false,
    })).toBe("merge");
  });

  it("parks for HITL when branch protection requires approval", () => {
    expect(decideShipMergeGate({
      branchProtectionSatisfied: false,
      changesRequested: false,
      checksGreen: true,
      timedOut: false,
    })).toBe("hitl");
  });

  it("parks for HITL when any review requested changes", () => {
    expect(decideShipMergeGate({
      branchProtectionSatisfied: true,
      changesRequested: true,
      checksGreen: true,
      timedOut: false,
    })).toBe("hitl");
  });

  it("parks for HITL when the monitor time cap is exceeded", () => {
    expect(decideShipMergeGate({
      branchProtectionSatisfied: true,
      changesRequested: false,
      checksGreen: true,
      timedOut: true,
    })).toBe("hitl");
  });
});

describe("ship helpers", () => {
  it("treats success, neutral, and skipped checks as green", () => {
    expect(shipChecksAreGreen([
      { state: "SUCCESS" },
      { conclusion: "NEUTRAL" },
      { bucket: "SKIPPING" },
    ])).toBe(true);
  });

  it("treats pending or failing checks as not green", () => {
    expect(shipChecksAreGreen([{ state: "SUCCESS" }, { state: "PENDING" }])).toBe(false);
    expect(shipChecksAreGreen([{ conclusion: "FAILURE" }])).toBe(false);
  });

  it("extracts issue numbers from common ship and afk branch names", () => {
    expect(issueNumberFromBranch("ship/395-finalizer")).toBe(395);
    expect(issueNumberFromBranch("afk/wMM83/395-ship-interactive-review-respecting-final")).toBe(395);
  });

  it("recognises only the exempt ship worktree path family", () => {
    expect(isShipWorktreePath("/repo/.red/tmp/work-ship-abc/worktree")).toBe(true);
    expect(isShipWorktreePath("/repo/.red/tmp/work-ship-abc/worktree/plugins/dev")).toBe(true);
    expect(isShipWorktreePath("/repo/.red/tmp/work-abc/worktree")).toBe(false);
  });
});

describe("normalizeRollupEntry (#857 — statusCheckRollup fallback)", () => {
  it("maps a CheckRun entry (name/status/conclusion) to ShipCheck", () => {
    expect(normalizeRollupEntry({ __typename: "CheckRun", name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" }))
      .toEqual({ name: "typecheck", state: "COMPLETED", conclusion: "SUCCESS" });
  });

  it("maps an in-progress CheckRun (null conclusion) to ShipCheck", () => {
    expect(normalizeRollupEntry({ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }))
      .toEqual({ name: "test", state: "IN_PROGRESS", conclusion: undefined });
  });

  it("maps a StatusContext entry (context/state) to ShipCheck", () => {
    expect(normalizeRollupEntry({ __typename: "StatusContext", context: "ci/circleci", state: "SUCCESS" }))
      .toEqual({ name: "ci/circleci", state: "SUCCESS", conclusion: undefined });
  });

  it("a mixed rollup with all-green entries is green", () => {
    const rollup = [
      { __typename: "CheckRun", name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "Skill first-line bold check", state: "SUCCESS" },
    ].map(normalizeRollupEntry);
    expect(shipChecksAreGreen(rollup)).toBe(true);
  });

  it("a mixed rollup with an in-progress CheckRun is not green", () => {
    const rollup = [
      { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null },
      { __typename: "StatusContext", context: "typecheck", state: "SUCCESS" },
    ].map(normalizeRollupEntry);
    expect(shipChecksAreGreen(rollup)).toBe(false);
  });

  it("empty rollup is treated as green (no checks configured)", () => {
    expect(shipChecksAreGreen([])).toBe(true);
  });

  it("advisoryReviewPending works on normalized StatusContext entry", () => {
    const rollup = [
      { __typename: "StatusContext", context: "coderabbitai[bot]", state: "PENDING" },
    ].map(normalizeRollupEntry);
    expect(advisoryReviewPending(rollup, "coderabbit")).toBe(true);
  });
});

describe("advisoryReviewPending (#589 — /ship waits for in-flight advisory bot reviews)", () => {
  it("is pending while the named review check is registered but in flight", () => {
    expect(advisoryReviewPending([{ name: "CodeRabbit", state: "PENDING" }], "CodeRabbit")).toBe(true);
    // gh can report an as-yet-unstarted check with a blank state.
    expect(advisoryReviewPending([{ name: "CodeRabbit" }], "CodeRabbit")).toBe(true);
  });

  it("is not pending once the review check has concluded (any verdict)", () => {
    expect(advisoryReviewPending([{ name: "CodeRabbit", state: "SUCCESS" }], "CodeRabbit")).toBe(false);
    expect(advisoryReviewPending([{ name: "CodeRabbit", state: "FAILURE" }], "CodeRabbit")).toBe(false);
    expect(advisoryReviewPending([{ name: "CodeRabbit", conclusion: "NEUTRAL" }], "CodeRabbit")).toBe(false);
  });

  it("fails open: an absent reviewer or a blank check name never wedges /ship", () => {
    expect(advisoryReviewPending([{ name: "CI", state: "PENDING" }], "CodeRabbit")).toBe(false);
    expect(advisoryReviewPending([], "CodeRabbit")).toBe(false);
    expect(advisoryReviewPending([{ name: "CodeRabbit", state: "PENDING" }], "")).toBe(false);
  });

  it("matches the check by case-insensitive substring", () => {
    expect(advisoryReviewPending([{ name: "coderabbitai[bot]", state: "PENDING" }], "coderabbit")).toBe(true);
  });
});

describe("no-mistakes pre-PR pipeline (#913 — findings classification)", () => {
  it("classifies mechanical findings (infra, style, format)", () => {
    // Mechanical findings: code-review suggestions for obvious style, format, or lint fixes
    // that do not change intent or introduce risk
    expect(isPrePrFindingMechanical({
      category: "lint",
      severity: "low",
      file: "src/foo.ts",
      line: 10,
      message: "unused variable",
      suggestion: "remove the variable",
    })).toBe(true);

    expect(isPrePrFindingMechanical({
      category: "format",
      severity: "low",
      file: "src/foo.ts",
      line: 15,
      message: "trailing whitespace",
      suggestion: "remove whitespace",
    })).toBe(true);

    expect(isPrePrFindingMechanical({
      category: "docs",
      severity: "low",
      file: "src/foo.ts",
      line: 20,
      message: "missing JSDoc",
      suggestion: "add JSDoc comment",
    })).toBe(true);
  });

  it("escalates intent-changing findings (logic, type safety, semantics)", () => {
    // Intent findings: changes that affect behavior, type safety, or require semantic judgment
    expect(isPrePrFindingMechanical({
      category: "logic",
      severity: "high",
      file: "src/foo.ts",
      line: 10,
      message: "potential null dereference",
      suggestion: "add null check",
    })).toBe(false);

    expect(isPrePrFindingMechanical({
      category: "type",
      severity: "medium",
      file: "src/foo.ts",
      line: 15,
      message: "implicit any",
      suggestion: "add type annotation",
    })).toBe(false);

    expect(isPrePrFindingMechanical({
      category: "semantics",
      severity: "high",
      file: "src/foo.ts",
      line: 20,
      message: "API contract violation",
      suggestion: "adjust parameter",
    })).toBe(false);
  });

  it("the pre-PR gate rejects push when intent findings are present", () => {
    const gateInput = {
      feedbackPassed: false,
      intentFindingsPresent: true,
      mechanicalFindingsPresent: true,
      timedOut: false,
    };
    // When intent findings are present, /ship must escalate to human approval
    expect(decidePrePrShipGate(gateInput)).toBe("escalate");
  });

  it("the pre-PR gate auto-applies mechanical findings when no intent findings", () => {
    const gateInput = {
      feedbackPassed: false,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: true,
      timedOut: false,
    };
    // When only mechanical findings, /ship auto-applies them
    expect(decidePrePrShipGate(gateInput)).toBe("auto-apply");
  });

  it("the pre-PR gate pushes when feedback is green and no intent findings", () => {
    const gateInput = {
      feedbackPassed: true,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: false,
      timedOut: false,
    };
    // Clean feedback and no findings → proceed to push
    expect(decidePrePrShipGate(gateInput)).toBe("push");
  });

  it("the pre-PR gate escalates when feedback fails (semantic)", () => {
    const gateInput = {
      feedbackPassed: false,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: false,
      timedOut: false,
    };
    // Feedback failure means semantic issues → escalate
    expect(decidePrePrShipGate(gateInput)).toBe("escalate");
  });

  it("the pre-PR gate escalates when time cap is exceeded", () => {
    const gateInput = {
      feedbackPassed: true,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: false,
      timedOut: true,
    };
    expect(decidePrePrShipGate(gateInput)).toBe("escalate");
  });
});

describe("ordered ship pipeline (#989 — Track 2B)", () => {
  const allGreen = {
    review: { passed: true },
    test: { passed: true },
    docs: { passed: true },
    lint: { passed: true },
    push: { passed: true },
    pr: { passed: true },
    ci: { passed: true },
  } as const;

  it("declares the seven stages in mandatory order", () => {
    expect([...SHIP_PIPELINE_STAGES]).toEqual([
      "review",
      "test",
      "docs",
      "lint",
      "push",
      "pr",
      "ci",
    ]);
  });

  it("passes when all seven stages are green", () => {
    expect(runShipPipeline(allGreen)).toEqual({ status: "passed", failedStage: null });
  });

  it("stops at stage N and reports the stage name and reason", () => {
    // Test (stage 2, index 1) fails: the pipeline must stop there and never
    // consult docs/lint/push/pr/ci, even though later stages would also fail.
    const result = runShipPipeline({
      review: { passed: true },
      test: { passed: false, reason: "3 tests failing" },
    });
    expect(result).toEqual({
      status: "failed",
      failedStage: "test",
      stageIndex: 1,
      reason: "3 tests failing",
    });
  });

  it("fails at the earliest failing stage regardless of input key order", () => {
    // ci is listed first in the object but review (index 0) fails, so review wins.
    const result = runShipPipeline({
      ci: { passed: false, reason: "ci red" },
      review: { passed: false, reason: "obvious bug in diff" },
      test: { passed: false, reason: "would also fail" },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failedStage).toBe("review");
      expect(result.stageIndex).toBe(0);
      expect(result.reason).toBe("obvious bug in diff");
    }
  });

  it("treats a missing (not-run) stage as a failure at that stage", () => {
    const result = runShipPipeline({ review: { passed: true } });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failedStage).toBe("test");
      expect(result.reason).toContain("did not run");
    }
  });
});

describe("mechanical vs intentional fix split (#989 — Track 2B)", () => {
  const trailingWhitespace: PrePrFinding = {
    category: "format",
    severity: "low",
    file: "src/foo.ts",
    line: 12,
    message: "trailing whitespace",
    suggestion: "remove whitespace",
  };

  const renamePublicSymbol: PrePrFinding = {
    category: "semantics",
    severity: "high",
    file: "src/foo.ts",
    line: 40,
    message: "public symbol should be renamed",
    suggestion: "rename export",
  };

  it("labels a mechanical fix and applies it silently; labels an intentional fix and escalates it", () => {
    // A mechanical fix (trailing whitespace) is labelled and auto-applied.
    expect(classifyFix(trailingWhitespace)).toBe("mechanical");
    expect(decideFixApplication(trailingWhitespace)).toBe("auto-apply");

    // An intentional change (renaming a public symbol) is labelled and escalated.
    expect(classifyFix(renamePublicSymbol)).toBe("intentional");
    expect(decideFixApplication(renamePublicSymbol)).toBe("escalate");
  });

  it("treats a fix it cannot classify with confidence as intentional", () => {
    // A logic finding is not mechanical → default to intentional (escalate).
    const unclear: PrePrFinding = {
      category: "logic",
      severity: "medium",
      file: "src/bar.ts",
      line: 3,
      message: "ambiguous branch",
      suggestion: "review the condition",
    };
    expect(classifyFix(unclear)).toBe("intentional");
    expect(decideFixApplication(unclear)).toBe("escalate");
  });
});
