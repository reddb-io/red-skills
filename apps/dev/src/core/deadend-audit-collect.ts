// deadend-audit-collect.ts — assemble the deadend audit from a read-only
// gateway and run the pure detector (issue #2428).
//
// The gateway is the ONLY seam the collector touches, and it is read-only by
// type. A consumer builds a gateway over the GitHub read helpers and local
// state; a test builds one over fakes (including a mutation recorder) to pin
// that this slice mutates nothing.

import {
  auditDeadends,
  type DeadendAuditReport,
  type DeadendClaim,
  type DeadendIssue,
  type DeadendPr,
  type DeadendWorktree,
  type IssueState,
} from "./deadend-audit.js";

/** Default human-queue outlier threshold: parked longer than two days. */
export const DEFAULT_HUMAN_QUEUE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The read-only data source the collector pulls from. Every method is a read;
 * the interface carries no mutation, so a collector built on it cannot change
 * repository or local state.
 */
export interface DeadendAuditReader {
  /** Wall clock in epoch ms. */
  now(): number;
  /** Ids of workers currently live. */
  liveWorkers(): Promise<readonly string[]>;
  /** Open Tickets with labels + body + last-moved timestamp. */
  openIssues(): Promise<readonly DeadendIssue[]>;
  /** Open PRs with owner + failing-checks flag + linked Ticket. */
  openPrs(): Promise<readonly DeadendPr[]>;
  /** Live claim holders across in-flight Tickets. */
  claims(): Promise<readonly DeadendClaim[]>;
  /** Disposable worktree checkouts with a liveness flag. */
  worktrees(): Promise<readonly DeadendWorktree[]>;
  /** State of every Ticket, for resolving `req:*` dependency targets. */
  issueStates(): Promise<ReadonlyMap<number, IssueState>>;
}

export interface CollectDeadendAuditOptions {
  readonly humanQueueMaxAgeMs?: number;
}

/**
 * Gather every deadend input from the reader and run the pure detector. Read
 * only: the collector never writes through the gateway.
 */
export async function collectDeadendAudit(
  reader: DeadendAuditReader,
  options: CollectDeadendAuditOptions = {},
): Promise<DeadendAuditReport> {
  const [liveWorkers, issues, prs, claims, worktrees, issueStates] =
    await Promise.all([
      reader.liveWorkers(),
      reader.openIssues(),
      reader.openPrs(),
      reader.claims(),
      reader.worktrees(),
      reader.issueStates(),
    ]);
  return auditDeadends({
    nowMs: reader.now(),
    liveWorkers,
    issues,
    prs,
    claims,
    worktrees,
    issueStates,
    humanQueueMaxAgeMs:
      options.humanQueueMaxAgeMs ?? DEFAULT_HUMAN_QUEUE_MAX_AGE_MS,
  });
}
