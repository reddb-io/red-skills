// tmp-janitor.ts — per-lane TTL GC for the .red/tmp tier (ADR 0098 §3).
//
// PURE: all inputs are pre-stat'd by the caller. No I/O, no process/date reads.
//
// Lanes covered by this sweep:
//   tmp/logs/<yyyy-mm-dd>/   — short TTL; date-dirs older than LOGS_TTL_S are reclaimed
//   tmp/scratch/             — short TTL; entries older than SCRATCH_TTL_S are reclaimed
//   tmp/diagnostics/         — age cap; entries older than DIAGNOSTICS_TTL_S are reclaimed
//   tmp/worktrees/feedback/  — mtime TTL on top of existing SHA invalidation;
//                              entries older than FEEDBACK_TTL_S are reclaimed
//
// Lanes NOT in scope (owned by other sweeps):
//   tmp/workers/, tmp/go-workers/, tmp/scout-workers/  — AFK orphan/attempt-cap sweep
//   tmp/claims/                                         — stale-claim sweep
//   tmp/waits/                                          — rsp wait exit semantics
//   tmp/worktrees/manual/                               — never auto-deleted
//   tmp/worktrees/{landing,rebase,cascade,adopt,docs}/  — operation-lifecycle sweeps
//
// Unknown dirs or files at the tmp root are REPORTED and LEFT UNTOUCHED. The
// janitor never deletes outside its known lanes.

// ---------- TTL constants (ADR 0098 §3) ----------

/** Short TTL for session log date-dirs under tmp/logs/<yyyy-mm-dd>/. */
export const LOGS_TTL_S = 7 * 86400;

/** Short TTL for entries under tmp/scratch/. */
export const SCRATCH_TTL_S = 3 * 86400;

/** Age cap for failure-diagnostics entries under tmp/diagnostics/. */
export const DIAGNOSTICS_TTL_S = 30 * 86400;

/** mtime TTL for feedback worktree cache entries under tmp/worktrees/feedback/.
 * Layered on top of the existing SHA invalidation — the mtime sweep reclaims
 * entries that have not been touched recently regardless of SHA currency. */
export const FEEDBACK_TTL_S = 7 * 86400;

// ---------- lane registry (ADR 0098 §2) ----------

/** Named entries that may appear directly under .red/tmp/. Anything not in
 * this set is an unknown lane: reported by auditTmpRoot, never deleted. */
export const KNOWN_TMP_LANES = new Set([
  "workers",
  "go-workers",
  "scout-workers",
  "claims",
  "waits",
  "worktrees",
  "logs",
  "scratch",
  "diagnostics",
]);

// ---------- types ----------

/** One stat'd entry under a janitor-managed lane. */
export interface JanitorEntry {
  /** Absolute path of the entry (dir or file). */
  path: string;
  /** mtime of the entry in epoch seconds. */
  mtimeS: number;
}

/** Split of a lane's entries into those to reclaim vs those to spare. */
export interface JanitorLanePlan {
  reclaim: JanitorEntry[];
  spare: JanitorEntry[];
}

// ---------- per-lane planners ----------

/** Decide which log date-dirs to reclaim.
 * Reclaims dirs whose (nowS - mtimeS) strictly exceeds LOGS_TTL_S. */
export function planLogsJanitor(
  entries: readonly JanitorEntry[],
  nowS: number,
): JanitorLanePlan {
  return splitByTtl(entries, nowS, LOGS_TTL_S);
}

/** Decide which scratch entries to reclaim.
 * Reclaims entries whose (nowS - mtimeS) strictly exceeds SCRATCH_TTL_S. */
export function planScratchJanitor(
  entries: readonly JanitorEntry[],
  nowS: number,
): JanitorLanePlan {
  return splitByTtl(entries, nowS, SCRATCH_TTL_S);
}

/** Decide which diagnostics entries to reclaim.
 * Reclaims entries whose (nowS - mtimeS) strictly exceeds DIAGNOSTICS_TTL_S. */
export function planDiagnosticsJanitor(
  entries: readonly JanitorEntry[],
  nowS: number,
): JanitorLanePlan {
  return splitByTtl(entries, nowS, DIAGNOSTICS_TTL_S);
}

/** Decide which feedback worktree entries to reclaim by mtime TTL.
 * Reclaims entries whose (nowS - mtimeS) strictly exceeds FEEDBACK_TTL_S.
 * SHA invalidation is the caller's concern and runs independently; this
 * planner only evaluates the mtime-based TTL. */
