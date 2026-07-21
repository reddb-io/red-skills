// branch-resume — pure decision layer for branch-resume on re-claim (issue #2397).
//
// When a worker re-claims an issue, these functions determine whether a prior
// attempt's pushed branch exists and whether it reached a gate-green state. The
// caller (lifecycle.ts) skips prepareFreshWorkerBranch, injects a
// <resume-from-branch> section into the handoff, and for gate-green branches
// bypasses the agent entirely (validate + land directly).

import type { BranchRef } from "./branch-cleanup.js";

const LIVE_REF_ISSUE_RE = /^afk\/[^/]+\/([0-9]+)-[a-z0-9-]+$/;

function issueFromRef(branch: string): number | null {
  const m = LIVE_REF_ISSUE_RE.exec(branch);
  return m ? Number(m[1]) : null;
}

/**
 * Select the newest branch (by commitS) for `issue` from a list of remote refs.
 * Returns null when no matching branch exists.
 */
export function discoverResumableBranch(refs: readonly BranchRef[], issue: number): BranchRef | null {
  const candidates = refs.filter((r) => issueFromRef(r.branch) === issue);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) => {
    const bs = best.commitS ?? -Infinity;
    const cs = cur.commitS ?? -Infinity;
    return cs > bs ? cur : best;
  });
}

/**
 * Extract the `prev-failure-reason:` value from a prior-attempt-context block.
 * Returns undefined when the marker is absent or the context is empty.
 */
export function extractFailureReason(priorAttemptContext: string | undefined): string | undefined {
  if (!priorAttemptContext) return undefined;
  const marker = "prev-failure-reason:";
  const idx = priorAttemptContext.indexOf(marker);
  if (idx === -1) return undefined;
  return priorAttemptContext.slice(idx + marker.length).trim();
}

// Gate-stage failure reasons: when the prior attempt failed for one of these,
// the gate did NOT pass — a full agent iteration is still required.
const GATE_STAGE_REASONS = new Set([
  "feedback-failed",
  "no-sentinel",
  "stalled",
  "blocked",
  "base-stale",
  "merge-conflict",
  "runner-transient",
  "exhausted",
  "signal-killed",
]);

/**
 * True when `failureReason` is present and does NOT name a gate-stage failure —
 * meaning the prior attempt's gate passed and only the landing step remains.
 * A missing/empty reason returns false (first attempt; safe to run the agent).
 */
export function isGateGreenBranch(failureReason: string | undefined): boolean {
  if (!failureReason) return false;
  // Strip trailing colon (e.g. "feedback-failed: detail text") before lookup.
  const first = (failureReason.trim().split(/\s+/)[0] ?? "").replace(/:$/, "");
  return first.length > 0 && !GATE_STAGE_REASONS.has(first);
}

/**
 * True when the assembled human guidance explicitly requests a full restart or
 * rebuild, overriding the automatic resume behaviour.
 */
export function isExplicitRestartRequested(humanGuidance: string): boolean {
  return /\brestart\b|\brebuild\b/i.test(humanGuidance);
}

/**
 * Build the content for the `<resume-from-branch>` handoff section.
 * Gate-green variant: agent verifies + gates, no re-implementation.
 * Non-gate-green variant: agent continues from where the branch left off.
 */
export function buildResumeInstruction(branch: string, isGateGreen: boolean): string {
  if (isGateGreen) {
    return [
      `Branch \`${branch}\` was pushed in a prior attempt and its gate already passed.`,
      "Checkout this branch in your worktree, verify the base is still fresh,",
      "re-run the merge gate, and emit `<promise>DONE</promise>` when it passes.",
      "Do NOT re-implement — the work is already there.",
    ].join(" ");
  }
  return [
    `Branch \`${branch}\` was pushed in a prior attempt.`,
    "Checkout this branch in your worktree and continue from where it left off —",
    "do NOT start over. Run `git log --oneline origin/main..HEAD` to see what was",
    "already committed, then satisfy the merge gate and emit `<promise>DONE</promise>`.",
  ].join(" ");
}
