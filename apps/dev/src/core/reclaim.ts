// Boot-time reclaim deciders for the AFK orphan cleanup and attempt cap passes
// (PRD #244, issues #252 / #257). Ported from afk.sh: prune_orphans (the orphan
// attempt-dir fate decision) and cap_issue_attempts (the per-issue age/count
// cap).
//
// The classification is PURE, mirroring branch-cleanup.ts: the orphan decider
// takes the already-resolved issue state, label, envelope flag, dir age, and a
// gh-ok flag; the attempt-cap planner takes the already-stat'd attempt dirs with
// their mtime and liveness. No module here performs fs / gh / date I/O — the
// caller resolves those and injects them. Attempt paths are parsed with the
// shared worker-paths.ts parser so the nested layout stays single-sourced.

import { parseReapableWorkerPath } from "./worker-paths.js";
import type { WorkerProcessVerdict } from "./worker-reclaim.js";
import { LABEL_HUMAN, LABEL_RUNNING } from "./triage-labels.js";

/** Orphan TTLs (afk.sh TTL_LONG / TTL_SHORT). */
export const ORPHAN_TTL_LONG_S = 7 * 86400;
export const ORPHAN_TTL_SHORT_S = 1 * 86400;

/** Attempt-cap defaults retained only for legacy-dir cleanup. */
export const DEFAULT_ATTEMPT_TTL_S = 14 * 86400;
export const DEFAULT_ATTEMPT_KEEP = 5;

/** Dead Workers with an OPEN issue keep their evidence but shed the expensive
 * worktree at this age. */
export const DEAD_WORKER_WORKTREE_TTL_S = 14 * 86400;

/** Dead Workers with an OPEN issue are fully reclaimed at this age. */
export const DEAD_WORKER_DIR_TTL_S = 45 * 86400;

// ---------- orphan fate (prune_orphans) ----------

/** Issue open/closed state as reported by `gh issue view --json state`. Any
 * value other than CLOSED is treated as the open branch by the decider. */
export type IssueOpenState = "OPEN" | "CLOSED" | (string & {});

/** Resolved inputs for one orphaned attempt dir. The caller has already read the
 * state file (issue number, envelope.posted), stat'd the dir age, and either
 * fetched `gh issue view --json labels,state` (ghOk=true) or recorded that the
 * fetch failed (ghOk=false). `hasStateFile` is false for a dir with no parseable
 * issue number — afk.sh's `-z issue_n` branch, which never queries gh. */
export interface OrphanInput {
  /** state from gh issue view; ignored when ghOk is false or hasStateFile is false. */
  issueState: IssueOpenState;
  /** The single decision-bearing label, or null. afk.sh checks ready-for-human
   * then running; "ready-for-human" / "running" drive the split branches. */
  label: string | null;
  /** envelope.posted from the attempt state file (default false). */
  envelopePosted: boolean;
  /** Whether the dir carries a state file with a usable issue number. */
  hasStateFile: boolean;
  /** Dir age in seconds (now - mtime). Only meaningful for keep-until fates. */
  ageS: number;
  /** Whether the gh issue-state lookup succeeded. */
  ghOk: boolean;
}

/** The fate of one orphaned attempt dir.
 *   - remove             → rm -rf now (issue closed, or any non-preserved state).
 *   - restore-and-remove → restore ready-for-agent + recovery comment, then rm -rf.
 *   - keep-until(ttlS)   → keep until (now - mtime) > ttlS, i.e. an mtime TTL. */
export type OrphanFate =
  | { kind: "remove" }
  | { kind: "restore-and-remove" }
  | { kind: "keep-until"; ttlS: number };

