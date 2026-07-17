import { readdir, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  planTmpJanitor,
  planWorkerDirJanitor,
  type JanitorEntry,
  type TmpJanitorPlan,
  type WorkerDirJanitorEntry,
} from "../core/tmp-janitor.js";
import { allWorkersRoots, parseWorkerAttemptPath } from "../core/worker-paths.js";

export type IssueStateLookup = (issue: number) => "OPEN" | "CLOSED" | "UNKNOWN";

export interface TmpJanitorReport {
  plan: TmpJanitorPlan;
  staleWorkers: ReturnType<typeof planWorkerDirJanitor>;
}

export interface TmpJanitorApplyResult {
  expiredLanes: string[];
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
        const parsed = parseWorkerAttemptPath(childPath);
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
  const [tmpRootNames, logEntries, scratchEntries, diagnosticsEntries, feedbackEntries, workers] =
    await Promise.all([
      listNames(tmpDir),
      listEntries(join(tmpDir, "logs")),
      listEntries(join(tmpDir, "scratch")),
      listEntries(join(tmpDir, "diagnostics")),
      listEntries(join(tmpDir, "worktrees", "feedback")),
      collectWorkerEntries(tmpDir, lookup),
    ]);

  return {
    plan: planTmpJanitor({
      nowS,
      logEntries,
      scratchEntries,
      diagnosticsEntries,
      feedbackEntries,
      tmpRootNames,
    }),
    staleWorkers: planWorkerDirJanitor(workers),
  };
}

export async function applyTmpJanitorReport(
  tmpDir: string,
  report: TmpJanitorReport,
): Promise<TmpJanitorApplyResult> {
  const expired = [
    ...report.plan.logs.reclaim,
    ...report.plan.scratch.reclaim,
    ...report.plan.diagnostics.reclaim,
    ...report.plan.feedbackWorktrees.reclaim,
  ];
  const result: TmpJanitorApplyResult = {
    expiredLanes: [],
    staleWorkers: [],
    unknownTmpRoots: [],
    protectedLiveWorkers: [],
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
