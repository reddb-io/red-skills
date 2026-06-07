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
 * iter_dir_issue_number. */
export function iterDirIssueNumber(dir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "afk.state.json"), "utf8")) as {
      current?: { number?: unknown };
    };
    const n = parsed.current?.number;
    return typeof n === "number" && Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
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
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "afk.state.json"), "utf8")) as {
      current?: { number?: unknown };
      worker_id?: unknown;
      started_at?: unknown;
    };
    const n = parsed.current?.number;
    if (typeof n === "number" && Number.isInteger(n)) issue = n;
    if (typeof parsed.worker_id === "string") workerId = parsed.worker_id;
    if (typeof parsed.started_at === "string") startedAt = parsed.started_at;
  } catch {
    // no state → no issue/worker; teardown still proceeds on the dir
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
 * parkedSlotWork backing: every worker ID seen in the slot log → its iter dirs
 * → each dir's claimed issue. Mirrors the sweep_parked_slot collection. Empty
 * workers list when the slot log named none (no-op sweep upstream).
 */
export function parkedSlotWorkFor(
  tmpDir: string,
  root: string,
  slot: number,
  fastDeaths: number,
): SweepWork {
  const supervisorLogPath = join(tmpDir, "afk-supervisor.log");
  const wids = parseWorkerIdsFromLog(slotLogPath(tmpDir, slot));
  const workers: SweepWorker[] = wids.map((wid) => ({
    workerId: wid,
    pairs: iterDirsForWorker(root, wid).map((dir) => ({
      dir,
      issue: iterDirIssueNumber(dir),
    })),
  }));
  return { workers, fastDeaths, supervisorLogPath };
}

/** Best-effort worktree teardown + iter-dir removal for a reaped slot. Mirrors
 * reap_stalled_slot step 4 (git worktree remove + rm -rf). */
export async function teardownIterDirNative(info: IterDirInfo, root: string): Promise<void> {
  const fsp = await import("node:fs/promises");
  const worktree = join(info.path, "worktree");
  if (existsSync(worktree)) {
    try {
      const { git } = await import("./exec.js");
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
