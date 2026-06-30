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

/**
 * Normalize a raw `statusCheckRollup` entry (either a GitHub `CheckRun` or
 * `StatusContext`) into the `ShipCheck` shape used by the rest of /ship.
 *
 * CheckRun:     { name, status (running state), conclusion (terminal result) }
 * StatusContext: { context (name), state (SUCCESS/FAILURE/PENDING/…) }
 *
 * The two shapes are unified by reading `name ?? context` and `state ?? status`
 * so that `shipChecksAreGreen` and `advisoryReviewPending` work without knowing
 * which shape they received.
 */
export function normalizeRollupEntry(raw: Record<string, unknown>): ShipCheck {
  return {
    name: String(raw.name ?? raw.context ?? ""),
    state: String(raw.state ?? raw.status ?? ""),
    conclusion: raw.conclusion != null ? String(raw.conclusion) : undefined,
  };
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

// ---------- no-mistakes pre-PR pipeline: findings model ----------

/**
 * A single code-review finding from the pre-PR pipeline (review → test → docs → lint).
 * Findings are classified as mechanical (safe auto-apply) or intent-changing (escalate).
 */
export interface PrePrFinding {
  /** Category: lint, format, docs, logic, type, semantics. */
  category: "lint" | "format" | "docs" | "logic" | "type" | "semantics";
  /** Severity: low, medium, high. */
  severity: "low" | "medium" | "high";
  /** Repo-relative file path. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** Human-readable description of the finding. */
  message: string;
  /** Suggested fix or action. */
  suggestion: string;
}

/**
 * True when a finding is mechanical (safe for automatic application).
 * Mechanical findings: lint style/formatting, unused code, missing comments, docs.
 * Intent findings (escalate): logic errors, type safety, semantics, API contracts.
 */
export function isPrePrFindingMechanical(finding: PrePrFinding): boolean {
  // Mechanical categories: lint, format, docs (low-severity style/documentation)
  if (finding.category === "lint" || finding.category === "format" || finding.category === "docs") {
    return finding.severity === "low";
  }
  // Logic, type, semantics are always intent-changing (require human judgment)
  return false;
}

/**
 * Input to the pre-PR gate decision logic.
 */
export interface PrePrShipGateInput {
  /** True when the feedback validation (test/typecheck/lint/build) passed. */
  feedbackPassed: boolean;
  /** True when any intent-changing findings are present. */
  intentFindingsPresent: boolean;
  /** True when any mechanical findings are present. */
  mechanicalFindingsPresent: boolean;
  /** True when the pre-PR pipeline time cap has expired. */
  timedOut: boolean;
}

export type PrePrShipGateDecision = "auto-apply" | "escalate" | "push";

/**
 * Pure gate for the pre-PR pipeline in /ship (no-mistakes Track 2B).
 *
 * Rules:
 * - If time cap exceeded, escalate.
 * - If intent findings are present, escalate for human decision (approve/fix/skip).
 * - If only mechanical findings (no intent findings), auto-apply them (even if feedback failed).
 * - If no findings but feedback failed, escalate.
 * - Otherwise (feedback passed, no findings), push.
 */
export function decidePrePrShipGate(input: PrePrShipGateInput): PrePrShipGateDecision {
  if (input.timedOut) return "escalate";
  if (input.intentFindingsPresent) return "escalate";
  if (input.mechanicalFindingsPresent) return "auto-apply";
  if (!input.feedbackPassed) return "escalate";
  return "push";
}
