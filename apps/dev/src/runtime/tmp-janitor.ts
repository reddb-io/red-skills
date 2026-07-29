import { readdir, readlink, rm, stat, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  isLegacySlotLogName,
  planTmpJanitor,
  planWorkerDirJanitor,
  planSupervisorLaneJanitor,
  parseFeedbackWorktreeWorkerSlug,
  planOrphanFeedbackWorktreeSweep,
  removableUnknownTmpRoots,
  supervisorLaneIsLive,
  type JanitorEntry,
  type OrphanFeedbackEntry,
  type OrphanFeedbackSweepPlan,
  type TmpJanitorPlan,
  type WorkerDirJanitorEntry,
  type SupervisorLaneEntry,
  type SupervisorLanePlan,
} from "../core/tmp-janitor.js";
import { decodeDevSnapshotSniff } from "../core/toon-snapshot.js";
import { allWorkersRoots, parseReapableWorkerPath } from "../core/worker-paths.js";
import { execTool } from "./exec.js";
import { killTreeAndWait } from "./kill-tree.js";

export const ORPHAN_TEST_RUNNER_MIN_AGE_S = 300;

export interface OrphanTestRunnerProcess {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  ageS: number;
  cwd: string;
  command: string;
}

export function selectOrphanTestRunners(
  processes: readonly OrphanTestRunnerProcess[],
  tmpDir: string,
  minAgeS = ORPHAN_TEST_RUNNER_MIN_AGE_S,
): OrphanTestRunnerProcess[] {
  const tmpPrefix = `${resolve(tmpDir)}${sep}`;
  return processes.filter((entry) =>
    entry.ageS >= minAgeS &&
    entry.ppid === entry.sid &&
    entry.pgid !== entry.sid &&
    resolve(entry.cwd).startsWith(tmpPrefix) &&
    /(?:^|[\s/(])(?:vitest|jest|mocha)(?:$|[\s/)])/i.test(entry.command)
  );
}

async function collectOrphanTestRunners(tmpDir: string): Promise<OrphanTestRunnerProcess[]> {
  if (process.platform === "win32") return [];
  const ps = await execTool("ps", ["-eo", "pid=,ppid=,pgid=,sid=,etimes=,args="]);
  if (ps.code !== 0) return [];
  const snapshots = await Promise.all(ps.stdout.split("\n").map(async (line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    const pid = Number(match[1]);
    let cwd: string;
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
    return {
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      sid: Number(match[4]),
      ageS: Number(match[5]),
      cwd,
      command: match[6]!.trim(),
    } satisfies OrphanTestRunnerProcess;
  }));
  return selectOrphanTestRunners(
    snapshots.filter((entry): entry is OrphanTestRunnerProcess => entry !== null),
    tmpDir,
  );
}

export type IssueStateLookup = (issue: number) => "OPEN" | "CLOSED" | "UNKNOWN";

export interface TmpJanitorReport {
  plan: TmpJanitorPlan;
  staleWorkers: ReturnType<typeof planWorkerDirJanitor>;
  /** Supervisor fleet dirs partitioned by pid liveness. Live dirs are spared;
   * dead dirs are eligible for removal. */
  staleSupervisors: SupervisorLanePlan;
  /** Orphaned feedback worktrees whose owning worker is dead (or the shared
   * baseline worktree when no workers are alive). Swept independently of the
   * mtime TTL sweep so dead-owner entries age out immediately. */
  orphanFeedback: OrphanFeedbackSweepPlan;
  /** Old, reparented test runners whose cwd is still inside this tmp tier. */
  orphanTestRunners: OrphanTestRunnerProcess[];
}

