import { describe, expect, it } from "vitest";
import {
  advisoryReviewPending,
  decideShipMergeGate,
  isShipWorktreePath,
  issueNumberFromBranch,
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
