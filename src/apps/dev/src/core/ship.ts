export interface ShipMergeGateInput {
  /**
   * True when branch protection is already satisfied for the PR. A repository
   * with no required approval counts as satisfied; a required-but-missing
   * approval does not.
   */
  branchProtectionSatisfied: boolean;
  /** True when any human or bot review has left CHANGES_REQUESTED. */
  changesRequested: boolean;
  /** True when all observed checks have reached a green terminal state. */
  checksGreen: boolean;
  /** True when the /ship monitor budget has expired. */
  timedOut: boolean;
}

export type ShipMergeGateDecision = "merge" | "hitl";

/**
 * Pure merge gate for /ship. It intentionally knows nothing about GitHub,
 * polling, labels, or command output; callers provide the four facts the PR
 * lifecycle cares about and receive a single action.
 */
export function decideShipMergeGate(input: ShipMergeGateInput): ShipMergeGateDecision {
  if (input.timedOut) return "hitl";
  if (input.changesRequested) return "hitl";
  if (!input.branchProtectionSatisfied) return "hitl";
  if (!input.checksGreen) return "hitl";
  return "merge";
}

export interface ShipCheck {
  name?: string;
  state?: string;
  conclusion?: string;
  bucket?: string;
}

/**
 * True when the named advisory review check (e.g. `CodeRabbit`) is registered
 * on the PR but has not yet reached a terminal state. Mirrors the AFK landing
 * path's `waitForReviewCheck` (core/merge.ts): `/ship` is the interactive
 * sibling of that landing and must likewise hold until an advisory bot review
 * concludes, rather than approving/merging out from under an in-flight reviewer.
 *
 * Fail-open by name: a check that never registers is NOT pending — an absent or
 * misconfigured reviewer cannot wedge the finalizer. A blank `reviewCheck`
 * disables the wait entirely. A check whose `state`/`conclusion`/`bucket` is
 * still blank or `PENDING` counts as in-flight; anything else has concluded.
 */
export function advisoryReviewPending(checks: readonly ShipCheck[], reviewCheck: string): boolean {
  const needle = reviewCheck.trim().toLowerCase();
  if (needle === "") return false;
  const match = checks.find((c) => String(c.name ?? "").toLowerCase().includes(needle));
  if (match === undefined) return false;
  const values = [match.state, match.conclusion, match.bucket]
    .map((v) => String(v ?? "").trim().toUpperCase())
    .filter(Boolean);
  const concluded = values.some((v) => v !== "PENDING");
  return !concluded;
}

const GREEN_CHECK_VALUES = new Set(["SUCCESS", "PASS", "PASSED", "NEUTRAL", "SKIPPED", "SKIPPING"]);

/**
 * Interpret gh's PR-check projection. Empty check lists are green: repos with no
 * configured checks should still be mergeable when protection does not require
 * them.
 */
export function shipChecksAreGreen(checks: readonly ShipCheck[]): boolean {
  return checks.every((check) => {
    const values = [check.state, check.conclusion, check.bucket]
      .map((v) => String(v ?? "").trim().toUpperCase())
      .filter(Boolean);
    return values.some((value) => GREEN_CHECK_VALUES.has(value));
  });
}

/** Extract the first issue number from common branch names like
 * `ship/395-finalizer` or `afk/wAAAA/395-finalizer`. */
export function issueNumberFromBranch(branch: string): number | undefined {
  const match = /(?:^|[/-])(\d+)(?:[/-]|$)/.exec(branch);
  if (!match?.[1]) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** /ship is a tail operation over explicitly-exempt worktrees. */
export function isShipWorktreePath(path: string): boolean {
  return /(?:^|[/\\])\.red[/\\]tmp[/\\]work-ship-[^/\\]+(?:[/\\]|$)/.test(path);
}