export interface TmpJanitorApplyResult {
  expiredLanes: string[];
  staleWorkers: string[];
  unknownTmpRoots: string[];
  protectedLiveWorkers: string[];
  /** Supervisor fleet dirs spared because their pid is live. */
  protectedLiveSupervisors: string[];
  /** Supervisor fleet dirs removed because their pid was dead. */
  staleSupervisors: string[];
  /** Feedback worktrees spared because their owning worker is live. */
  protectedLiveFeedback: string[];
  /** Orphaned feedback worktrees that were removed. */
  orphanFeedback: string[];
  /** Confirmed orphan runner processes reaped by process-group ID. */
  orphanTestRunners: Array<{ pid: number; pgid: number }>;
  /** Paths a plan named outside this tmp tier: reported, never removed. */
  refusedOutsideTmp: string[];
  /** Every destructive action, including the liveness verdict authorising it. */
  removals: Array<{
    path: string;
    livenessVerdict:
      | "not-worker-workspace"
      | "worker-dead"
      | "supervisor-dead"
      | "owner-dead"
      | "no-live-workers";
  }>;
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

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidAlive(raw: string | null): boolean {
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return false;
  return livePid(Number(trimmed));
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function collectWorkerEntries(
  tmpDir: string,
  lookup: IssueStateLookup,
): Promise<WorkerDirJanitorEntry[]> {
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

/** Read the supervisor pid recorded in a fleet's `state.toon` snapshot.
 * Returns null when the file is absent, undecodable, or carries no pid — an
 * older bundle's snapshot simply contributes no anchor. */
async function readFleetStatePid(fleetDir: string): Promise<number | null> {
  const text = await readText(join(fleetDir, "state.toon"));
  if (text === null) return null;
  let decoded: unknown;
  try {
    decoded = decodeDevSnapshotSniff(text);
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object") return null;
  const pid = Number((decoded as { pid?: unknown }).pid);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Find a live supervisor pid from the `s<pid>/` log dirs inside a fleet dir.
 * The supervisor names its own log lane after its pid, so the dir survives as a
 * liveness anchor even when the pid file was swept away. */
async function snapshotDirPidAlive(fleetDir: string): Promise<boolean> {
  for (const name of await listNames(fleetDir)) {
    const match = /^s([1-9][0-9]*)$/.exec(name);
    if (!match) continue;
    if (livePid(Number(match[1]))) return true;
  }
  return false;
}

/** Resolve every liveness anchor for one fleet dir. */
async function readSupervisorLaneLiveness(
  fleetDir: string,
  fleet: string,
): Promise<SupervisorLaneEntry> {
  const [pidFile, statePid, snapshotAlive] = await Promise.all([
    readText(join(fleetDir, "afk-supervisor.pid")),
    readFleetStatePid(fleetDir),
    snapshotDirPidAlive(fleetDir),
  ]);
  return {
    path: fleetDir,
    fleet,
    pidAlive: pidAlive(pidFile),
    statePidAlive: statePid !== null && livePid(statePid),
    snapshotPidAlive: snapshotAlive,
  };
}

/** Collect supervisor fleet dirs under `.red/tmp/supervisors/` with liveness. */
async function collectSupervisorEntries(tmpDir: string): Promise<SupervisorLaneEntry[]> {
  const supervisorsRoot = join(tmpDir, "supervisors");
  const fleets = await listNames(supervisorsRoot);
  const entries: SupervisorLaneEntry[] = [];
  for (const fleet of fleets) {
    const fleetDir = join(supervisorsRoot, fleet);
    try {
      const st = await stat(fleetDir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push(await readSupervisorLaneLiveness(fleetDir, fleet));
  }
  return entries;
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

function feedbackIssueFromBasename(name: string): number | null {
  const match = /^afk-[A-Za-z0-9]+-([1-9][0-9]*)-/.exec(name);
  return match?.[1] ? Number(match[1]) : null;
}

async function feedbackClaimIsLive(tmpDir: string, name: string): Promise<boolean> {
  const issue = feedbackIssueFromBasename(name);
  if (issue === null) return false;
  return pidAlive(await readText(join(tmpDir, "claims", String(issue), "pid")));
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
      // A re-claim may resume an old worker's branch, so the branch slug is not
      // always the current process owner. The active issue claim is an equal
      // liveness anchor and must spare that resumed workspace.
      ownerAlive = liveWorkers.has(workerSlug) || await feedbackClaimIsLive(tmpDir, name);
    } else {
      // Non-afk entry (e.g. 'main'): liveness is inferred from anyAlive
      ownerAlive = null;
    }
    entries.push({ path, basename: name, mtimeS, ownerAlive });
  }
  return { entries, anyWorkerAlive: anyAlive };
}

async function feedbackRemovalVerdict(
  tmpDir: string,
  path: string,
): Promise<
  | { safe: false; verdict: "owner-live" }
  | { safe: true; verdict: "owner-dead" | "no-live-workers" }
> {
  const workerSlug = parseFeedbackWorktreeWorkerSlug(basename(path));
  const { liveWorkers, anyAlive } = await buildWorkerLivenessIndex(tmpDir);
  if (workerSlug !== null) {
    return liveWorkers.has(workerSlug) || await feedbackClaimIsLive(tmpDir, basename(path))
      ? { safe: false, verdict: "owner-live" }
      : { safe: true, verdict: "owner-dead" };
  }
  return anyAlive
    ? { safe: false, verdict: "owner-live" }
    : { safe: true, verdict: "no-live-workers" };
}

export async function collectTmpJanitorReport(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
): Promise<TmpJanitorReport> {
  const [tmpRootNames, tmpRootEntries, logEntries, scratchEntries, diagnosticsEntries, feedbackEntries, workers, orphanFeedbackData, supervisorEntries] =
    await Promise.all([
      listNames(tmpDir),
      listEntries(tmpDir),
      listEntries(join(tmpDir, "logs")),
      listEntries(join(tmpDir, "scratch")),
      listEntries(join(tmpDir, "diagnostics")),
      listEntries(join(tmpDir, "worktrees", "feedback")),
      collectWorkerEntries(tmpDir, lookup),
      collectOrphanFeedbackEntries(tmpDir),
      collectSupervisorEntries(tmpDir),
    ]);
  const legacySlotLogEntries = tmpRootEntries.filter((entry) => isLegacySlotLogName(basename(entry.path)));
  const orphanFeedback = planOrphanFeedbackWorktreeSweep(orphanFeedbackData.entries, orphanFeedbackData.anyWorkerAlive);
  const orphanTestRunners = await collectOrphanTestRunners(tmpDir);
  const feedbackSafeToAge = new Set(orphanFeedback.reclaim.map((entry) => entry.path));

  return {
    plan: planTmpJanitor({
      nowS,
      logEntries,
      scratchEntries,
      diagnosticsEntries,
      // TTL must never overrule owner liveness. The owner-aware orphan plan is
      // the authority for which feedback worktrees are safe even to consider.
      feedbackEntries: feedbackEntries.filter((entry) => feedbackSafeToAge.has(entry.path)),
      legacySlotLogEntries,
      tmpRootNames,
    }),
    staleWorkers: planWorkerDirJanitor(workers),
    staleSupervisors: planSupervisorLaneJanitor(supervisorEntries),
    orphanFeedback,
    orphanTestRunners,
  };
}

export async function applyTmpJanitorReport(
  tmpDir: string,
  report: TmpJanitorReport,
  options: {
    worktreePrune?: () => Promise<void>;
    reapProcessGroup?: (pgid: number) => Promise<boolean>;
    log?: (line: string) => void;
  } = {},
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
    protectedLiveSupervisors: [],
    staleSupervisors: [],
    protectedLiveFeedback: [],
    orphanFeedback: [],
    orphanTestRunners: [],
    refusedOutsideTmp: [],
    removals: [],
  };
  const feedbackDir = join(tmpDir, "worktrees", "feedback");
  const removedFeedback = new Set<string>();
  const protectFeedback = (path: string) => {
    if (!result.protectedLiveFeedback.includes(path)) result.protectedLiveFeedback.push(path);
  };
  for (const entry of report.orphanFeedback.spare) {
    protectFeedback(entry.path);
  }

  for (const entry of expired) {
    if (dirname(entry.path) === feedbackDir) {
      const liveness = await feedbackRemovalVerdict(tmpDir, entry.path);
      if (!liveness.safe) {
        protectFeedback(entry.path);
        continue;
      }
      await rm(entry.path, { recursive: true, force: true });
      removedFeedback.add(entry.path);
      result.removals.push({ path: entry.path, livenessVerdict: liveness.verdict });
      result.expiredLanes.push(entry.path);
      continue;
    }
    await rm(entry.path, { recursive: true, force: true });
    result.removals.push({ path: entry.path, livenessVerdict: "not-worker-workspace" });
    result.expiredLanes.push(entry.path);
  }

  for (const worker of report.staleWorkers.reclaim) {
    if (pidAlive(await readText(join(worker.path, "worker.pid")))) {
      result.protectedLiveWorkers.push(worker.path);
      continue;
    }
    await rm(worker.path, { recursive: true, force: true });
    result.removals.push({ path: worker.path, livenessVerdict: "worker-dead" });
    result.staleWorkers.push(worker.path);
  }

  // Re-check every supervisor anchor at apply time — a supervisor may have
  // started between collect and apply (same pattern as the worker liveness
  // re-check), and a live lane must survive whichever anchor it still carries.
  for (const supervisor of report.staleSupervisors.reclaim) {
    if (supervisorLaneIsLive(await readSupervisorLaneLiveness(supervisor.path, supervisor.fleet))) {
      result.protectedLiveSupervisors.push(supervisor.path);
      continue;
    }
    await rm(supervisor.path, { recursive: true, force: true });
    result.removals.push({ path: supervisor.path, livenessVerdict: "supervisor-dead" });
    result.staleSupervisors.push(supervisor.path);
  }
  for (const supervisor of report.staleSupervisors.spare) {
    result.protectedLiveSupervisors.push(supervisor.path);
  }

  // A registered lane is never removable through the unknown-entry path, even
  // if the plan named one (issue #2679).
  for (const name of removableUnknownTmpRoots(report.plan.unknownTmpRoots)) {
    const path = join(tmpDir, name);
    await rm(path, { recursive: true, force: true });
    result.removals.push({ path, livenessVerdict: "not-worker-workspace" });
    result.unknownTmpRoots.push(path);
  }

  for (const entry of report.orphanFeedback.reclaim) {
    const liveness = await feedbackRemovalVerdict(tmpDir, entry.path);
    if (!liveness.safe) {
      protectFeedback(entry.path);
      continue;
    }
    if (!removedFeedback.has(entry.path)) {
      await rm(entry.path, { recursive: true, force: true });
      removedFeedback.add(entry.path);
      result.removals.push({ path: entry.path, livenessVerdict: liveness.verdict });
    }
    result.orphanFeedback.push(entry.path);
  }

  // After removing orphaned feedback worktrees, ask git to prune its own
  // internal registry so stale worktree entries do not accumulate there either.
  if (result.orphanFeedback.length > 0 && options.worktreePrune) {
    await options.worktreePrune().catch(() => {});
  }

  const reapProcessGroup = options.reapProcessGroup ?? killTreeAndWait;
  const reapedGroups = new Set<number>();
  for (const orphan of report.orphanTestRunners) {
    let reaped = reapedGroups.has(orphan.pgid);
    if (!reaped) {
      reaped = await reapProcessGroup(orphan.pgid).catch(() => false);
      if (reaped) reapedGroups.add(orphan.pgid);
    }
    if (!reaped) continue;
    result.orphanTestRunners.push({ pid: orphan.pid, pgid: orphan.pgid });
    options.log?.(
      `tmp-janitor reaped orphan test runner pid=${orphan.pid} pgid=${orphan.pgid} cwd=${relative(tmpDir, orphan.cwd)} command=${orphan.command}`,
    );
  }

  return result;
}

export async function runTmpJanitor(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
  options: {
    fix?: boolean;
    worktreePrune?: () => Promise<void>;
    reapProcessGroup?: (pgid: number) => Promise<boolean>;
    log?: (line: string) => void;
  } = {},
): Promise<TmpJanitorRunResult> {
  const report = await collectTmpJanitorReport(tmpDir, nowS, lookup);
  if (!options.fix) return report;
  return { ...report, applied: await applyTmpJanitorReport(tmpDir, report, options) };
}
