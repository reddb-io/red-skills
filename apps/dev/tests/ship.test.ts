import { describe, expect, it } from "vitest";
import {
  advisoryReviewPending,
  decideShipMergeGate,
  isShipWorktreePath,
  issueNumberFromBranch,
  normalizeRollupEntry,
  shipChecksAreGreen,
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
