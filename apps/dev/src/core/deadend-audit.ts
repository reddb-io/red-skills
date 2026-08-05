// deadend-audit.ts — the pure deadend detector (issue #2428).
//
// A "deadend" is a stuck AFK pattern that will never drain on its own: a claim
// held by a worker that is gone, a red PR whose owner is gone, a superseded PR
// nobody closed, an executable Ticket whose body still carries an active
// Current blocker, a dependency-blocked Ticket whose req targets all closed, a
// human-queue Ticket that has aged past the outlier threshold, and a stale
// feedback/base worktree left by a dead worker.
//
// This module is DETECTION ONLY — it never mutates. Each detected class carries
// its recommended cure, pinned by {@link CURE_BY_CLASS}, so a consumer
// (the `deadend_audit` MCP tool, /red-doctor) can name the fix without
// re-deriving it. The audit takes already-gathered, plain-data inputs so it is
// trivially testable against fakes and holds zero IO.
//
// The lifecycle vocabulary comes from triage-labels.ts, never a local literal:
// a re-declared `const LABEL_READY = "ready-for-agent"` is how a module drifts
// out of the canonical state vocabulary (#2664).

import { LABEL_DEPENDENCY, LABEL_HUMAN, LABEL_READY } from "./triage-labels.js";
import { parseCurrentBlocker } from "./blocker-state.js";

/** The stuck-pattern taxonomy. One entry per detected deadend class. */
export type DeadendClass =
  | "dangling_claim"
  | "red_pr_dead_owner"
  | "superseded_pr"
  | "active_current_blocker"
  | "dependency_all_closed"
  | "human_queue_age_outlier"
  | "stale_worktree";

/**
 * The recommended cure per class, pinned. A read tool renders these verbatim;
 * changing one is a deliberate protocol change the audit test freezes.
 */
export const CURE_BY_CLASS: Readonly<Record<DeadendClass, string>> = {
  dangling_claim: "claim_release",
  red_pr_dead_owner: "retake",
  superseded_pr: "close_superseded_pr",
  active_current_blocker: "quarantine",
  dependency_all_closed: "unblock_sweep",
  human_queue_age_outlier: "hitl_review",
  stale_worktree: "worktree_remove",
};

/** The canonical class order the report always renders in. */
export const DEADEND_CLASS_ORDER: readonly DeadendClass[] = [
  "dangling_claim",
  "red_pr_dead_owner",
  "superseded_pr",
  "active_current_blocker",
  "dependency_all_closed",
  "human_queue_age_outlier",
  "stale_worktree",
];

export type IssueState = "OPEN" | "CLOSED" | "UNKNOWN";

/** One open Ticket, reduced to the fields the audit inspects. */
export interface DeadendIssue {
  readonly number: number;
  readonly labels: readonly string[];
  readonly body: string;
  /** ISO timestamp the Ticket last moved; the age seam for the human queue. */
  readonly updatedAt?: string;
}

/** One open PR, reduced to the fields the audit inspects. */
export interface DeadendPr {
  readonly number: number;
  /** The Ticket this PR closes, when known — the supersede grouping key. */
  readonly issue?: number;
  /** The worker id (or login) that owns the branch. */
  readonly owner: string;
  /** Whether the PR's required checks are failing. */
  readonly checksRed: boolean;
}

/** One live claim marker: worker `worker` currently holds Ticket `issue`. */
export interface DeadendClaim {
  readonly issue: number;
  readonly worker: string;
}

/** One disposable worktree checkout under `.red/tmp/worktrees/<lane>/`. */
export interface DeadendWorktree {
  readonly lane: string;
  readonly path: string;
  /** Whether the owning worker/process is still live. */
  readonly live: boolean;
}

export interface DeadendAuditInputs {
  readonly nowMs: number;
  /** Live worker ids — a claim or PR owner absent here is "dead". */
  readonly liveWorkers: readonly string[];
  readonly issues: readonly DeadendIssue[];
  readonly prs: readonly DeadendPr[];
  readonly claims: readonly DeadendClaim[];
  readonly worktrees: readonly DeadendWorktree[];
  /** State of every Ticket referenced by a `req:*` label, for class (d). */
  readonly issueStates: ReadonlyMap<number, IssueState>;
  /** A ready-for-human Ticket older than this is an age outlier. */
  readonly humanQueueMaxAgeMs: number;
}

