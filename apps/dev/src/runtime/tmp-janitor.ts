import { readdir, rm, stat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  isLegacySlotLogName,
  planTmpJanitor,
  planWorkerDirJanitor,
  parseFeedbackWorktreeWorkerSlug,
  planOrphanFeedbackWorktreeSweep,
  type JanitorEntry,
  type OrphanFeedbackEntry,
  type OrphanFeedbackSweepPlan,
  type TmpJanitorPlan,
  type WorkerDirJanitorEntry,
} from "../core/tmp-janitor.js";
import { allWorkersRoots, parseReapableWorkerPath } from "../core/worker-paths.js";

export type IssueStateLookup = (issue: number) => "OPEN" | "CLOSED" | "UNKNOWN";

export interface TmpJanitorReport {
  plan: TmpJanitorPlan;
  staleWorkers: ReturnType<typeof planWorkerDirJanitor>;
  /** Orphaned feedback worktrees whose owning worker is dead (or the shared
   * baseline worktree when no workers are alive). Swept independently of the
   * mtime TTL sweep so dead-owner entries age out immediately. */
  orphanFeedback: OrphanFeedbackSweepPlan;
}

export interface TmpJanitorApplyResult {
  expiredLanes: string[];
  staleWorkers: string[];
  unknownTmpRoots: string[];
  protectedLiveWorkers: string[];
  /** Orphaned feedback worktrees that were removed. */
  orphanFeedback: string[];
}

export interface TmpJanitorRunResult extends TmpJanitorReport {
  applied?: TmpJanitorApplyResult;
}

async function listNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function listEntries(path: string): Promise<JanitorEntry[]> {
  const names = await listNames(path);
  const entries: JanitorEntry[] = [];
  for (const name of names) {
    const entry = join(path, name);
    try {
      const st = await stat(entry);
      entries.push({ path: entry, mtimeS: Math.floor(st.mtimeMs / 1000) });
    } catch {
      // Raced away; leave it for the next sweep.
    }
  }
  return entries;
}

