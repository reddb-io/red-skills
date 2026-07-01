// runtime/supervisor-fs.ts — real filesystem backing for the native fleet
// supervisor's SupervisorFs surface.
//
// Mirrors the slot→worker→iter-dir resolution chain in supervisor.sh:
//   parse_worker_ids_from_log  (slot log → worker IDs)
//   find_slot_iter_dir         (slot pid → worker dir → newest attempt dir)
//   find_slot_agent_lane       (iter dir → agent.log.jsonl mtime)
//   iter_dirs_for_worker       (worker dir → every attempt dir)
//   iter_dir_issue_number      (afk.state.json → .current.number)
//   reap_stalled_slot reads    (notes, afk.log tail, duration)
//
// Every export is BEST-EFFORT: a failed read / stat / glob degrades to the safe
// value (mtime 0, null iter dir, empty sweep work) and never throws out of a
// SupervisorFs closure — the bash `|| true` cleanups.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IterDirInfo, SweepWork, SweepWorker } from "../core/supervisor.js";
import { parseWorkerAttemptPath, workerDir } from "../core/worker-paths.js";
import { readWorkerState } from "../core/worker-state-reader.js";

/** Absolute path of a slot's per-worker stdout/stderr log
 * (`afk-supervisor-slot-{slot}.log`). Mirrors spawn_slot's slot_log. */
export function slotLogPath(tmpDir: string, slot: number): string {
  return join(tmpDir, `afk-supervisor-slot-${slot}.log`);
}

/**
 * Parse each unique worker ID (`wXXXX`) from a slot log's boot-stamp lines,
 * first-seen order preserved. Mirrors parse_worker_ids_from_log's awk over
 * `[afk] worker: wXXXX` lines. A missing / unreadable file → [].
 */
export function parseWorkerIdsFromLog(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\[afk\] worker: (w[A-Z0-9]+)$/);
    if (!m) continue;
    const wid = m[1]!;
    if (!seen.has(wid)) {
      seen.add(wid);
      out.push(wid);
    }
  }
  return out;
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

/** `.current.number` from a dir's afk.state.json, or null. Mirrors
 * iter_dir_issue_number. Reads through the single owner
 * (core/worker-state-reader) so the schema + legacy-key shim apply — no private
 * JSON.parse. */
export function iterDirIssueNumber(dir: string): number | null {
  const rec = readWorkerState(join(dir, "afk.state.json"));
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
 * agentLaneMtime backing: resolve the slot's live worker via the slot log, then
 * its current attempt's agent.log.jsonl mtime in whole seconds; 0 when absent.
 * Mirrors find_slot_agent_lane + the `stat -c %Y` read. The slot's live pid is
 * the bridge from log-parsed worker IDs to the running worker.pid match — but
 * since the supervisor already holds the slot pid, we resolve the iter dir
 * directly from it (find_slot_iter_dir), which is exactly what bash does. The
 * slot-log parse is retained for sweep work; here pid resolution is enough.
 */
export function agentLaneMtimeFor(tmpDir: string, slotPid: number | null): number {
  const dir = findSlotIterDir(tmpDir, slotPid);
  if (dir === null) return 0;
  try {
    return Math.floor(statSync(join(dir, "agent.log.jsonl")).mtimeMs / 1000);
  } catch {
    return 0;
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

/**
 * resolveIterDir backing: the slot's current iteration + the envelope material
 * reap_stalled_slot pulls from afk.state.json (issue, worker_id, started_at →
 * duration), handoff.md (notes), and afk.log (log tail). Returns null when no
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
  // Single owner (core/worker-state-reader): null when the dir has no/malformed
  // state, in which case issue/worker stay empty and teardown still proceeds.
  const rec = readWorkerState(join(dir, "afk.state.json"));
  if (rec !== null) {
    const n = rec.state.current.number;
    if (typeof n === "number" && Number.isInteger(n)) issue = n;
    workerId = rec.state.worker_id;
    startedAt = rec.state.started_at;
  }

  let durationS = 0;
  if (startedAt.length > 0) {
    const startedEpoch = Math.floor(Date.parse(startedAt) / 1000);
    if (Number.isFinite(startedEpoch) && startedEpoch > 0 && now > startedEpoch) {
      durationS = now - startedEpoch;
    }
  }

  const notes = tailFile(join(dir, "handoff.md"), 200);
  const logTail = tailFile(join(dir, "afk.log"), 50);

  // Real attempt number from the `<issue>-a<N>` iter dir, for the bounded stalled
  // re-claim cap (#402). Degrades to attempt 1 when the path is non-canonical.
  const attempt = parseWorkerAttemptPath(dir)?.attempt ?? 1;

  return { path: dir, issue, workerId, logTail, notes, durationS, attempt };
}

/**
 * parkedSlotWork backing: resolve every worker that occupied a parked slot and
 * the claimed issues they held. Mirrors the sweep_parked_slot collection.
 *
 * Two resolution paths, tried in order:
 *   1. Slot log: parse `[afk] worker: wXXXX` boot-stamp lines from the
 *      per-slot log file.  Each worker emits this stamp to stdout immediately
 *      after generating its worker ID (before any I/O that could fail); the
 *      supervisor routes the child's stdout/stderr to the slot log so the stamp
 *      is captured even when the worker fast-dies before writing worker.pid.
 *      This is the primary path for the native fleet.
 *   2. PID fallback (lastPid): when the log yields no workers (e.g. a slot log
 *      that predates the stamp or was rotated), resolve the slot's last worker
 *      via its `worker.pid` file (findSlotIterDir).
 *
 * Empty workers list when neither path finds a worker → no-op sweep upstream.
 */
export function parkedSlotWorkFor(
  tmpDir: string,
  slot: number,
  lastPid: number | null = null,
): SweepWork {
  const supervisorLogPath = join(tmpDir, "afk-supervisor.log");

  // Path 1: slot log boot-stamp parse.
  const wids = parseWorkerIdsFromLog(slotLogPath(tmpDir, slot));
  if (wids.length > 0) {
    const workers: SweepWorker[] = wids.map((wid) => ({
      workerId: wid,
      pairs: iterDirsForWorker(tmpDir, wid).map((dir) => ({
        dir,
        issue: iterDirIssueNumber(dir),
      })),
    }));
    return { workers, supervisorLogPath };
  }

  // Path 2: PID-based fallback — resolve the last worker via worker.pid match.
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
  const worktree = join(info.path, "worktree");
  if (existsSync(worktree)) {
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
