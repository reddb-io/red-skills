// branch-resume — pure decision layer for branch-resume on re-claim (issue #2397).
//
// When a worker re-claims an issue, these functions determine whether a prior
// attempt's pushed branch exists and whether it reached a gate-green state. The
// caller (lifecycle.ts) skips prepareFreshWorkerBranch, injects a
// <resume-from-branch> section into the handoff, and for gate-green branches
// bypasses the agent entirely (validate + land directly).

import type { BranchRef } from "./branch-cleanup.js";

const LIVE_REF_ISSUE_RE = /^afk\/(?:([0-9]+)-[a-z0-9-]+|[^/]+\/([0-9]+)-[a-z0-9-]+)$/;

/** The issue number an AFK branch ref names, or null when the ref is not one.
 * Both the deterministic `afk/<issue>-<slug>` head and the legacy
 * `afk/<worker>/<issue>-<slug>` head resolve. */
export function issueFromBranchRef(branch: string): number | null {
  const m = LIVE_REF_ISSUE_RE.exec(branch);
  return m ? Number(m[1] ?? m[2]) : null;
}

const issueFromRef = issueFromBranchRef;

/** Minimal open-PR projection needed by attempt bootstrap. */
export interface AttemptPullRequest {
  number: number;
  headRefName: string;
  body?: string;
}

/** True when an open PR names the issue through an AFK head branch or a closing
 * reference in its body. Both deterministic and legacy AFK heads are accepted
 * so an issue requeued during migration adopts rather than duplicates work. */
export function pullRequestMatchesAttempt(pr: AttemptPullRequest, issue: number): boolean {
  if (issueFromRef(pr.headRefName) === issue) return true;
  const escaped = String(issue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${escaped}\\b`, "i").test(pr.body ?? "");
}

/** Select the branch to adopt. Prefer the deterministic issue head (the
 * structural collision backstop), then the newest matching legacy PR. */
export function selectAttemptPullRequest(
  prs: readonly AttemptPullRequest[],
  issue: number,
): AttemptPullRequest | null {
  const matches = prs.filter((pr) => pullRequestMatchesAttempt(pr, issue));
  if (matches.length === 0) return null;
  return matches.reduce((best, current) => {
    const bestDeterministic = issueFromRef(best.headRefName) === issue && best.headRefName.split("/").length === 2;
    const currentDeterministic = issueFromRef(current.headRefName) === issue && current.headRefName.split("/").length === 2;
    if (currentDeterministic !== bestDeterministic) return currentDeterministic ? current : best;
    return current.number > best.number ? current : best;
  });
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
 * What a dispatched Worker decided about the branch its issue already has
 * (#2865). `none` means there was nothing to adopt; `refused` means work exists
 * and the Worker deliberately left it, which is a fact the issue must carry.
 */
export type BranchAdoption =
  | { kind: "adopt"; branch: string; commitsAhead: number | undefined; hasOpenPullRequest: boolean }
  | { kind: "refused"; branch: string; commitsAhead: number | undefined; reason: string }
  | { kind: "none" };

const RESTART_REFUSAL_REASON = "a human directive in the thread asked for a restart";

/**
 * Decide whether a dispatched Worker adopts the branch its issue already has.
 *
 * The commit count is the evidence, not the branch name: worktree creation
 * pushes the deterministic `afk/<issue>-<slug>` ref before the agent writes a
 * line, so a name match alone cannot tell a dead Worker's finished work from an
 * empty placeholder. A count of `undefined` means the probe could not tell —
 * and an unread branch is adopted, never assumed empty, because the branch a
 * Worker declines to adopt is the branch `prepareFreshWorkerBranch` deletes.
 */
export function decideBranchAdoption(input: {
  candidate: { branch: string } | null;
  commitsAhead: number | undefined;
  explicitRestart: boolean;
  hasOpenPullRequest: boolean;
}): BranchAdoption {
  const { candidate, commitsAhead, explicitRestart, hasOpenPullRequest } = input;
  if (!candidate) return { kind: "none" };
  // A branch proven empty carries no work to lose, so declining it is not a
  // refusal worth announcing — it is the ordinary first dispatch.
  if (commitsAhead === 0) return { kind: "none" };
  if (explicitRestart) {
    return { kind: "refused", branch: candidate.branch, commitsAhead, reason: RESTART_REFUSAL_REASON };
  }
  return { kind: "adopt", branch: candidate.branch, commitsAhead, hasOpenPullRequest };
}

function describeCommits(commitsAhead: number | undefined): string {
  if (commitsAhead === undefined) return "an unknown number of commits";
  return `${commitsAhead} commit${commitsAhead === 1 ? "" : "s"}`;
}

/**
 * The issue comment an adoption decision owes the record, or `null` when the
 * decision needs no announcement (#2865).
 *
 * Two things are never left unsaid: a refusal (the reason belongs on the issue,
 * not only in a Worker's log), and pushed work that no pull request mentions —
 * the exact shape in which a dead Worker's finished slice goes invisible. An
 * adopted branch that already has an open PR is silent here because the
 * attempt-PR census comment already names it.
 */
export function formatAdoptionNotice(decision: BranchAdoption, issue: number): string | null {
  if (decision.kind === "none") return null;
  const commits = describeCommits(decision.commitsAhead);
  if (decision.kind === "refused") {
    return (
      `🤖 /afk #${issue}: branch \`${decision.branch}\` carries ${commits} ahead of the base and was NOT adopted — ` +
      `${decision.reason}. The commits stay on the branch until someone takes them.`
    );
  }
  if (decision.hasOpenPullRequest) return null;
  return (
    `🤖 /afk #${issue}: branch \`${decision.branch}\` carries ${commits} ahead of the base and has no open pull request. ` +
    `Adopting it — this Worker continues that branch instead of starting over.`
  );
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
  // A wall-clock cap (#2701) stops the worker MID-GATE: the branch carries real
  // commits but nothing proves the gate passed, so the retry continues the work
  // rather than taking the validate-and-land fast path.
  "wall-clock-capped",
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
 *
 * Both variants open with a MANDATORY base sync (issue #2481): an adopted
 * branch carries every prior attempt's commits on an ever-staler base, and
 * deferring the sync to landing turns small drift into a massive sequential
 * rebase. Resolving conflicts now — while the agent is present and the drift
 * is at its smallest — is the cheap moment.
 */
export function buildResumeInstruction(branch: string, isGateGreen: boolean, base = "main"): string {
  const syncFirst = [
    `FIRST, before anything else, sync the branch with the current base:`,
    `run \`git fetch origin ${base}\` then \`git rebase origin/${base}\`.`,
    "If the rebase conflicts, resolve every conflict NOW (honor both sides),",
    "`git rebase --continue`, and push the synced branch with",
    "`git push --force-with-lease`. Only then proceed.",
  ].join(" ");
  if (isGateGreen) {
    return [
      `Branch \`${branch}\` was pushed in a prior attempt and its gate already passed.`,
      `Checkout this branch in your worktree. ${syncFirst}`,
      "Re-run the merge gate, and emit `<promise>DONE</promise>` when it passes.",
      "Do NOT re-implement — the work is already there.",
    ].join(" ");
  }
  return [
    `Branch \`${branch}\` was pushed in a prior attempt.`,
    `Checkout this branch in your worktree. ${syncFirst}`,
    "Continue from where it left off —",
    `do NOT start over. Run \`git log --oneline origin/${base}..HEAD\` to see what was`,
    "already committed, then satisfy the merge gate and emit `<promise>DONE</promise>`.",
  ].join(" ");
}