function pidAlive(raw: string | null): boolean {
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return false;
  try {
    process.kill(Number(trimmed), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function collectWorkerEntries(tmpDir: string, lookup: IssueStateLookup): Promise<WorkerDirJanitorEntry[]> {
  const out: WorkerDirJanitorEntry[] = [];
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    const workers = await listNames(workersRoot);
    for (const worker of workers) {
      const workerPath = join(workersRoot, worker);
      try {
        const st = await stat(workerPath);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      const workerPidLive = pidAlive(await readText(join(workerPath, "worker.pid")));
      const issues = new Map<number, "OPEN" | "CLOSED" | "UNKNOWN">();
      for (const child of await listNames(workerPath)) {
        const childPath = join(workerPath, child);
        try {
          const st = await stat(childPath);
          if (!st.isDirectory()) continue;
        } catch {
          continue;
        }
        // Hygiene parser: legacy -a{n} dirs must stay janitorable (ADR 0103 #2170).
        const parsed = parseReapableWorkerPath(childPath);
        if (!parsed) continue;
        issues.set(parsed.issue, lookup(parsed.issue));
      }
      out.push({
        path: workerPath,
        workerPidLive,
        issues: [...issues].map(([issue, state]) => ({ issue, state })),
      });
    }
  }
  return out;
}

/**
 * Build the live-worker PID index: a map from worker ID to liveness so the
 * orphan feedback sweep can decide per-entry without re-reading PID files.
 * Returns null when any worker is alive (signals that the shared baseline
 * worktree is in use and must be spared).
 */
async function buildWorkerLivenessIndex(tmpDir: string): Promise<{ liveWorkers: Set<string>; anyAlive: boolean }> {
  const liveWorkers = new Set<string>();
  let anyAlive = false;
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    for (const workerDir of await listNames(workersRoot)) {
      const pidFile = join(workersRoot, workerDir, "worker.pid");
      if (pidAlive(await readText(pidFile))) {
        liveWorkers.add(workerDir);
        anyAlive = true;
      }
    }
  }
  return { liveWorkers, anyAlive };
}

async function collectOrphanFeedbackEntries(tmpDir: string): Promise<{
  entries: OrphanFeedbackEntry[];
  anyWorkerAlive: boolean;
}> {
  const feedbackDir = join(tmpDir, "worktrees", "feedback");
  const names = await listNames(feedbackDir);
  const { liveWorkers, anyAlive } = await buildWorkerLivenessIndex(tmpDir);
  const entries: OrphanFeedbackEntry[] = [];
  for (const name of names) {
    const path = join(feedbackDir, name);
    let mtimeS = 0;
    try {
      const st = await stat(path);
      mtimeS = Math.floor(st.mtimeMs / 1000);
    } catch {
      continue; // raced away
    }
    const workerSlug = parseFeedbackWorktreeWorkerSlug(name);
    let ownerAlive: boolean | null;
    if (workerSlug !== null) {
      ownerAlive = liveWorkers.has(workerSlug);
    } else {
      // Non-afk entry (e.g. 'main'): liveness is inferred from anyAlive
      ownerAlive = null;
    }
    entries.push({ path, basename: name, mtimeS, ownerAlive });
  }
  return { entries, anyWorkerAlive: anyAlive };
}

export async function collectTmpJanitorReport(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
): Promise<TmpJanitorReport> {
  const [tmpRootNames, tmpRootEntries, logEntries, scratchEntries, diagnosticsEntries, feedbackEntries, workers, orphanFeedbackData] =
    await Promise.all([
      listNames(tmpDir),
      listEntries(tmpDir),
      listEntries(join(tmpDir, "logs")),
      listEntries(join(tmpDir, "scratch")),
      listEntries(join(tmpDir, "diagnostics")),
      listEntries(join(tmpDir, "worktrees", "feedback")),
      collectWorkerEntries(tmpDir, lookup),
      collectOrphanFeedbackEntries(tmpDir),
    ]);
  const legacySlotLogEntries = tmpRootEntries.filter((entry) => isLegacySlotLogName(basename(entry.path)));

  return {
    plan: planTmpJanitor({
      nowS,
      logEntries,
      scratchEntries,
      diagnosticsEntries,
      feedbackEntries,
      legacySlotLogEntries,
      tmpRootNames,
    }),
    staleWorkers: planWorkerDirJanitor(workers),
    orphanFeedback: planOrphanFeedbackWorktreeSweep(orphanFeedbackData.entries, orphanFeedbackData.anyWorkerAlive),
  };
}

export async function applyTmpJanitorReport(
  tmpDir: string,
  report: TmpJanitorReport,
  options: { worktreePrune?: () => Promise<void> } = {},
): Promise<TmpJanitorApplyResult> {
  const expired = [
    ...report.plan.logs.reclaim,
    ...report.plan.scratch.reclaim,
    ...report.plan.diagnostics.reclaim,
    ...report.plan.feedbackWorktrees.reclaim,
    ...report.plan.legacySlotLogs.reclaim,
  ];
  const result: TmpJanitorApplyResult = {
    expiredLanes: [],
    staleWorkers: [],
    unknownTmpRoots: [],
    protectedLiveWorkers: [],
    orphanFeedback: [],
  };

  for (const entry of expired) {
    await rm(entry.path, { recursive: true, force: true });
    result.expiredLanes.push(entry.path);
  }

  for (const worker of report.staleWorkers.reclaim) {
    if (pidAlive(await readText(join(worker.path, "worker.pid")))) {
      result.protectedLiveWorkers.push(worker.path);
      continue;
    }
    await rm(worker.path, { recursive: true, force: true });
    result.staleWorkers.push(worker.path);
  }

  for (const name of report.plan.unknownTmpRoots) {
    const path = join(tmpDir, name);
    await rm(path, { recursive: true, force: true });
    result.unknownTmpRoots.push(path);
  }

  for (const entry of report.orphanFeedback.reclaim) {
    await rm(entry.path, { recursive: true, force: true });
    result.orphanFeedback.push(entry.path);
  }

  // After removing orphaned feedback worktrees, ask git to prune its own
  // internal registry so stale worktree entries do not accumulate there either.
  if (result.orphanFeedback.length > 0 && options.worktreePrune) {
    await options.worktreePrune().catch(() => {});
  }

  return result;
}

export async function runTmpJanitor(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
  options: { fix?: boolean; worktreePrune?: () => Promise<void> } = {},
): Promise<TmpJanitorRunResult> {
  const report = await collectTmpJanitorReport(tmpDir, nowS, lookup);
  if (!options.fix) return report;
  return { ...report, applied: await applyTmpJanitorReport(tmpDir, report, options) };
}