export function planFeedbackWorktreeJanitor(
  entries: readonly JanitorEntry[],
  nowS: number,
): JanitorLanePlan {
  return splitByTtl(entries, nowS, FEEDBACK_TTL_S);
}

function splitByTtl(
  entries: readonly JanitorEntry[],
  nowS: number,
  ttlS: number,
): JanitorLanePlan {
  const reclaim: JanitorEntry[] = [];
  const spare: JanitorEntry[] = [];
  for (const e of entries) {
    if (nowS - e.mtimeS > ttlS) reclaim.push(e);
    else spare.push(e);
  }
  return { reclaim, spare };
}

// ---------- tmp-root audit ----------

/** Audit result for entries at the tmp root. */
export interface TmpRootAudit {
  /** Names at the tmp root that are not in KNOWN_TMP_LANES.
   * The janitor reports these but never deletes them. */
  unknown: string[];
}

/** Classify names present directly under .red/tmp/. Names absent from
 * KNOWN_TMP_LANES are flagged as unknown; the janitor reports but never
 * touches them. */
export function auditTmpRoot(names: readonly string[]): TmpRootAudit {
  const unknown: string[] = [];
  for (const name of names) {
    if (!KNOWN_TMP_LANES.has(name)) unknown.push(name);
  }
  return { unknown };
}

// ---------- combined planner ----------

export interface TmpJanitorInput {
  /** Current epoch seconds (injected so the planner stays pure). */
  nowS: number;
  /** Stat'd entries under tmp/logs/ (the date-dir level). */
  logEntries: readonly JanitorEntry[];
  /** Stat'd entries under tmp/scratch/. */
  scratchEntries: readonly JanitorEntry[];
  /** Stat'd entries under tmp/diagnostics/. */
  diagnosticsEntries: readonly JanitorEntry[];
  /** Stat'd entries under tmp/worktrees/feedback/. */
  feedbackEntries: readonly JanitorEntry[];
  /** Names (not full paths) present directly under the tmp root. */
  tmpRootNames: readonly string[];
}

export interface TmpJanitorPlan {
  logs: JanitorLanePlan;
  scratch: JanitorLanePlan;
  diagnostics: JanitorLanePlan;
  feedbackWorktrees: JanitorLanePlan;
  /** Names at the tmp root not in KNOWN_TMP_LANES: reported, never deleted. */
  unknownTmpRoots: string[];
}

/** Plan the full janitor sweep across all covered lanes. */
export function planTmpJanitor(input: TmpJanitorInput): TmpJanitorPlan {
  const { nowS } = input;
  return {
    logs: planLogsJanitor(input.logEntries, nowS),
    scratch: planScratchJanitor(input.scratchEntries, nowS),
    diagnostics: planDiagnosticsJanitor(input.diagnosticsEntries, nowS),
    feedbackWorktrees: planFeedbackWorktreeJanitor(input.feedbackEntries, nowS),
    unknownTmpRoots: auditTmpRoot(input.tmpRootNames).unknown,
  };
}

// ---------- stale worker planner ----------

export interface WorkerDirIssueState {
  issue: number;
  state: "OPEN" | "CLOSED" | "UNKNOWN";
}

export interface WorkerDirJanitorEntry {
  path: string;
  workerPidLive: boolean;
  issues: readonly WorkerDirIssueState[];
}

export interface WorkerDirJanitorPlan {
  reclaim: WorkerDirJanitorEntry[];
  spare: WorkerDirJanitorEntry[];
}

/** Plan dead-worker-dir cleanup. A worker dir is reclaimable only when its
 * worker.pid is not live, it has at least one issue-bearing attempt, and every
 * issue represented by the worker dir is known closed. */
export function planWorkerDirJanitor(entries: readonly WorkerDirJanitorEntry[]): WorkerDirJanitorPlan {
  const reclaim: WorkerDirJanitorEntry[] = [];
  const spare: WorkerDirJanitorEntry[] = [];
  for (const entry of entries) {
    const issues = entry.issues;
    if (!entry.workerPidLive && issues.length > 0 && issues.every((issue) => issue.state === "CLOSED")) {
      reclaim.push(entry);
    } else {
      spare.push(entry);
    }
  }
  return { reclaim, spare };
}
