// branch-reclaim.ts — which LOCAL branches a reclaim may delete, and which it
// must name and spare (#2866).
//
// This is the branch half of the reclaim whose workspace half lives in
// worker-reclaim.ts, and it is deliberately shaped the same way: a PURE planner
// that consumes already-resolved facts, gives every candidate exactly one
// verdict with a reason, and states the accounting identity in `totals` so a
// caller can assert nothing fell out silently.
//
// ONE RULE, STATED ONCE: a branch is reclaimable when its work has LANDED and
// nothing else claims it. "Landed" is the merge-base fact — the trunk already
// carries the commits — not "the issue is closed", because a slice whose PR
// merged while its issue stayed open is exactly the branch that accumulates.
// The tracker's verdict is kept as a second, weaker route: an issue that is over
// releases its branch even when merged-ness could not be resolved.
//
// AND ONE PROHIBITION THAT OUTRANKS THE RULE: an infrastructure ref is never
// eligible, however merged it looks. `red-trunk` is the fleet's trunk mirror; it
// is merged into the trunk BY CONSTRUCTION, so every merged-ness test on earth
// says delete it, and deleting it breaks every landing until someone notices. A
// hand sweep made exactly that mistake. The refusal is therefore stated by NAME
// here rather than derived, so no future merged-ness refinement can reason its
// way past it.
//
// The spares are as load-bearing as the deletions, which is why they are
// returned rather than dropped: `checked-out` (a worktree holds it — including
// the live Worker still writing to it), `unrecognised` (no Worker lane owns this
// namespace, so the planner does not guess), and `unlanded` (the work is still
// only on this branch — deleting it is data loss, not hygiene).

import { liveIssueFromBranch } from "./branch-cleanup.js";

/**
 * Refs the reclaim names and refuses, whatever else is true of them.
 *
 * `red-trunk` is the fleet-owned mirror of `origin/<trunk>` that landings
 * promote (see core/merge.ts). It holds no unique commits, which is precisely
 * why a merged-ness sweep condemns it.
 */
export const INFRASTRUCTURE_BRANCHES = ["red-trunk"] as const;

/** One local branch, with the facts a caller has already resolved about it. */
export interface BranchReclaimCandidate {
  /** The bare ref name, e.g. `afk/2866-slug`. */
  branch: string;
  /** True when the trunk already carries this branch's commits. */
  landed?: boolean;
  /** True when a worktree — live Worker or not — has this branch checked out. */
  checkedOut?: boolean;
  /** True when the tracker says the branch's issue is over. */
  issueClosed?: boolean;
}

export type BranchReclaimVerdictKind =
  /** Named in `INFRASTRUCTURE_BRANCHES`: the refusal that outranks everything. */
  | "infrastructure"
  /** The configured trunk itself, whatever it is named. */
  | "trunk"
  /** A worktree holds it; git would refuse, and so does the planner. */
  | "checked-out"
  /** No Worker lane owns this namespace, so the planner does not guess. */
  | "unrecognised"
  /** A repeated candidate: already decided once, reported rather than re-planned. */
  | "already-planned"
  /** The work exists only here. Deleting it is data loss, not hygiene. */
  | "unlanded"
  /** The trunk already carries the commits. */
  | "landed"
  /** The tracker says the work is over, so the branch is residue. */
  | "issue-closed";

/** One branch, one verdict, one reason. */
export interface BranchReclaimVerdict {
  branch: string;
  reclaim: boolean;
  verdict: BranchReclaimVerdictKind;
  reason: string;
}

export interface BranchReclaimTotals {
  considered: number;
  reclaim: number;
  spare: number;
}

export interface BranchReclaimPlan {
  /** Branches to delete, in input order. */
  reclaim: BranchReclaimVerdict[];
  /** Branches deliberately kept, each with the reason it was kept. */
  spare: BranchReclaimVerdict[];
  totals: BranchReclaimTotals;
}

export interface BranchReclaimOptions {
  /** The repo's configured trunk (`main`, `develop`, …). Never eligible. */
  trunk?: string;
  /** Extra refs to treat as infrastructure, added to the named list. */
  infrastructure?: readonly string[];
}

/** True when this branch is one the reclaim refuses by name. */
export function isInfrastructureBranch(
  branch: string,
  extra: readonly string[] = [],
): boolean {
  return (INFRASTRUCTURE_BRANCHES as readonly string[]).includes(branch) || extra.includes(branch);
}

function judge(
  candidate: BranchReclaimCandidate,
  options: BranchReclaimOptions,
): BranchReclaimVerdict {
  const branch = candidate.branch;
  const spare = (verdict: BranchReclaimVerdictKind, reason: string): BranchReclaimVerdict => ({
    branch,
    reclaim: false,
    verdict,
    reason,
  });
  const reclaim = (verdict: BranchReclaimVerdictKind, reason: string): BranchReclaimVerdict => ({
    branch,
    reclaim: true,
    verdict,
    reason,
  });

  if (isInfrastructureBranch(branch, options.infrastructure ?? [])) {
    return spare(
      "infrastructure",
      `${branch} is an infrastructure ref: it is merged by construction and the fleet needs it`,
    );
  }
  if (options.trunk !== undefined && branch === options.trunk) {
    return spare("trunk", `${branch} is the configured trunk`);
  }
  if (candidate.checkedOut === true) {
    return spare("checked-out", "a worktree has this branch checked out");
  }
  if (liveIssueFromBranch(branch) === null) {
    return spare(
      "unrecognised",
      "no Worker lane owns this branch namespace, so the reclaim leaves it alone",
    );
  }
  if (candidate.landed === true) {
    return reclaim("landed", "the trunk already carries this branch's commits");
  }
  if (candidate.issueClosed === true) {
    return reclaim("issue-closed", "the tracker says this branch's issue is over");
  }
  return spare("unlanded", "this branch's work has not landed, so its commits exist only here");
}

/**
 * Plan the local branch reclaim.
 *
 * The plan is total: every candidate appears exactly once across `reclaim` and
 * `spare`, and `totals` states that identity. A branch offered twice is decided
 * once and the repeat is reported as `already-planned`, never dropped.
 */
export function planBranchReclaim(
  candidates: readonly BranchReclaimCandidate[],
  options: BranchReclaimOptions = {},
): BranchReclaimPlan {
  const reclaim: BranchReclaimVerdict[] = [];
  const spare: BranchReclaimVerdict[] = [];
  const seen = new Set<string>();
  let considered = 0;

  for (const candidate of candidates) {
    considered += 1;
    if (seen.has(candidate.branch)) {
      spare.push({
        branch: candidate.branch,
        reclaim: false,
        verdict: "already-planned",
        reason: "this branch was already decided earlier in the same plan",
      });
      continue;
    }
    seen.add(candidate.branch);
    const verdict = judge(candidate, options);
    if (verdict.reclaim) reclaim.push(verdict);
    else spare.push(verdict);
  }

  return {
    reclaim,
    spare,
    totals: { considered, reclaim: reclaim.length, spare: spare.length },
  };
}
