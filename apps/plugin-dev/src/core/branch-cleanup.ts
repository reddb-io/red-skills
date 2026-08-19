// Branch-cleanup decision layer for the AFK reapers (issues #258 / #273 / #274,
// PRD #244). This is the COMPLEMENT of remote-branch.ts: that module owns the
// git argv for pushing and deleting branches; this module owns the decision of
// WHICH branches a reaper should delete. The actual deletion reuses
// remote-branch.ts (deleteRemote / deleteRemoteArgs) — no git argv is rebuilt
// here.
//
// Two reapers, each grouping branches by the issue number parsed from the ref
// and classifying via an injected issue-state lookup:
//
//   - remote live reaper (remote afk/{wid}/{N}-slug): live-iteration branches.
//       Deleted as soon as the issue is CLOSED — the merge base already has the
//       work, so the live branch is residue. No grace. Open / not-found /
//       transient kept.
//   - local live reaper (local afk/{wid}/{N}-slug): same parser and policy as
//       the remote live reaper; the caller separately skips checked-out branches
//       before handing refs here.
//
// Mirrors lib/remote-branch.sh: _branch_cleanup_plan and the live namespace
// policy. The classification is PURE: the issue-state lookup and `now` are
// injected so the deciders perform no git/gh/date I/O.

/** The S1 issue-state vocabulary the deciders consume. Mirrors the strings
 * echoed by _attempt_snapshot_issue_state_from_gh. */
export type IssueState =
  | "open"
  | "closed-within-grace"
  | "closed-past-grace"
  | "not-found"
  | "unresolved-transient";

const ISSUE_STATES: readonly IssueState[] = [
  "open",
  "closed-within-grace",
  "closed-past-grace",
  "not-found",
  "unresolved-transient",
];

/** Raw issue metadata as returned by `gh issue view --json state,closedAt`. */
export interface IssueMeta {
  /** "OPEN" | "CLOSED" (any other value is treated as transient). */
  state: string;
  /** ISO-8601 closedAt for CLOSED issues; empty / null otherwise. */
  closedAt?: string | null;
}

/** Issue-state lookup, injected so classification stays pure. Returns the raw
 * gh metadata, or `null` for a definitive 404, or `undefined` for any transient
 * failure (rate limit, network, parse error). */
export type IssueLookup = (issue: number) => IssueMeta | null | undefined;

/** Per-reaper keep/reap decision for a single branch. */
export interface BranchDecision {
  action: "keep" | "reap";
  branch: string;
  issue: number;
  /** The S1 issue state the decision was derived from. */
  state: IssueState;
}

/** A synthetic ls-remote-shaped row: a branch plus, for the snapshot reaper,
 * the branch's last-commit epoch used for the 404 branch-age grace. */
export interface BranchRef {
  branch: string;
  /** Last-commit epoch (seconds). Absent / non-finite leaves a 404 ref kept. */
  commitS?: number;
}

const LIVE_REF_RE = /^afk\/(?:([0-9]+)-[a-z0-9-]+|[^/]+\/([0-9]+)-[a-z0-9-]+)$/;
const ATTEMPT_REF_RE = /^afk-attempts\/[^/]+\/([0-9]+)-/;

/** Issue number from a deterministic `afk/{N}-slug` or legacy
 * `afk/{worker}/{N}-slug` live ref. Returns null for malformed or non-live refs
 * (e.g. afk-attempts/*), so cleanup never acts on an adjacent namespace. */
