/**
 * Command-level regression evidence for the #857 /ship incident.
 *
 * Incident summary (#854/#856): `gh pr checks` returned a transient API error
 * while `statusCheckRollup` on `gh pr view` was fully populated (4 entries:
 * 2 CheckRun + 2 StatusContext). The old code reported "checks unavailable"
 * and kept spinning until the monitor time cap, then parked to ready-for-human
 * — even though CI was 4/4 green and the PR was clean/mergeable.
 *
 * Fix (#857): when `gh pr checks` fails AND `statusCheckRollup` is populated,
 * fall back to the rollup as the authoritative check source. These tests prove
 * the four behaviour contracts at the `collectShipFacts` boundary:
 *
 *  1. checks-command failure + populated rollup  → rollup used, not "checks unavailable"
 *  2. populated rollup with in-progress check    → not green (keeps polling)
 *  3. populated rollup with all-green checks     → green (merge gate sees data)
 *  4. checks-command failure + empty rollup      → still "checks unavailable"
 *
 * The synthetic fixture below is a minimal distillation of the real #854/#856
 * payload shapes. The full production payload is preserved in the GitHub issue
 * thread on #854.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../src/runtime/exec.js", () => ({
  execTool: vi.fn(),
  pnpm: vi.fn(),
}));
vi.mock("../src/runtime/github-merge-read.js", () => ({
  createDevGithubMergeRead: vi.fn(),
}));

import { createDevGithubMergeRead } from "../src/runtime/github-merge-read.js";
import { collectShipFacts } from "../src/commands/ship.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures — derived from real #854/#856 shapes
// ---------------------------------------------------------------------------

/**
 * Mixed rollup matching the real incident: two CI CheckRuns (completed) and
 * two StatusContext entries (advisory bot review + external CI). All green.
 */
const ROLLUP_MIXED_ALL_GREEN = JSON.stringify([
  { __typename: "CheckRun", name: "red-workspace-typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "red-workspace-test",     status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "StatusContext", context: "coderabbitai[bot]",          state: "SUCCESS" },
  { __typename: "StatusContext", context: "ci/circleci-project-checks", state: "SUCCESS" },
]);

/**
 * Rollup where the test suite CheckRun is still in progress — mirrors the
 * window between push and CI finishing.
 */
const ROLLUP_MIXED_IN_PROGRESS = JSON.stringify([
  { __typename: "CheckRun", name: "red-workspace-test", status: "IN_PROGRESS", conclusion: null },
  { __typename: "StatusContext", context: "ci/circleci-project-checks", state: "SUCCESS" },
]);

/**
 * An advisory bot review (coderabbitai[bot]) is registered but still in
 * flight; the other checks are all green.
 */
const ROLLUP_ADVISORY_PENDING = JSON.stringify([
  { __typename: "CheckRun", name: "red-workspace-typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "StatusContext", context: "coderabbitai[bot]", state: "PENDING" },
]);

// A pr view response template — only reviewDecision/reviews/statusCheckRollup vary.
function prViewPayload(rollup: unknown[], reviewDecision = ""): string {
  return JSON.stringify({ reviewDecision, reviews: [], statusCheckRollup: rollup });
}

// Wire up the two routed reads that collectShipFacts makes.
function setupMocks(checksCode: number, checksStdout: string, viewPayload: string): void {
  vi.mocked(createDevGithubMergeRead).mockReturnValue({
    reviewChecks: async () => {
      if (checksCode !== 0) throw new Error("API error");
      return checksStdout;
    },
    shipPr: async () => viewPayload,
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectShipFacts (#857 — statusCheckRollup fallback)", () => {
  const CWD = "/fake/worktree";
  const REPO = "org/repo";
  const PR = 42;
  const NO_REVIEW_CHECK = "";

  beforeEach(() => vi.clearAllMocks());

  it("uses statusCheckRollup when gh pr checks fails and rollup is populated", async () => {
    setupMocks(1, "", prViewPayload(JSON.parse(ROLLUP_MIXED_ALL_GREEN)));

    const facts = await collectShipFacts(CWD, REPO, PR, NO_REVIEW_CHECK);

    expect(facts.checkSummary).not.toBe("checks unavailable");
    expect(facts.checksGreen).toBe(true);
  });

  it("keeps /ship polling (not green) when rollup has an in-progress check", async () => {
    setupMocks(1, "", prViewPayload(JSON.parse(ROLLUP_MIXED_IN_PROGRESS)));

    const facts = await collectShipFacts(CWD, REPO, PR, NO_REVIEW_CHECK);

    expect(facts.checkSummary).not.toBe("checks unavailable");
    expect(facts.checksGreen).toBe(false);
  });

  it("allows the merge gate to see green data from a successful rollup", async () => {
    setupMocks(1, "", prViewPayload(JSON.parse(ROLLUP_MIXED_ALL_GREEN)));

    const facts = await collectShipFacts(CWD, REPO, PR, NO_REVIEW_CHECK);

    // checkSummary counts green/total so the merge gate can act.
    expect(facts.checkSummary).toBe("4/4 green");
    expect(facts.checksGreen).toBe(true);
  });

  it("still reports checks unavailable when rollup is empty after a checks failure", async () => {
    setupMocks(1, "", prViewPayload([]));

    const facts = await collectShipFacts(CWD, REPO, PR, NO_REVIEW_CHECK);

    expect(facts.checkSummary).toBe("checks unavailable");
    expect(facts.checksGreen).toBe(false);
  });

  it("uses the primary checks command when it succeeds (rollup is not consulted)", async () => {
    const primaryChecks = JSON.stringify([
      { name: "red-workspace-typecheck", state: "SUCCESS",   conclusion: "SUCCESS", bucket: "" },
      { name: "red-workspace-test",      state: "COMPLETED", conclusion: "SUCCESS", bucket: "" },
    ]);
    // rollup has different data — the primary path must win
    setupMocks(0, primaryChecks, prViewPayload(JSON.parse(ROLLUP_MIXED_IN_PROGRESS)));

    const facts = await collectShipFacts(CWD, REPO, PR, NO_REVIEW_CHECK);

    expect(facts.checkSummary).toBe("2/2 green");
    expect(facts.checksGreen).toBe(true);
  });

  it("detects an advisory review in flight via the rollup path", async () => {
    setupMocks(1, "", prViewPayload(JSON.parse(ROLLUP_ADVISORY_PENDING)));

    const facts = await collectShipFacts(CWD, REPO, PR, "coderabbit");

    // The advisory check being PENDING means checksGreen is false (keeps polling).
    // The key invariant: rollup is used so we never report "checks unavailable".
    expect(facts.advisoryReviewPending).toBe(true);
    expect(facts.checkSummary).not.toBe("checks unavailable");
  });
});
