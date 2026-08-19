// runtime/supervisor-fs.ts — real filesystem backing for the native fleet
// supervisor's SupervisorFs surface.
//
// Mirrors the slot→worker→iter-dir resolution chain in supervisor.sh:
//   find_slot_iter_dir         (slot pid → worker dir → newest attempt dir)
//   workerLivenessFor          (iter dir → liveness lane → evaluator verdict)
//   iter_dirs_for_worker       (worker dir → every attempt dir)
//   iter_dir_issue_number      (afk.state.toon → .current.number)
//   reap_stalled_slot reads    (notes, worker.log.toonl tail, duration)
//
// Every export is BEST-EFFORT: a failed read / stat / glob degrades to the safe
// value (null verdict, null iter dir, empty sweep work) and never throws out of
// a SupervisorFs closure — the bash `|| true` cleanups.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { buildRef } from "../core/remote-branch.js";
import {
  parseReapableWorkerWorktreePath,
  parseWorkerAttemptPath,
  workerDir,
} from "../core/worker-paths.js";
import { readWorkerState } from "../core/worker-state-reader.js";
import { workerStatePath } from "../core/state.js";
import {
  evaluateLiveness,
  resolveLivenessCrossCheckArming,
  createProcessDescendantProbe,
  parseLivenessRecords,
  LIVENESS_LANE_FILENAME,
  type LivenessVerdict,
} from "@reddb-io/worker";

/**
 * The slot's current iteration, resolved from the filesystem.
 *
 * **Declared here now that the supervisor state machine is gone** (ADR 0148):
 * the shape used to live in `core/supervisor/types.ts` beside the tick that
 * consumed it, and that tick was the project-side control half the daemon took
 * over. What survives is the READ — a reaper, a doctor and a monitor still ask
 * this module what a worker directory holds — so the shape belongs to the reader
 * rather than to the loop that no longer runs.
 */
export interface IterDirInfo {
  path: string;
  /** .current.number, or null when the worker died before claiming. */
  issue: number | null;
  workerId: string;
  /** Live attempt branch (`afk/{worker}/{issue}-{slug}`), when recoverable. */
  branch?: string;
  /** Tail of afk.log for the no-sentinel envelope's log section. */
  logTail: string;
  /** Extracted agent notes for the envelope's notes section, if any. */
  notes: string;
  /** Worker lifetime in seconds for the envelope duration, or 0 when unknown. */
  durationS: number;
  /** Real attempt number for this iteration, parsed from the `<issue>-a{n}` iter
   * dir, or 1 when it cannot be derived. */
  attempt: number;
  /** Reported spend for this attempt (WorkerVitals `current.cost_usd`), when the
   * runner reports cost. Undefined means unmeasured, not zero. */
  costUsd?: number;
}

/** One worker's claimed iter dirs for the trip sweep. */
export interface SweepWorker {
  workerId: string;
  /** (iterDir, issue) pairs; issue is null when the worker died pre-claim. */
  pairs: { dir: string; issue: number | null }[];
}

/** The worker IDs + claimed work that occupied a parked slot. */
export interface SweepWork {
  workers: SweepWorker[];
  /** Log path quoted in the discard envelope body. */
  supervisorLogPath: string;
}

/** Every attempt dir (`workers/{wid}/{issue}-a{n}`) for a worker, absolute
 * paths. Mirrors iter_dirs_for_worker. Missing worker dir → []. */