export function liveIssueFromBranch(branch: string): number | null {
  const m = LIVE_REF_RE.exec(branch);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** Issue number from a snapshot ref afk-attempts/{worker}/{N}-slug. Returns null
 * for malformed refs. Mirrors _attempt_snapshot_issue_from_branch. */
export function attemptIssueFromBranch(branch: string): number | null {
  const m = ATTEMPT_REF_RE.exec(branch);
  return m ? Number(m[1]) : null;
}

/** Translate raw gh metadata into the S1 state vocabulary. Pure: `now` and the
 * grace window are inputs. Mirrors _attempt_snapshot_issue_state_from_gh:
 *   - undefined lookup        → unresolved-transient (transient gh failure)
 *   - null lookup             → not-found (definitive 404)
 *   - state OPEN              → open
 *   - state CLOSED, parseable closedAt → closed-within-grace / closed-past-grace
 *       by (now - closedAt > grace)
 *   - anything else (missing/garbage closedAt, unknown state) → unresolved-transient
 */
export function classifyIssueState(
  meta: IssueMeta | null | undefined,
  nowS: number,
  graceS: number,
): IssueState {
  if (meta === undefined) return "unresolved-transient";
  if (meta === null) return "not-found";
  switch (meta.state) {
    case "OPEN":
      return "open";
    case "CLOSED": {
      const closedAt = meta.closedAt;
      if (!closedAt) return "unresolved-transient";
      const closedS = Math.floor(Date.parse(closedAt) / 1000);
      if (!Number.isFinite(closedS)) return "unresolved-transient";
      return nowS - closedS > graceS ? "closed-past-grace" : "closed-within-grace";
    }
    default:
      return "unresolved-transient";
  }
}

// ---------- per-namespace policies (pure) ----------

/** Live policy: reap once the issue is CLOSED (within or past grace), keep
 * everything else. No grace window. Mirrors _live_branch_cleanup_policy. */
function livePolicy(state: IssueState): "keep" | "reap" {
  return state === "closed-within-grace" || state === "closed-past-grace" ? "reap" : "keep";
}

// ---------- shared decider ----------

/** Shared keep/reap planner. Parses the issue from each ref, classifies each
 * issue once (cached across branches of the same issue), and applies the policy.
 * Refs with an unparseable / unknown-namespace branch are dropped from the plan
 * (left in place on origin). Mirrors _branch_cleanup_plan. */
function plan(
  refs: readonly BranchRef[],
  issueParser: (branch: string) => number | null,
  lookup: IssueLookup,
  nowS: number,
  graceS: number,
  policy: (state: IssueState, nowS: number, graceS: number, commitS: number | undefined) => "keep" | "reap",
): BranchDecision[] {
  const grace = Number.isFinite(graceS) && graceS >= 0 ? graceS : 0;
  const now = Number.isFinite(nowS) ? nowS : 0;
  const stateCache = new Map<number, IssueState>();
  const decisions: BranchDecision[] = [];

  for (const ref of refs) {
    const issue = issueParser(ref.branch);
    if (issue === null) continue;

    let state = stateCache.get(issue);
    if (state === undefined) {
      const raw = classifyIssueState(lookup(issue), now, grace);
      state = ISSUE_STATES.includes(raw) ? raw : "unresolved-transient";
      stateCache.set(issue, state);
    }

    const action = policy(state, now, grace, ref.commitS);
    decisions.push({ action, branch: ref.branch, issue, state });
  }

  return decisions;
}

/** Plan the remote live (afk/*) reaper. Reaps closed-issue branches; keeps
 * open / not-found / transient. No grace window. Mirrors live_branch_cleanup_plan
 * + prune_completed_remote_live_branches (which classify with grace 0). */
export function planLiveBranchCleanup(
  refs: readonly BranchRef[],
  lookup: IssueLookup,
  nowS: number,
): BranchDecision[] {
  return plan(refs, liveIssueFromBranch, lookup, nowS, 0, (state) => livePolicy(state));
}

/** Plan the local live (afk/*) reaper. Identical parser and policy to the remote
 * live reaper; the caller must already have excluded checked-out branches.
 * Mirrors prune_completed_local_branches. */
export function planLocalBranchCleanup(
  refs: readonly BranchRef[],
  lookup: IssueLookup,
  nowS: number,
): BranchDecision[] {
  return planLiveBranchCleanup(refs, lookup, nowS);
}

/** The subset of a plan to actually delete, in input order. */
export function branchesToReap(decisions: readonly BranchDecision[]): BranchDecision[] {
  return decisions.filter((d) => d.action === "reap");
}

/** The subset of a plan to keep, in input order. */
export function branchesToKeep(decisions: readonly BranchDecision[]): BranchDecision[] {
  return decisions.filter((d) => d.action === "keep");
}
