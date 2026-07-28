// attempt-retention.ts — the reclaim rule keyed on the attempt record (ADR 0128).
//
// ONE RULE, STATED ONCE: an artifact is reclaimable when its ATTEMPT RECORD
// says so, never when a pid file happens to be missing. Nothing in this module
// reads a pid, a pid file, or an mtime, because keying on those produced the
// exact inversion they were meant to prevent — the live supervisor's lane was
// deleted while the dead ones survived (#2679).
//
// The retention contract, by tier:
//
//   live       — the record carries no terminal outcome. NOTHING it owns is
//                reclaimable, whatever an artifact claims about itself.
//   landed     — the attempt landed. Its record and its pointers (branch, PR,
//                commits) are retained on the durable lane; its workspace and
//                its evidence are reclaimable, because the landing is the proof.
//   failed     — any other terminal outcome. The record, the pointers, and the
//                cheap EVIDENCE are retained: that is what a human needs to
//                rescue orphaned work (#2701). Only the expensive WORKSPACE is
//                reclaimed, and the plan names it.
//   discarded  — the attempt produced nothing worth keeping: workspace and
//                evidence both go, the pointers stay in the record.
//
// Two record-level overrides win inside any closed tier: `reclaimable: false`
// pins an artifact the tier would otherwise reclaim, and `reclaim_after` holds
// one until that instant has passed.
//
// And one discipline over all of it: A SILENT TRUNCATION IS A FAILURE. Every
// artifact considered lands in exactly one of `reclaim`, `retain`, or
// `dropped`, and `totals` states the identity so a caller can assert it.

import type {
  CastleAttemptArtifact,
  CastleAttemptOutcomeKind,
  CastleAttemptRecord,
} from "./contracts/index.js";

/** What an attempt's outcome retains. */
export type CastleRetentionTier = "live" | "landed" | "failed" | "discarded";

/** What an artifact costs to keep, which is what decides whether it is kept. */
export type CastleArtifactClass = "workspace" | "evidence" | "pointer" | "unknown";

/** Expensive and regenerable: the bytes that fill a disk (2.3 GB on one box). */
export const CASTLE_WORKSPACE_ARTIFACT_KINDS = [
  "worktree",
  "workspace",
  "node_modules",
  "checkout",
  "build-cache",
  "sandbox",
] as const;

/** Cheap and irreplaceable: the material a rescue reads after the worker died. */
export const CASTLE_EVIDENCE_ARTIFACT_KINDS = [
  "log",
  "diagnostic",
  "envelope",
  "transcript",
  "patch",
  "handoff",
  "report",
] as const;

/** Named elsewhere, so there are no bytes here to reclaim. */
export const CASTLE_POINTER_ARTIFACT_KINDS = [
  "branch",
  "pr",
  "commit",
  "tag",
  "issue",
] as const;

const CLASS_BY_KIND = new Map<string, CastleArtifactClass>([
  ...CASTLE_WORKSPACE_ARTIFACT_KINDS.map(
    (kind) => [kind, "workspace"] as const,
  ),
  ...CASTLE_EVIDENCE_ARTIFACT_KINDS.map((kind) => [kind, "evidence"] as const),
  ...CASTLE_POINTER_ARTIFACT_KINDS.map((kind) => [kind, "pointer"] as const),
]);

/** Classify one artifact kind. An unrecognised kind is `unknown` on purpose:
 * the janitor retains and REPORTS what it cannot classify, never guesses. */
export function classifyCastleArtifact(kind: string): CastleArtifactClass {
  return CLASS_BY_KIND.get(kind) ?? "unknown";
}

/**
 * The single liveness anchor (ADR 0128 §5). An attempt is live until its record
 * carries a terminal outcome — that is the whole test, and adding a second
 * anchor beside it is the bug class this ADR forbids.
 */
export function castleAttemptIsLive(record: CastleAttemptRecord): boolean {
  return !record.closed;
}

/** Which retention tier a record's outcome puts it in. */
export function castleRetentionTier(
  record: CastleAttemptRecord,
): CastleRetentionTier {
  if (castleAttemptIsLive(record)) return "live";
  const kind: CastleAttemptOutcomeKind | undefined = record.outcome?.kind;
  if (kind === "done") return "landed";
  if (kind === "discarded") return "discarded";
  return "failed";
}