/** One detected deadend, tagged with its class and pinned cure. */
export interface DeadendFinding {
  readonly deadendClass: DeadendClass;
  readonly cure: string;
  /** A short, stable identifier of the stuck subject (e.g. "#123", "worker w8"). */
  readonly subject: string;
  /** Human-readable evidence of why it is stuck. */
  readonly detail: string;
  /**
   * Numeric target for mechanical healing: the issue or PR number the sanctioned
   * core should act on. Present for every mechanically-healable class; absent for
   * non-mechanical ones (`human_queue_age_outlier`, `stale_worktree`).
   * For `red_pr_dead_owner` this is the Ticket number (not the PR number) since
   * the heal action requeues the Ticket.
   */
  readonly healTarget?: number;
}

/** The per-class roll-up the report always emits, even at count 0. */
export interface DeadendClassReport {
  readonly deadendClass: DeadendClass;
  readonly cure: string;
  readonly count: number;
  readonly findings: readonly DeadendFinding[];
}

export interface DeadendAuditReport {
  readonly generatedAtMs: number;
  readonly total: number;
  readonly classes: readonly DeadendClassReport[];
}

const REQ_LABEL_RE = /^req:(\d+)$/;

/** The `req:N` Ticket numbers a label set declares. */
function reqTargets(labels: readonly string[]): number[] {
  const out: number[] = [];
  for (const label of labels) {
    const match = REQ_LABEL_RE.exec(label);
    if (match) out.push(Number(match[1]));
  }
  return out;
}

function danglingClaims(inputs: DeadendAuditInputs, live: ReadonlySet<string>): DeadendFinding[] {
  const findings: DeadendFinding[] = [];
  for (const claim of inputs.claims) {
    if (live.has(claim.worker)) continue;
    findings.push({
      deadendClass: "dangling_claim",
      cure: CURE_BY_CLASS.dangling_claim,
      subject: `#${claim.issue}`,
      detail: `claim held by dead worker ${claim.worker}`,
      healTarget: claim.issue,
    });
  }
  return findings;
}

function redPrsWithDeadOwners(inputs: DeadendAuditInputs, live: ReadonlySet<string>): DeadendFinding[] {
  const findings: DeadendFinding[] = [];
  for (const pr of inputs.prs) {
    // An unknown owner is never "dead" — only a named worker absent from the
    // live set counts, so an unclaimed red PR is not misread as a deadend.
    if (!pr.checksRed || pr.owner.trim() === "" || live.has(pr.owner)) continue;
    findings.push({
      deadendClass: "red_pr_dead_owner",
      cure: CURE_BY_CLASS.red_pr_dead_owner,
      subject: `PR #${pr.number}`,
      detail: `failing checks with dead owner ${pr.owner}`,
      // healTarget is the Ticket to requeue, not the PR; absent when the PR has
      // no linked Ticket so the heal module safely skips it.
      healTarget: pr.issue,
    });
  }
  return findings;
}

function supersededPrs(inputs: DeadendAuditInputs): DeadendFinding[] {
  // Group open PRs by the Ticket they close; when more than one PR targets the
  // same Ticket, the highest-numbered PR is current and the rest are superseded.
  const byIssue = new Map<number, DeadendPr[]>();
  for (const pr of inputs.prs) {
    if (pr.issue === undefined) continue;
    const bucket = byIssue.get(pr.issue);
    if (bucket) bucket.push(pr);
    else byIssue.set(pr.issue, [pr]);
  }
  const findings: DeadendFinding[] = [];
  for (const [issue, prs] of byIssue) {
    if (prs.length < 2) continue;
    const current = prs.reduce((a, b) => (b.number > a.number ? b : a));
    for (const pr of prs) {
      if (pr.number === current.number) continue;
      findings.push({
        deadendClass: "superseded_pr",
        cure: CURE_BY_CLASS.superseded_pr,
        subject: `PR #${pr.number}`,
        detail: `superseded by PR #${current.number} on Ticket #${issue}`,
        healTarget: pr.number,
      });
    }
  }
  return findings;
}

function activeCurrentBlockers(inputs: DeadendAuditInputs): DeadendFinding[] {
  const findings: DeadendFinding[] = [];
  for (const issue of inputs.issues) {
    if (!issue.labels.includes(LABEL_READY)) continue;
    const blocker = parseCurrentBlocker(issue.body);
    if (!blocker) continue;
    findings.push({
      deadendClass: "active_current_blocker",
      cure: CURE_BY_CLASS.active_current_blocker,
      subject: `#${issue.number}`,
      detail: blocker.defect
        ? `ready-for-agent Ticket carries an active Current blocker (${blocker.defect.name}: missing ${blocker.defect.missingFields.join(", ")})`
        : "ready-for-agent Ticket carries an active Current blocker",
      healTarget: issue.number,
    });
  }
  return findings;
}

