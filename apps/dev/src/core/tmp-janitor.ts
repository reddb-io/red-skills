// tmp-janitor.ts — per-lane TTL GC for the .red/tmp tier (ADR 0098 §3).
//
// PURE: all inputs are pre-stat'd by the caller. No I/O, no process/date reads.
//
// Lanes covered by this sweep:
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

import { isAbsolute, relative, resolve, sep } from "node:path";
import { DEAD_WORKER_DIR_TTL_S } from "./reclaim.js";
import type { WorkerProcessVerdict } from "./worker-reclaim.js";

/**
 * Whether a path lies strictly inside a tmp tier. An ATTEMPT RECORD may name any
 * path at all, so every record-keyed removal is gated on this: a record naming a
 * path outside `.red/tmp/` is reported and refused, never obeyed.
 */
export function pathIsInsideTmp(tmpDir: string, path: string): boolean {
  const rel = relative(resolve(tmpDir), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// ---------- TTL constants (ADR 0098 §3) ----------

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
  "supervisors",
  "claims",
  "waits",
  "worktrees",
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

/**
 * The apply-time gate for the unknown-entry removal path: a REGISTERED lane can
 * never be deleted as an unknown tmp-root entry, whatever the plan claims.
 *
 * `auditTmpRoot` already excludes known lanes when the plan is built, so this is
 * the second, non-negotiable barrier — a plan produced by an older bundle, a
 * hand-built plan, or a future lane-registry drift must not be able to take out
 * a live lane root (issue #2679: `supervisors` was removed this way, blinding
 * `fleet_status` for a healthy fleet). Lane roots are only ever reclaimed by
 * their own owner-aware sweeps.
 */
export function removableUnknownTmpRoots(names: readonly string[]): string[] {
  return names.filter((name) => !KNOWN_TMP_LANES.has(name));
}

// ---------- combined planner ----------

export interface TmpJanitorInput {
  /** Current epoch seconds (injected so the planner stays pure). */
  nowS: number;
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
    scratch: planScratchJanitor(input.scratchEntries, nowS),
    diagnostics: planDiagnosticsJanitor(input.diagnosticsEntries, nowS),
    feedbackWorktrees: planFeedbackWorktreeJanitor(input.feedbackEntries, nowS),
    unknownTmpRoots: auditTmpRoot(input.tmpRootNames).unknown,
  };
}

// ---------- orphaned feedback worktree planner ----------

/**
 * Extract the worker ID from a feedback worktree basename.
 *
 * AFK worker branches follow the pattern `afk/<workerID>/<issue>-<slug>`, which
 * slugForBranch converts to `afk-<workerID>-<issue>-<slug>`. Parsing that basename
 * back to a worker ID lets the janitor decide whether the owning worker is still
 * alive without knowing the full branch name.
 *
 * Returns the worker ID string (e.g. `wOF09`) or `null` when the basename is not
 * an AFK-worker branch slug (e.g. `main`, `feature-foo`).
 */
export function parseFeedbackWorktreeWorkerSlug(basename: string): string | null {
  // afk-<workerID>-<issueN>-... where workerID is [A-Za-z0-9]+
  const m = /^afk-([A-Za-z0-9]+)-[1-9][0-9]*-/.exec(basename);
  return m ? (m[1] ?? null) : null;
}

/** An entry under `.red/tmp/worktrees/feedback/` with owner-liveness context. */
export interface OrphanFeedbackEntry extends JanitorEntry {
  /** Directory basename (not the full path). */
  basename: string;
  /**
   * Whether the owning AFK worker is alive:
   * - `false` when the entry is for an AFK worker branch whose worker.pid is dead.
   * - `true` when the owning worker is still alive.
   * - `null` when the entry is NOT an AFK worker branch (e.g. `main`, trunk) and
   *   liveness must be inferred from `anyWorkerAlive` instead.
   */
  ownerAlive: boolean | null;
}

export interface OrphanFeedbackSweepPlan {
  /** Entries whose owning worker is confirmed dead or whose non-worker owner is
   * absent (no live workers at all). These are safe to remove. */
  reclaim: OrphanFeedbackEntry[];
  /** Entries with a live owner — do not touch. */
  spare: OrphanFeedbackEntry[];
}

/**
 * Plan which feedback worktrees to remove based on dead ownership — independently
 * of the mtime TTL sweep (which still runs on its own schedule).
 *
 * - AFK-worker entries (`ownerAlive === false`) → reclaim immediately: the owning
 *   worker died and will never use this cache again.
 * - Non-worker entries, e.g. the shared `main` / trunk baseline worktree
 *   (`ownerAlive === null`) → reclaim only when `anyWorkerAlive` is false: any live
 *   worker might be mid-baseline-probe right now, so removing while workers are
 *   running is unsafe.
 * - Live-owner entries (`ownerAlive === true`) → always spare.
 */
export function planOrphanFeedbackWorktreeSweep(
  entries: readonly OrphanFeedbackEntry[],
  anyWorkerAlive: boolean,
): OrphanFeedbackSweepPlan {
  const reclaim: OrphanFeedbackEntry[] = [];
  const spare: OrphanFeedbackEntry[] = [];
  for (const entry of entries) {
    if (entry.ownerAlive === false) {
      reclaim.push(entry);
    } else if (entry.ownerAlive === null && !anyWorkerAlive) {
      reclaim.push(entry);
    } else {
      spare.push(entry);
    }
  }
  return { reclaim, spare };
}

// ---------- stale worker planner ----------

export interface WorkerDirIssueState {
  issue: number;
  state: "OPEN" | "CLOSED" | "UNKNOWN";
}

export interface WorkerDirJanitorEntry {
  path: string;
  /** Directory mtime in epoch seconds, collected once for the pure TTL plan. */
  mtimeS: number;
  /**
   * The DAEMON's verdict on the Worker that owns this dir (Spec #2772 US 46).
   * `unknown` — an unreachable or stale daemon — is not `dead`, so it spares the
   * dir: a reader that could not reach the authority must never report a running
   * Worker as gone, which is how a janitor came to delete a live lane (#2679).
   */
  liveness: WorkerProcessVerdict;
  issues: readonly WorkerDirIssueState[];
}

export interface WorkerDirJanitorPlan {
  reclaim: WorkerDirJanitorEntry[];
  spare: WorkerDirJanitorEntry[];
}

/** Plan dead-worker-dir cleanup. A worker dir is reclaimable only when the
 * DAEMON calls its Worker dead, it represents at least one issue, and every
 * issue it represents is known closed.
 *
 * The liveness question is asked of the daemon, which owns process death by
 * construction, and never of a pid file (Spec #2772 US 46): keying reclaim on a
 * missing pid file is what deleted a live lane and kept the dead ones (#2679).
 * A missing pid file is therefore not even an input here — only the daemon's own
 * fresh answer can release a dir. */
export function planWorkerDirJanitor(
  entries: readonly WorkerDirJanitorEntry[],
  nowS: number,
): WorkerDirJanitorPlan {
  const reclaim: WorkerDirJanitorEntry[] = [];
  const spare: WorkerDirJanitorEntry[] = [];
  for (const entry of entries) {
    const issues = entry.issues;
    const everyIssueClosed = issues.length > 0 && issues.every((issue) => issue.state === "CLOSED");
    const everyIssueKnown = issues.length > 0 && issues.every((issue) => issue.state !== "UNKNOWN");
    const anyIssueOpen = issues.some((issue) => issue.state === "OPEN");
    const openIssueTtlExpired =
      everyIssueKnown &&
      anyIssueOpen &&
      nowS - entry.mtimeS >= DEAD_WORKER_DIR_TTL_S;
    if (entry.liveness === "dead" && (everyIssueClosed || openIssueTtlExpired)) {
      reclaim.push(entry);
    } else {
      spare.push(entry);
    }
  }
  return { reclaim, spare };
}

// ---------- supervisor lane planner ----------

/** One fleet dir under `.red/tmp/supervisors/`.
 *
 * Liveness carries THREE independent anchors, not one. The pid file is the
 * authoritative lock when present, but a supervisor whose lane was swept (or
 * that booted from a bundle predating the pid re-pin) keeps ticking while the
 * pid file is absent — its state snapshot and its `s<pid>/` log dir still name
 * the live process. Keying the sweep off the pid file alone deleted the runtime
 * dir of a running supervisor and blinded `fleet_status` (issue #2679). */
export interface SupervisorLaneEntry {
  /** Absolute path of the fleet dir (e.g. `.red/tmp/supervisors/default`). */
  path: string;
  /** Fleet name (the basename of the fleet dir). */
  fleet: string;
  /** Whether `afk-supervisor.pid` in this fleet dir names a live process. */
  pidAlive: boolean;
  /** Whether the fleet state snapshot (`state.toon`) names a live process. */
  statePidAlive?: boolean;
  /** Whether an `s<pid>/` supervisor log dir in this fleet names a live process. */
  snapshotPidAlive?: boolean;
}

/** Whether ANY liveness anchor in a fleet dir names a live process. A lane with
 * a live anchor is never reclaimable. */
export function supervisorLaneIsLive(entry: SupervisorLaneEntry): boolean {
  return entry.pidAlive || entry.statePidAlive === true || entry.snapshotPidAlive === true;
}

export interface SupervisorLanePlan {
  /** Fleet dirs whose supervisor pid is dead — safe to reclaim. */
  reclaim: SupervisorLaneEntry[];
  /** Fleet dirs whose supervisor pid is alive — must be spared. */
  spare: SupervisorLaneEntry[];
}

/** Plan supervisor lane cleanup. A fleet dir is reclaimable only when NO
 * liveness anchor — pid file, state snapshot, or `s<pid>/` log dir — names a
 * live process. Live supervisors are always spared regardless of mtime. */
export function planSupervisorLaneJanitor(entries: readonly SupervisorLaneEntry[]): SupervisorLanePlan {
  const reclaim: SupervisorLaneEntry[] = [];
  const spare: SupervisorLaneEntry[] = [];
  for (const entry of entries) {
    if (supervisorLaneIsLive(entry)) spare.push(entry);
    else reclaim.push(entry);
  }
  return { reclaim, spare };
}
