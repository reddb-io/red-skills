// wall-clock-cap — the pure decision layer for "this worker hit the per-issue
// wall-clock ceiling" (#2701).
//
// A wall-clock cap is a POLICY DEADLINE, not a stall. The reaper used to report
// both as `no-sentinel · stall-reaped`, which said "the agent never finished"
// about attempts that had committed 800 lines and opened a green PR — and then
// re-queued the issue CLEAN, so the next worker branched fresh from main and
// redid the work from scratch. This module owns the other half of the fix: given
// what the capped attempt left behind, decide what must be HANDED FORWARD.
//
// PURE (no IO): the reaper executes the plan (push the ref, post the comment,
// rotate the labels).

import type { WorkerOutcome } from "./worker-outcome.js";

/** The terminal outcome a wall-clock cap records — never `no-sentinel`. */
export const WALL_CLOCK_CAP_OUTCOME: WorkerOutcome = "wall-clock-capped";

/** Marker the hand-forward comment always opens with, so every surface (and
 * every test) can find it without matching prose. */
export const CAP_HANDOFF_MARKER = "🤖 /afk wall-clock cap";

export interface CapHandoffInput {
  /** The capped attempt's issue. */
  issue: number;
  /** The configured per-issue ceiling, in seconds. */
  capSeconds: number;
  /** How long the attempt actually ran, in seconds (0 when unknown). */
  durationS: number;
  /** The attempt's live branch, when the reaper recovered one. */
  branch?: string;
  /** Head SHA of that branch — present only when the branch exists AND carries
   * commits. Absent means the attempt produced no committed work. */
  branchHead?: string;
  /** True when the reaper successfully published the branch to the remote, so
   * the next worker's branch discovery can actually see it. */
  branchPublished?: boolean;
  /** An open PR the capped attempt already produced, when one exists. */
  pullRequest?: number;
}

export interface CapHandoff {
  /** The ref the next worker must adopt instead of branching fresh from main.
   * Absent when the capped attempt left nothing behind. */
  resumeRef?: string;
  /** The open PR the issue must name as its pending artifact. Absent when the
   * attempt never opened one. */
  pendingPullRequest?: number;
  /** True when the cap left live work — a ref, a PR, or both. A capped attempt
   * that committed nothing hands nothing forward and re-queues plainly. */
  handsWorkForward: boolean;
  /** The comment the reaper posts: names the cap, and names the artifact the
   * issue is pending on so it is never silently `running`. */
  comment: string;
}

/**
 * Plan the hand-forward for one capped attempt. The ref is handed forward when
 * the branch has commits; the PR is named whenever one is open — a PR is
 * authoritative even if the branch head could not be resolved, because the work
 * is already published on it.
 */
export function planCapHandoff(input: CapHandoffInput): CapHandoff {
  const hasCommits = input.branch !== undefined && input.branch.length > 0 && input.branchHead !== undefined;
  const resumeRef = hasCommits ? input.branch : undefined;
  const pendingPullRequest = input.pullRequest;
  const handsWorkForward = resumeRef !== undefined || pendingPullRequest !== undefined;

  const lines: string[] = [
    `${CAP_HANDOFF_MARKER}: this worker was stopped by the per-issue wall-clock ceiling ` +
      `(ran ${input.durationS}s, cap ${input.capSeconds}s, \`RED_AFK_ISSUE_WALL_CLOCK_MAX_S\`). ` +
      "It was NOT stalled — the cut-off is policy, not a hang.",
  ];

  if (pendingPullRequest !== undefined) {
    lines.push(
      `pending artifact: PR #${pendingPullRequest} — the issue is waiting on that PR, ` +
        "not on a fresh attempt. The next worker adopts it through the no-agent gate.",
    );
  }
  if (resumeRef !== undefined) {
    lines.push(
      `resume-from-branch: \`${resumeRef}\`${input.branchPublished === false ? " (local only — publish failed, adopt it from the worker host)" : ""}`,
    );
    lines.push("The next worker MUST continue from that branch — do NOT start over from main.");
  }
  if (!handsWorkForward) {
    lines.push("No committed work and no open PR were found, so nothing is handed forward.");
  }

  return {
    ...(resumeRef !== undefined ? { resumeRef } : {}),
    ...(pendingPullRequest !== undefined ? { pendingPullRequest } : {}),
    handsWorkForward,
    comment: lines.join("\n"),
  };
}