export type CastleReclaimVerdictKind =
  /** The record is open — the veto that outranks everything else. */
  | "attempt-live"
  /** The record pins this artifact explicitly. */
  | "record-forbids"
  /** `reclaim_after` has not passed yet (or does not parse). */
  | "grace-period"
  /** A branch, PR, or commit: named elsewhere, no bytes to reclaim. */
  | "pointer-retained"
  /** An unrecognised kind: retained and reported, never guessed at. */
  | "unclassified"
  /** Cheap evidence of a failed attempt — the rescue material. */
  | "evidence-retained"
  /** Expensive, regenerable workspace of a closed attempt. */
  | "workspace-reclaimable"
  /** Evidence of an attempt whose outcome makes it no longer load-bearing. */
  | "evidence-reclaimable";

/** One artifact, one verdict, one reason. */
export interface CastleArtifactVerdict {
  attempt_id: string;
  worker_id: string;
  issue: number;
  artifact: CastleAttemptArtifact;
  class: CastleArtifactClass;
  tier: CastleRetentionTier;
  reclaim: boolean;
  verdict: CastleReclaimVerdictKind;
  reason: string;
}

/** The pointers an attempt leaves behind — retained whatever happened to it. */
export interface CastleRetainedPointers {
  branch?: string;
  pr?: number;
  commits: string[];
}

/** One attempt's share of the plan. */
export interface CastleAttemptRetention {
  attempt_id: string;
  worker_id: string;
  issue: number;
  try: number;
  tier: CastleRetentionTier;
  outcome?: CastleAttemptOutcomeKind;
  pointers: CastleRetainedPointers;
  reclaim: CastleArtifactVerdict[];
  retain: CastleArtifactVerdict[];
}

export const CASTLE_RECLAIM_LIMIT_REASON = "limit" as const;

export type CastleReclaimDropReason = "limit" | "no-record";

/** Something the planner did NOT plan, and why. Never omitted silently. */
export interface CastleReclaimDrop {
  reason: CastleReclaimDropReason;
  detail: string;
  path?: string;
  attempt_id?: string;
}

export interface CastleReclaimTotals {
  considered: number;
  reclaim: number;
  retain: number;
  dropped: number;
}

export interface CastleReclaimPlan {
  attempts: CastleAttemptRetention[];
  reclaim: CastleArtifactVerdict[];
  retain: CastleArtifactVerdict[];
  dropped: CastleReclaimDrop[];
  /** True when a cap held reclaimable artifacts back. They are in `dropped`. */
  truncated: boolean;
  totals: CastleReclaimTotals;
}

export interface CastleReclaimOptions {
  /** The instant `reclaim_after` is measured against. Injected, so this is pure. */
  nowIso?: string;
  /** Cap on reclaim actions per sweep. Everything past it is REPORTED, not dropped quietly. */
  limit?: number;
  /** Paths seen on disk. Any the records do not account for is reported and left alone. */
  observedPaths?: readonly string[];
}

const NO_RECORD_DETAIL =
  "no attempt record accounts for this path; the janitor leaves it alone";

function graceHasPassed(reclaimAfter: string, nowIso: string): boolean {
  const after = Date.parse(reclaimAfter);
  const now = Date.parse(nowIso);
  // An unparsable grace is treated as still running: the janitor holds bytes it
  // cannot reason about rather than deleting them.
  if (Number.isNaN(after) || Number.isNaN(now)) return false;
  return now >= after;
}

/**
 * Every path a LIVE attempt owns. A retry is a fresh attempt on the SAME
 * workspace path (ADR 0103), so the previous try's closed record would otherwise
 * offer the running one's bytes up for reclaim. Liveness wins at path
 * granularity, not just record granularity.
 */
function pathsOwnedByLiveAttempts(
  records: readonly CastleAttemptRecord[],
): Set<string> {
  const owned = new Set<string>();
  for (const record of records) {
    if (!castleAttemptIsLive(record)) continue;
    for (const artifact of record.artifacts) {
      if (artifact.path !== undefined) owned.add(artifact.path);
    }
  }
  return owned;
}