/** Decide the fate of one orphaned attempt dir. Mirrors the prune_orphans inner
 * loop exactly:
 *   - no state file (no issue number)         → keep-until(1d)  (garbage past short TTL)
 *   - gh lookup failed                        → keep-until(state file ? 7d : 1d)
 *   - issue CLOSED                            → remove
 *   - label ready-for-human                   → keep-until(envelopePosted ? 1d : 7d)
 *   - label running (crashed mid-issue)       → restore-and-remove
 *   - any other open state                    → remove
 *
 * Note the ordering: a dir with no state file never reaches the gh branches, so
 * the ghOk flag is irrelevant there (matches bash, which skips `gh issue view`
 * when issue_n is empty). The CLOSED check precedes the label checks, so a stale
 * ready-for-human / running label on a CLOSED issue still resolves to remove. */
export function decideOrphanFate(input: OrphanInput): OrphanFate {
  if (!input.hasStateFile) {
    // No issue number to query: garbage once it ages past the short TTL.
    return { kind: "keep-until", ttlS: ORPHAN_TTL_SHORT_S };
  }
  if (!input.ghOk) {
    // gh failed → conservative mtime TTL: 7d with a state file, 1d without.
    return {
      kind: "keep-until",
      ttlS: input.hasStateFile ? ORPHAN_TTL_LONG_S : ORPHAN_TTL_SHORT_S,
    };
  }
  if (input.issueState === "CLOSED") return { kind: "remove" };
  if (input.label === LABEL_HUMAN) {
    return {
      kind: "keep-until",
      ttlS: input.envelopePosted ? ORPHAN_TTL_SHORT_S : ORPHAN_TTL_LONG_S,
    };
  }
  if (input.label === LABEL_RUNNING) return { kind: "restore-and-remove" };
  return { kind: "remove" };
}

// ---------- attempt cap (cap_issue_attempts) ----------

/** One stat'd attempt dir for a single issue. `live` is the caller's resolution
 * of _attempt_dir_is_live (state file carrying a live pid). */
export interface AttemptDir {
  /** Absolute attempt dir path under workers/{wid}/{N}-a{attempt}. */
  path: string;
  /** mtime in seconds. */
  mtimeS: number;
  /** Whether a worker is still running this attempt. */
  live: boolean;
}

export interface AttemptCapOptions {
  /** Age cap in seconds. */
  ttlS: number;
  /** Count cap. */
  keep: number;
  /** Current epoch seconds. */
  nowS: number;
}

/** Plan which attempt dirs to reclaim for a SINGLE issue. Mirrors the per-issue
 * body of cap_issue_attempts:
 *   1. Live attempts are excluded entirely — never counted toward the cap nor
 *      removed.
 *   2. Age cap: any non-live dir with (now - mtime) > ttlS is reclaimed; the
 *      rest survive to the count cap.
 *   3. Count cap: of the age-cap survivors, keep the newest `keep` by attempt
 *      number and reclaim the oldest rest.
 * Dirs whose path does not parse under the nested layout are ignored. Returns
 * the reclaimed dirs (age-capped first, then count-capped) — purely a plan; no
 * filesystem effect. */
export function planAttemptCap(
  attemptsForIssue: readonly AttemptDir[],
  opts: AttemptCapOptions,
): AttemptDir[] {
  const ttlS = opts.ttlS;
  const keep = opts.keep;
  const nowS = opts.nowS;

  // Parse + drop live + drop unparseable, carrying the attempt number along.
  const candidates: Array<{ dir: AttemptDir; attempt: number }> = [];
  for (const dir of attemptsForIssue) {
    if (dir.live) continue;
    // Hygiene parser: legacy -a{n} dirs must stay REAPABLE (ADR 0103 #2170).
    const parsed = parseReapableWorkerPath(dir.path);
    if (!parsed) continue;
    candidates.push({ dir, attempt: parsed.attempt });
  }

  const reaped: AttemptDir[] = [];

  // Age cap: drop anything older than the TTL; the rest survive to the count cap.
  const survivors: Array<{ dir: AttemptDir; attempt: number }> = [];
  for (const c of candidates) {
    if (nowS - c.dir.mtimeS > ttlS) reaped.push(c.dir);
    else survivors.push(c);
  }

  // Count cap: keep the newest `keep` by attempt number, drop the oldest rest.
  if (survivors.length > keep) {
    const byAttempt = [...survivors].sort((a, b) => a.attempt - b.attempt);
    const dropN = survivors.length - keep;
    for (let i = 0; i < dropN; i++) reaped.push(byAttempt[i]!.dir);
  }

  return reaped;
}

