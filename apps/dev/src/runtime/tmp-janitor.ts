import { readdir, rm, stat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  isLegacySlotLogName,
  parseFeedbackWorktreeWorker,
  FEEDBACK_MAIN_SLUG,
  planTmpJanitor,
  planWorkerDirJanitor,
  type FeedbackWorktreeDeadOwnerEntry,
  type JanitorEntry,
  type TmpJanitorPlan,
  type WorkerDirJanitorEntry,
} from "../core/tmp-janitor.js";
import { allWorkersRoots, parseReapableWorkerPath } from "../core/worker-paths.js";

export type IssueStateLookup = (issue: number) => "OPEN" | "CLOSED" | "UNKNOWN";

export interface TmpJanitorReport {
  plan: TmpJanitorPlan;
  staleWorkers: ReturnType<typeof planWorkerDirJanitor>;
}

export interface TmpJanitorApplyResult {
  expiredLanes: string[];
  /** Dead-owner feedback worktrees removed in this sweep (#2379). */
  deadOwnerFeedback: string[];
  staleWorkers: string[];
  unknownTmpRoots: string[];
  protectedLiveWorkers: string[];
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

async function collectFeedbackDeadOwnerEntries(
  feedbackDir: string,
  tmpDir: string,
): Promise<FeedbackWorktreeDeadOwnerEntry[]> {
  const names = await listNames(feedbackDir);
  // Build the set of live worker IDs across all worker roots (read once).
  const liveWorkerIds = new Set<string>();
  let anyWorkerLive = false;
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    for (const workerId of await listNames(workersRoot)) {
      const pidText = await readText(join(workersRoot, workerId, "worker.pid"));
      if (pidAlive(pidText)) {
        liveWorkerIds.add(workerId);
        anyWorkerLive = true;
      }
    }
  }

  return names.map((name) => {
    const workerIdTag = parseFeedbackWorktreeWorker(name);
    const isBaselineMain = name === FEEDBACK_MAIN_SLUG;
    // afk-<workerId>-* entries: live iff that specific worker is live.
    // baseline main and other non-afk entries: live iff any worker is live.
    const workerLive = workerIdTag !== null ? liveWorkerIds.has(workerIdTag) : (isBaselineMain ? anyWorkerLive : anyWorkerLive);
    return {
      path: join(feedbackDir, name),
      basename: name,
      workerIdTag,
      workerLive,
    };
  });
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

export async function collectTmpJanitorReport(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
): Promise<TmpJanitorReport> {
  const feedbackDir = join(tmpDir, "worktrees", "feedback");
  const [tmpRootNames, tmpRootEntries, logEntries, scratchEntries, diagnosticsEntries, feedbackEntries, feedbackDeadOwnerEntries, workers] =
    await Promise.all([
      listNames(tmpDir),
      listEntries(tmpDir),
      listEntries(join(tmpDir, "logs")),
      listEntries(join(tmpDir, "scratch")),
      listEntries(join(tmpDir, "diagnostics")),
      listEntries(feedbackDir),
      collectFeedbackDeadOwnerEntries(feedbackDir, tmpDir),
      collectWorkerEntries(tmpDir, lookup),
    ]);
  const legacySlotLogEntries = tmpRootEntries.filter((entry) => isLegacySlotLogName(basename(entry.path)));

  return {
    plan: planTmpJanitor({
      nowS,
      logEntries,
      scratchEntries,
      diagnosticsEntries,
      feedbackEntries,
      feedbackDeadOwnerEntries,
      legacySlotLogEntries,
      tmpRootNames,
    }),
    staleWorkers: planWorkerDirJanitor(workers),
  };
}

export async function applyTmpJanitorReport(
  tmpDir: string,
  report: TmpJanitorReport,
  opts?: { worktreePrune?: () => Promise<void> },
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
    deadOwnerFeedback: [],
    staleWorkers: [],
    unknownTmpRoots: [],
    protectedLiveWorkers: [],
  };

  for (const entry of expired) {
    await rm(entry.path, { recursive: true, force: true });
    result.expiredLanes.push(entry.path);
  }

  // Dead-owner feedback worktrees (#2379): remove before pruning git's tracking.
  for (const entry of report.plan.feedbackDeadOwner.reclaim) {
    await rm(entry.path, { recursive: true, force: true });
    result.deadOwnerFeedback.push(entry.path);
  }

  // Prune git's linked-worktree tracking after removing dirs so subsequent
  // worktree-add calls don't see stale registrations (#2379).
  if (result.deadOwnerFeedback.length > 0 || result.expiredLanes.length > 0) {
    await opts?.worktreePrune?.();
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

  return result;
}

export async function runTmpJanitor(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
  options: { fix?: boolean } = {},
): Promise<TmpJanitorRunResult> {
  const report = await collectTmpJanitorReport(tmpDir, nowS, lookup);
  if (!options.fix) return report;
  return { ...report, applied: await applyTmpJanitorReport(tmpDir, report) };
}