function judge(
  record: CastleAttemptRecord,
  tier: CastleRetentionTier,
  artifact: CastleAttemptArtifact,
  nowIso: string,
  liveOwned: ReadonlySet<string>,
): CastleArtifactVerdict {
  const cls = classifyCastleArtifact(artifact.kind);
  const base = {
    attempt_id: record.attempt_id,
    worker_id: record.worker_id,
    issue: record.issue,
    artifact,
    class: cls,
    tier,
  } as const;
  const retain = (
    verdict: CastleReclaimVerdictKind,
    reason: string,
  ): CastleArtifactVerdict => ({ ...base, reclaim: false, verdict, reason });
  const reclaim = (
    verdict: CastleReclaimVerdictKind,
    reason: string,
  ): CastleArtifactVerdict => ({ ...base, reclaim: true, verdict, reason });

  if (tier === "live") {
    return retain(
      "attempt-live",
      "the attempt record carries no terminal outcome, so nothing it owns is reclaimable",
    );
  }
  if (artifact.path !== undefined && liveOwned.has(artifact.path)) {
    return retain(
      "attempt-live",
      "a live attempt owns this path; this attempt's own outcome does not release it",
    );
  }
  if (artifact.reclaimable === false) {
    return retain(
      "record-forbids",
      artifact.reason ?? "the attempt record marks this artifact not reclaimable",
    );
  }
  if (artifact.reclaim_after && !graceHasPassed(artifact.reclaim_after, nowIso)) {
    return retain(
      "grace-period",
      `held until reclaim_after ${artifact.reclaim_after}`,
    );
  }
  if (cls === "pointer") {
    return retain(
      "pointer-retained",
      `a ${artifact.kind} pointer is named by the record, not stored by it`,
    );
  }
  if (cls === "unknown") {
    return retain(
      "unclassified",
      `artifact kind ${JSON.stringify(artifact.kind)} is not a known retention class`,
    );
  }
  if (cls === "workspace") {
    return reclaim(
      "workspace-reclaimable",
      `the attempt is ${tier}, and its workspace is expensive and regenerable`,
    );
  }
  if (tier === "failed") {
    return retain(
      "evidence-retained",
      "the attempt failed, so its cheap evidence is the material a rescue reads",
    );
  }
  return reclaim(
    "evidence-reclaimable",
    `the attempt is ${tier}, so its evidence is no longer load-bearing`,
  );
}

function pointersOf(record: CastleAttemptRecord): CastleRetainedPointers {
  const pointers: CastleRetainedPointers = { commits: [...record.commits] };
  if (record.branch !== undefined) pointers.branch = record.branch;
  if (record.pr !== undefined) pointers.pr = record.pr;
  return pointers;
}

/**
 * Plan the reclaim for a set of attempt records.
 *
 * The plan is total: every artifact on every record — plus every observed path
 * the records do not account for — appears exactly once across `reclaim`,
 * `retain`, and `dropped`, and `totals` states that identity.
 */
export function planCastleReclaim(
  records: readonly CastleAttemptRecord[],
  options: CastleReclaimOptions = {},
): CastleReclaimPlan {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const attempts: CastleAttemptRetention[] = [];
  const reclaim: CastleArtifactVerdict[] = [];
  const retain: CastleArtifactVerdict[] = [];
  const dropped: CastleReclaimDrop[] = [];
  const accounted = new Set<string>();
  // Counted from the INPUT, never from the output arrays, so the accounting
  // identity in `totals` is a real assertion rather than a tautology.
  let considered = 0;
  const liveOwned = pathsOwnedByLiveAttempts(records);

  for (const record of records) {
    const tier = castleRetentionTier(record);
    const attempt: CastleAttemptRetention = {
      attempt_id: record.attempt_id,
      worker_id: record.worker_id,
      issue: record.issue,
      try: record.try,
      tier,
      pointers: pointersOf(record),
      reclaim: [],
      retain: [],
    };
    if (record.outcome?.kind !== undefined) attempt.outcome = record.outcome.kind;
    for (const artifact of record.artifacts) {
      considered += 1;
      if (artifact.path !== undefined) accounted.add(artifact.path);
      const verdict = judge(record, tier, artifact, nowIso, liveOwned);
      if (verdict.reclaim) {
        // The cap is applied here so a held-back artifact is REPORTED as a drop
        // rather than quietly re-labelled as retained — a caller reading
        // `retain` must never be told an artifact was kept on purpose when it
        // was really just past the cap.
        if (options.limit !== undefined && reclaim.length >= options.limit) {
          dropped.push({
            reason: CASTLE_RECLAIM_LIMIT_REASON,
            detail: `reclaim limit ${options.limit} reached; this artifact was not planned`,
            attempt_id: record.attempt_id,
            ...(artifact.path === undefined ? {} : { path: artifact.path }),
          });
          continue;
        }
        reclaim.push(verdict);
        attempt.reclaim.push(verdict);
      } else {
        retain.push(verdict);
        attempt.retain.push(verdict);
      }
    }
    attempts.push(attempt);
  }

  for (const path of options.observedPaths ?? []) {
    if (accounted.has(path)) continue;
    considered += 1;
    dropped.push({ reason: "no-record", path, detail: NO_RECORD_DETAIL });
  }

  return {
    attempts,
    reclaim,
    retain,
    dropped,
    truncated: dropped.some((drop) => drop.reason === CASTLE_RECLAIM_LIMIT_REASON),
    totals: {
      considered,
      reclaim: reclaim.length,
      retain: retain.length,
      dropped: dropped.length,
    },
  };
}