// ---------- liveness-gated reclaim (issue #1219) ----------

/** One dead-worker candidate for the read-time liveness reclaim. The caller has
 * already asked the DAEMON about the OWNING Worker and resolved the issue's
 * preservation state. */
export interface LivenessReclaimInput {
  /** Absolute attempt dir path (`.../workers/{wid}/{N}-a{n}`). */
  attemptDir: string;
  /** Absolute path of the attempt's heavy `worktree/`. */
  worktreePath: string;
  /** The DAEMON's verdict on the OWNING Worker (Spec #2772 US 46). Keyed on the
   * per-WORKER identity, shared across its attempt dirs, so a Worker still
   * running keeps ALL of them. Only `dead` releases bytes: `unknown` — an
   * unreachable or stale daemon — spares the dir, because a reader that could
   * not reach the authority must never report a running Worker as gone (#2679). */
  liveness: WorkerProcessVerdict;
  /** Tracker state for the represented issue. UNKNOWN is retained. */
  issueState: "OPEN" | "CLOSED" | "UNKNOWN";
  /** Workspace-directory mtime in epoch seconds, injected by the collector. */
  mtimeS: number;
}

/** The reclaim decision for one dead-worker attempt dir. */
export interface LivenessReclaimAction {
  attemptDir: string;
  worktreePath: string;
  /** Always true for an emitted action: stage 1 strips the worktree, while an
   * immediate CLOSED or stage-2 reclaim removes it with the parent dir. */
  removeWorktree: boolean;
  /** Reclaim the whole issue dir: immediately for CLOSED, at 45 days for OPEN. */
  reclaimDir: boolean;
  /** Leave a one-line record beside the retained evidence after stage 1. */
  writeTombstone: boolean;
}

/**
 * Plan the read-time liveness-gated reclaim (issue #1219). PURE — no I/O; the
 * caller resolves liveness, issue state, age anchor, and clock.
 *   - A dir whose Worker the daemon has not called dead is NEVER touched.
 *   - A dead Worker's CLOSED issue dir is reclaimed immediately.
 *   - A dead Worker's OPEN issue keeps everything for 14 days, then loses only
 *     `worktree/` with a tombstone, then is fully reclaimed at 45 days.
 *   - UNKNOWN tracker state is retained because uncertainty is not permission.
 */
export function planLivenessReclaim(
  inputs: readonly LivenessReclaimInput[],
  nowS: number,
): LivenessReclaimAction[] {
  const out: LivenessReclaimAction[] = [];
  for (const i of inputs) {
    if (i.liveness !== "dead") continue;
    if (i.issueState === "CLOSED") {
      out.push({
        attemptDir: i.attemptDir,
        worktreePath: i.worktreePath,
        removeWorktree: true,
        reclaimDir: true,
        writeTombstone: false,
      });
      continue;
    }
    if (i.issueState === "UNKNOWN") continue;
    if (i.issueState === "OPEN") {
      const ageS = nowS - i.mtimeS;
      if (ageS < DEAD_WORKER_WORKTREE_TTL_S) continue;
      out.push({
        attemptDir: i.attemptDir,
        worktreePath: i.worktreePath,
        removeWorktree: true,
        reclaimDir: ageS >= DEAD_WORKER_DIR_TTL_S,
        writeTombstone: ageS < DEAD_WORKER_DIR_TTL_S,
      });
    }
  }
  return out;
}