export function iterDirsForWorker(root: string, wid: string): string[] {
  const wdir = workerDir(root, wid);
  let entries: string[];
  try {
    entries = readdirSync(wdir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const dir = join(wdir, entry);
    try {
      if (statSync(dir).isDirectory()) out.push(dir);
    } catch {
      // raced away — skip
    }
  }
  return out;
}

/** Sum `current.cost_usd` from the current AFK worker state files. This is the
 * supervisor's per-drain spend signal and deliberately reads the existing
 * WorkerVitals field rather than maintaining a parallel ledger. */
export function sumWorkerCostUsd(tmpDir: string): number {
  const workersRoot = join(tmpDir, "workers");
  let workerDirs: string[];
  try {
    workerDirs = readdirSync(workersRoot);
  } catch {
    return 0;
  }
  let total = 0;
  for (const wid of workerDirs) {
    const wdir = join(workersRoot, wid);
    let attempts: string[];
    try {
      attempts = readdirSync(wdir);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      const rec = readWorkerState(workerStatePath(join(wdir, attempt)));
      if (rec === null) continue;
      const cost = rec.state.current.cost_usd;
      if (Number.isFinite(cost) && cost > 0) total += cost;
    }
  }
  return total;
}

/** `.current.number` from a dir's afk.state.toon, or null. Mirrors
 * iter_dir_issue_number. Reads through the single owner
 * (core/worker-state-reader) so the schema + legacy-key shim apply — no private
 * JSON.parse. */
export function iterDirIssueNumber(dir: string): number | null {
  const rec = readWorkerState(workerStatePath(dir));
  const n = rec?.state.current.number;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

/**
 * Resolve the slot's CURRENT iter dir from the slot's live worker pid: find the
 * `workers/{wid}/worker.pid` whose contents equal `slotPid`, then its newest
 * attempt dir (by mtime). Mirrors find_slot_iter_dir. Returns null when the
 * worker is between iterations / no pid match.
 */
export function findSlotIterDir(tmpDir: string, slotPid: number | null): string | null {
  if (slotPid === null || !Number.isInteger(slotPid) || slotPid <= 0) return null;
  const workersRoot = join(tmpDir, "workers");
  let workerDirs: string[];
  try {
    workerDirs = readdirSync(workersRoot);
  } catch {
    return null;
  }
  for (const wid of workerDirs) {
    const wdir = join(workersRoot, wid);
    let pidText: string;
    try {
      pidText = readFileSync(join(wdir, "worker.pid"), "utf8").trim();
    } catch {
      continue;
    }
    if (Number(pidText) !== slotPid) continue;
    // newest attempt dir under this worker
    let entries: string[];
    try {
      entries = readdirSync(wdir);
    } catch {
      return null;
    }
    let newest: string | null = null;
    let newestMtime = -1;
    for (const entry of entries) {
      const dir = join(wdir, entry);
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
        const m = st.mtimeMs;
        if (m > newestMtime) {
          newestMtime = m;
          newest = dir;
        }
      } catch {
        // skip
      }
    }
    return newest;
  }
  return null;
}

/**
 * workerLivenessVerdict backing: resolve the slot's iter dir, read the liveness
 * lane (ADR 0083 §3), and evaluate via the red-castle evaluator. Returns null
 * when the iter dir cannot be resolved (worker between iterations or pre-claim).
 * Best-effort: any read/parse failure degrades to null.
 */
export function workerLivenessFor(
  tmpDir: string,
  slotPid: number | null,
  laneIdleMs: number,
  laneHardIdleMs?: number,
  issueWallClockMaxMs?: number,
): LivenessVerdict | null {
  const dir = findSlotIterDir(tmpDir, slotPid);
  if (dir === null) return null;

  // Read liveness lane synchronously (mirrors readLivenessRecencySync in worker-state-reader).
  let laneRecencyMs: number | undefined;
  try {
    const raw = readFileSync(join(dir, LIVENESS_LANE_FILENAME), "utf-8");
    const records = parseLivenessRecords(raw);
    if (records.length > 0) {
      laneRecencyMs = records.reduce((max, r) => (r.at > max ? r.at : max), records[0]!.at);
    }
  } catch {
    // absent or unreadable → undefined (lane never written or raced away)
  }

  // Cross-check: armed for local (no-sandbox) workers — container workers use a
  // different execution path and are not managed by the fleet supervisor.
  const { crossCheckArmed } = resolveLivenessCrossCheckArming({ sandboxTag: "none" });

  // Worker pid from the state file for the descendant probe, plus the attempt's
  // claim epoch for the wall-clock ceiling (#2286). `current.started_at` is the
  // attempt's own claim stamp; `started_at` is the worker-level fallback. An
  // unparseable/absent stamp leaves the epoch undefined, which disables the
  // ceiling rather than guessing an age.
  let agentPid = 0;
  let issueClaimedAtMs: number | undefined;
  try {
    const rec = readWorkerState(workerStatePath(dir));
    if (rec !== null) {
      agentPid = rec.state.pid;
      const raw = rec.state.current.started_at || rec.state.started_at;
      const parsed = raw ? Date.parse(raw) : Number.NaN;
      if (!Number.isNaN(parsed)) issueClaimedAtMs = parsed;
    }
  } catch {
    // best-effort
  }

  const hasLiveDescendants =
    crossCheckArmed && agentPid > 0
      ? createProcessDescendantProbe({ agentPid })
      : undefined;

  try {
    return evaluateLiveness({
      laneRecencyMs,
      now: Date.now(),
      laneIdleMs,
      laneHardIdleMs,
      issueClaimedAtMs,
      issueWallClockMaxMs,
      crossCheckArmed,
      hasLiveDescendants,
    });
  } catch {
    return null;
  }
}

/** Tail of the last `n` lines of a file, or "" when absent. */
function tailFile(path: string, n: number): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  // drop a single trailing empty line from a final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

function tailWorkerLog(path: string, n: number): string {
  try {
    const messages = parseRecords(readFileSync(path, "utf8"))
      .map((record) => record.msg)
      .filter((message): message is string => typeof message === "string");
    return messages.slice(-n).join("\n");
  } catch {
    return tailFile(path, n);
  }
}

/**
 * resolveIterDir backing: the slot's current iteration + the envelope material
 * reap_stalled_slot pulls from afk.state.toon (issue, worker_id, started_at →
 * duration), handoff.md (notes), and worker.log.toonl (log tail). Returns null when no
 * iter dir resolves. Best-effort: missing pieces degrade to empty / 0.
 */
export function resolveIterDirInfo(
  tmpDir: string,
  slotPid: number | null,
  now: number,
): IterDirInfo | null {
  const dir = findSlotIterDir(tmpDir, slotPid);
  if (dir === null) return null;

  let issue: number | null = null;
  let workerId = "";
  let startedAt = "";
  let branch: string | undefined;
  let costUsd: number | undefined;
  // Single owner (core/worker-state-reader): null when the dir has no/malformed
  // state, in which case issue/worker stay empty and teardown still proceeds.
  const rec = readWorkerState(workerStatePath(dir));
  if (rec !== null) {
    const n = rec.state.current.number;
    if (typeof n === "number" && Number.isInteger(n)) issue = n;
    workerId = rec.state.worker_id;
    startedAt = rec.state.started_at;
    // Reported spend for THIS attempt, read from the same WorkerVitals lane the
    // drain budget sums (`current.cost_usd`) — never a parallel accounting
    // channel. 0 stays undefined: unreported cost is not measured zero.
    const cost = rec.state.current.cost_usd;
    if (Number.isFinite(cost) && cost > 0) costUsd = cost;
    if (issue !== null && workerId.length > 0) {
      branch = buildRef("afk", workerId, issue, rec.state.current.title) ?? undefined;
    }
  }

  let durationS = 0;
  if (startedAt.length > 0) {
    const startedEpoch = Math.floor(Date.parse(startedAt) / 1000);
    if (Number.isFinite(startedEpoch) && startedEpoch > 0 && now > startedEpoch) {
      durationS = now - startedEpoch;
    }
  }

  const notes = tailFile(join(dir, "handoff.md"), 200);
  const logTail = tailWorkerLog(join(dirname(dir), "worker.log.toonl"), 50);

  // Real attempt number from the `<issue>-a<N>` iter dir, for the bounded stalled
  // re-claim cap (#402). Degrades to attempt 1 when the path is non-canonical.
  const attempt = parseWorkerAttemptPath(dir)?.attempt ?? 1;

  return {
    path: dir,
    issue,
    workerId,
    branch,
    logTail,
    notes,
    durationS,
    attempt,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * parkedSlotWork backing: resolve every worker that occupied a parked slot and
 * the claimed issues they held. Mirrors the sweep_parked_slot collection.
 *
 * Resolution is by PID: the slot's last worker is the one whose `worker.pid`
 * matches (findSlotIterDir), and its attempt dirs carry the issues it claimed.
 *
 * **The slot-log boot-stamp path is gone with the lane it read** (#3440). It
 * parsed `[afk] worker: wXXXX` out of `.red/tmp/logs/<yyyy-mm-dd>/`, a lane
 * whose writer was the shell supervisor's `spawn_slot` — and since ADR 0130 the
 * daemon owns birth and every Worker's output is TOONL in
 * `.red/tmp/workers/{id}/worker.log.toonl`. The parse had been reading a file
 * nothing had written since, so it resolved nothing and fell through to the PID
 * path on every call.
 *
 * Empty workers list when the PID resolves nothing → no-op sweep upstream.
 */
export function parkedSlotWorkFor(
  tmpDir: string,
  slot: number,
  lastPid: number | null = null,
  // The main supervisor firehose lives in the singleton tmp supervisor lane.
  supervisorLogPath: string = join(tmpDir, "supervisors", "default", "supervisor.log.toonl"),
): SweepWork {
  const iterDir = findSlotIterDir(tmpDir, lastPid);
  if (iterDir === null) return { workers: [], supervisorLogPath };

  const parsed = parseWorkerAttemptPath(iterDir);
  if (parsed === null) return { workers: [], supervisorLogPath };

  const pairs = iterDirsForWorker(tmpDir, parsed.worker).map((dir) => ({
    dir,
    issue: iterDirIssueNumber(dir),
  }));
  return {
    workers: [{ workerId: parsed.worker, pairs }],
    supervisorLogPath,
  };
}

/**
 * HYGIENE-ONLY worktree resolver for a worker workspace. New workers use the
 * conventional direct child; the nested castle layout remains discoverable so
 * a mixed live fleet can still be reaped during the rollout window.
 */
export function reapableWorktreeUnder(workerWorkspace: string): string | null {
  const direct = join(workerWorkspace, "worktree");
  if (
    parseReapableWorkerWorktreePath(direct) !== null &&
    existsSync(join(direct, ".git"))
  ) {
    return direct;
  }

  const legacyRoot = join(workerWorkspace, ".red-castle", "worktrees");
  let entries: string[];
  try {
    entries = readdirSync(legacyRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(legacyRoot, entry);
    if (
      parseReapableWorkerWorktreePath(candidate) !== null &&
      existsSync(join(candidate, ".git"))
    ) {
      return candidate;
    }
  }
  return null;
}

/** Best-effort worktree teardown + iter-dir removal for a reaped slot. Mirrors
 * reap_stalled_slot step 4 (git worktree remove + rm -rf).
 *
 * Safety push: before destroying the worktree, push any local-only commits to
 * origin. A stalled/crashed/merge-conflict worker may hold commits that the
 * continuous-push hook never delivered (silent push failure). The commits must
 * reach the remote before the worktree directory is removed — the branch ref in
 * .git survives the dir removal but the reconcile path cannot use it if the
 * remote branch has zero diff vs base. Best-effort: a failed safety push logs
 * visibly to stderr but never blocks the teardown. */
export async function teardownIterDirNative(info: IterDirInfo, root: string): Promise<void> {
  const fsp = await import("node:fs/promises");
  const worktree = reapableWorktreeUnder(info.path);
  if (worktree !== null) {
    try {
      const { git } = await import("./exec.js");

      // --- safety push (never blocks teardown) ---
      const branchRes = await git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
      if (branch && branch !== "HEAD" && branch.startsWith("afk/")) {
        const countRes = await git([
          "-C", worktree,
          "rev-list", "--count", `origin/${branch}..${branch}`,
        ]);
        const unpushed = countRes.code === 0 ? parseInt(countRes.stdout.trim(), 10) : NaN;
        if (!Number.isNaN(unpushed) && unpushed > 0) {
          const pushRes = await git([
            "-C", worktree,
            "push", "--force", "origin", `HEAD:refs/heads/${branch}`,
          ]);
          if (pushRes.code !== 0) {
            process.stderr.write(
              `[afk teardown] WARN: ${unpushed} commit(s) on ${branch} could not be pushed — ` +
                `they survive in the local branch ref until a manual push or git gc.\n` +
                `  push stderr: ${pushRes.stderr.trim()}\n`,
            );
          }
        }
      }
      // --- end safety push ---

      await git(["-C", root, "worktree", "remove", "--force", worktree]);
    } catch {
      // best-effort
    }
  }
  try {
    await fsp.rm(info.path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