function dependencyAllClosed(inputs: DeadendAuditInputs): DeadendFinding[] {
  const findings: DeadendFinding[] = [];
  for (const issue of inputs.issues) {
    if (!issue.labels.includes(LABEL_DEPENDENCY)) continue;
    const reqs = reqTargets(issue.labels);
    if (reqs.length === 0) continue;
    const allClosed = reqs.every((n) => inputs.issueStates.get(n) === "CLOSED");
    if (!allClosed) continue;
    findings.push({
      deadendClass: "dependency_all_closed",
      cure: CURE_BY_CLASS.dependency_all_closed,
      subject: `#${issue.number}`,
      detail: `blocked:dependency with all req targets closed (${reqs.map((n) => `#${n}`).join(", ")})`,
      healTarget: issue.number,
    });
  }
  return findings;
}

function humanQueueAgeOutliers(inputs: DeadendAuditInputs): DeadendFinding[] {
  const findings: DeadendFinding[] = [];
  for (const issue of inputs.issues) {
    if (!issue.labels.includes(LABEL_HUMAN)) continue;
    if (!issue.updatedAt) continue;
    const movedMs = Date.parse(issue.updatedAt);
    if (!Number.isFinite(movedMs)) continue;
    const ageMs = inputs.nowMs - movedMs;
    if (ageMs <= inputs.humanQueueMaxAgeMs) continue;
    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
    findings.push({
      deadendClass: "human_queue_age_outlier",
      cure: CURE_BY_CLASS.human_queue_age_outlier,
      subject: `#${issue.number}`,
      detail: `ready-for-human for ${ageHours}h, past the age threshold`,
    });
  }
  return findings;
}

function staleWorktrees(inputs: DeadendAuditInputs): DeadendFinding[] {
  const findings: DeadendFinding[] = [];
  for (const worktree of inputs.worktrees) {
    if (worktree.live) continue;
    findings.push({
      deadendClass: "stale_worktree",
      cure: CURE_BY_CLASS.stale_worktree,
      subject: worktree.path,
      detail: `stale ${worktree.lane} worktree with no live owner`,
    });
  }
  return findings;
}

const DETECTORS: Readonly<
  Record<DeadendClass, (inputs: DeadendAuditInputs, live: ReadonlySet<string>) => DeadendFinding[]>
> = {
  dangling_claim: danglingClaims,
  red_pr_dead_owner: redPrsWithDeadOwners,
  superseded_pr: (inputs) => supersededPrs(inputs),
  active_current_blocker: (inputs) => activeCurrentBlockers(inputs),
  dependency_all_closed: (inputs) => dependencyAllClosed(inputs),
  human_queue_age_outlier: (inputs) => humanQueueAgeOutliers(inputs),
  stale_worktree: (inputs) => staleWorktrees(inputs),
};

/**
 * A findings-free report — one empty entry per class, cures pinned. Used as the
 * doctor's fallback when the live gather fails so one section can never crash
 * the whole command.
 */
export function emptyDeadendReport(nowMs: number): DeadendAuditReport {
  return {
    generatedAtMs: nowMs,
    total: 0,
    classes: DEADEND_CLASS_ORDER.map((deadendClass) => ({
      deadendClass,
      cure: CURE_BY_CLASS[deadendClass],
      count: 0,
      findings: [],
    })),
  };
}

/**
 * Run every deadend detector against pre-gathered inputs and return the
 * per-class roll-up with pinned cures. Pure: no IO, no mutation.
 */
export function auditDeadends(inputs: DeadendAuditInputs): DeadendAuditReport {
  const live = new Set(inputs.liveWorkers);
  let total = 0;
  const classes: DeadendClassReport[] = DEADEND_CLASS_ORDER.map((deadendClass) => {
    const findings = DETECTORS[deadendClass](inputs, live);
    total += findings.length;
    return {
      deadendClass,
      cure: CURE_BY_CLASS[deadendClass],
      count: findings.length,
      findings,
    };
  });
  return { generatedAtMs: inputs.nowMs, total, classes };
}
