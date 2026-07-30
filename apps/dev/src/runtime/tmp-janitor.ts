import { readdir, readlink, rm, stat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isLegacySlotLogName,
  pathIsInsideTmp,
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
import {
  planWorkerReclaim,
  type WorkerArtifact,
  type WorkerProcessVerdict,
  type WorkerReclaimPlan,
} from "../core/worker-reclaim.js";
import { decodeDevSnapshotSniff } from "../core/toon-snapshot.js";
import { allWorkersRoots, parseReapableWorkerPath } from "../core/worker-paths.js";
import { execTool } from "./exec.js";
import { killTreeAndWait } from "./kill-tree.js";
import {
  readDaemonWorkerSet,
  resolveWorkerLiveness,
  type DaemonWorkerSet,
  type DaemonWorkerSetReader,
} from "./liveness-anchor.js";

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
  /**
   * The daemon-keyed reclaim plan (Spec #2772 US 46): what the daemon's process
   * truth says about the artifacts each Worker left, plus every observed path no
   * Worker accounts for. This is the authority; the lanes below only ever narrow
   * it, never widen it.
   */
  workerReclaim: WorkerReclaimPlan;
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
  /** Workspaces removed because the daemon called their Worker gone. */
  workerWorkspaces: string[];
  /** Workspaces spared because the daemon did not call their Worker gone. */
  protectedLiveWorkspaces: string[];
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

// ---------- the daemon is the reclaim authority (Spec #2772 US 46) ----------

/**
 * Ask the daemon about one Worker, and NOTHING else.
 *
 * `evidenceOfLife` is the one contribution a caller may make, and it is one-way:
 * it can WITHHOLD a death claim, never manufacture a life. That is what keeps a
 * `worker.pid` file out of reclaim eligibility while a Worker the project
 * launched itself — one the daemon never birthed and so cannot vouch for — still
 * survives the sweep.
 */
export type WorkerLivenessLookup = (
  workerId: string,
  evidenceOfLife?: boolean,
) => WorkerProcessVerdict;

function livenessLookup(hostAnswer: DaemonWorkerSet | null): WorkerLivenessLookup {
  return (workerId, evidenceOfLife = false) =>
    resolveWorkerLiveness(hostAnswer, workerId, { evidenceOfLife }).verdict;
}

/** One daemon read, or null when it did not answer. Every Worker in the sweep is
 * judged against THIS answer, so two lanes of one sweep cannot disagree. */
async function readDaemon(read: DaemonWorkerSetReader): Promise<DaemonWorkerSet | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Which Workers something OTHER than the daemon can still see running.
 *
 * Read once and applied to every lane of the sweep, so a Worker cannot be
 * `unknown` to one lane and `dead` to the next — the disagreement that lets one
 * pass spare a workspace while another deletes it.
 */
async function collectWorkerEvidence(tmpDir: string): Promise<Set<string>> {
  const evidence = new Set<string>();
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    for (const worker of await listNames(workersRoot)) {
      if (pidAlive(await readText(join(workersRoot, worker, "worker.pid")))) evidence.add(worker);
    }
  }
  return evidence;
}

/** The sweep's ONE liveness question, with the host's evidence already folded in. */
function sweepLiveness(
  hostAnswer: DaemonWorkerSet | null,
  evidence: ReadonlySet<string>,
): WorkerLivenessLookup {
  const ask = livenessLookup(hostAnswer);
  return (workerId, extraEvidence = false) =>
    ask(workerId, evidence.has(workerId) || extraEvidence);
}

/**
 * Every artifact the Worker lanes hold, attributed to its owning Worker.
 *
 * The workspace path is DERIVED from the Worker's identity (ADR 0103/0105) — it
 * is a pure function of `workers/{id}/{issue}/worktree` — and the daemon still
 * decides whether the bytes go.
 */
async function collectWorkerArtifacts(tmpDir: string): Promise<{
  artifacts: WorkerArtifact[];
  observedPaths: string[];
}> {
  const artifacts: WorkerArtifact[] = [];
  const observedPaths: string[] = [];
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    for (const worker of await listNames(workersRoot)) {
      for (const issue of await listNames(join(workersRoot, worker))) {
        const issueDir = join(workersRoot, worker, issue);
        const worktree = join(issueDir, "worktree");
        try {
          if (!(await stat(worktree)).isDirectory()) continue;
        } catch {
          continue; // No workspace under this Worker's issue dir.
        }
        observedPaths.push(worktree);
        artifacts.push({ worker_id: worker, kind: "worktree", path: worktree });
        const log = join(issueDir, "worker.log.toonl");
        if (await readText(log) !== null) {
          artifacts.push({ worker_id: worker, kind: "log", path: log });
        }
      }
    }
  }
  return { artifacts, observedPaths };
}

async function collectWorkerEntries(
  tmpDir: string,
  lookup: IssueStateLookup,
  liveness: WorkerLivenessLookup,
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
      const verdict = liveness(worker);
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
        liveness: verdict,
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
 * Build the surviving-Worker index the orphan feedback sweep decides against.
 *
 * A Worker is in the set unless the DAEMON called it dead: `alive` and `unknown`
 * both survive, because only a fresh daemon answer may release bytes. `anyAlive`
 * reports whether any Worker survived at all, which is what the shared baseline
 * worktree (owned by no single Worker) is judged against.
 */
async function buildWorkerLivenessIndex(
  tmpDir: string,
  liveness: WorkerLivenessLookup,
): Promise<{ liveWorkers: Set<string>; anyAlive: boolean }> {
  const liveWorkers = new Set<string>();
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    for (const workerDir of await listNames(workersRoot)) {
      if (liveness(workerDir) !== "dead") liveWorkers.add(workerDir);
    }
  }
  return { liveWorkers, anyAlive: liveWorkers.size > 0 };
}

function feedbackIssueFromBasename(name: string): number | null {
  const match = /^afk-[A-Za-z0-9]+-([1-9][0-9]*)-/.exec(name);
  return match?.[1] ? Number(match[1]) : null;
}

/** Whether the issue's claim lock still names a running process. Evidence of
 * life only: a live claim WITHHOLDS a death claim about a resumed branch's
 * Worker, and can never assert one. */
async function feedbackClaimIsLive(tmpDir: string, name: string): Promise<boolean> {
  const issue = feedbackIssueFromBasename(name);
  if (issue === null) return false;
  return pidAlive(await readText(join(tmpDir, "claims", String(issue), "pid")));
}

async function collectOrphanFeedbackEntries(tmpDir: string, liveness: WorkerLivenessLookup): Promise<{
  entries: OrphanFeedbackEntry[];
  anyWorkerAlive: boolean;
}> {
  const feedbackDir = join(tmpDir, "worktrees", "feedback");
  const names = await listNames(feedbackDir);
  const { liveWorkers, anyAlive } = await buildWorkerLivenessIndex(tmpDir, liveness);
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
      // The daemon answers for the owning Worker; a re-claim that resumed an old
      // Worker's branch contributes its live claim as EVIDENCE, which withholds
      // the death claim without ever asserting a life of its own.
      ownerAlive =
        liveWorkers.has(workerSlug) ||
        liveness(workerSlug, await feedbackClaimIsLive(tmpDir, name)) !== "dead";
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
  liveness: WorkerLivenessLookup,
): Promise<
  | { safe: false; verdict: "owner-live" }
  | { safe: true; verdict: "owner-dead" | "no-live-workers" }
> {
  const workerSlug = parseFeedbackWorktreeWorkerSlug(basename(path));
  const { liveWorkers, anyAlive } = await buildWorkerLivenessIndex(tmpDir, liveness);
  if (workerSlug !== null) {
    const evidence = await feedbackClaimIsLive(tmpDir, basename(path));
    return liveWorkers.has(workerSlug) || liveness(workerSlug, evidence) !== "dead"
      ? { safe: false, verdict: "owner-live" }
      : { safe: true, verdict: "owner-dead" };
  }
  return anyAlive
    ? { safe: false, verdict: "owner-live" }
    : { safe: true, verdict: "no-live-workers" };
}

/** How this sweep reaches the daemon. Injected so a caller can hand the sweep a
 * host answer it already holds, and so the read is testable at the seam the
 * shipped path uses. */
export interface TmpJanitorSources {
  daemon?: DaemonWorkerSetReader;
}

export async function collectTmpJanitorReport(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
  sources: TmpJanitorSources = {},
): Promise<TmpJanitorReport> {
  const liveness = sweepLiveness(
    await readDaemon(sources.daemon ?? readDaemonWorkerSet),
    await collectWorkerEvidence(tmpDir),
  );
  const workerArtifacts = await collectWorkerArtifacts(tmpDir);
  const workerReclaim = planWorkerReclaim(workerArtifacts.artifacts, {
    liveness: (workerId) => liveness(workerId),
    nowIso: new Date(nowS * 1000).toISOString(),
    observedPaths: workerArtifacts.observedPaths,
  });
  const [tmpRootNames, tmpRootEntries, logEntries, scratchEntries, diagnosticsEntries, feedbackEntries, workers, orphanFeedbackData, supervisorEntries] =
    await Promise.all([
      listNames(tmpDir),
      listEntries(tmpDir),
      listEntries(join(tmpDir, "logs")),
      listEntries(join(tmpDir, "scratch")),
      listEntries(join(tmpDir, "diagnostics")),
      listEntries(join(tmpDir, "worktrees", "feedback")),
      collectWorkerEntries(tmpDir, lookup, liveness),
      collectOrphanFeedbackEntries(tmpDir, liveness),
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
    workerReclaim,
    staleWorkers: planWorkerDirJanitor(workers),
    staleSupervisors: planSupervisorLaneJanitor(supervisorEntries),
    orphanFeedback,
    orphanTestRunners,
  };
}

export async function applyTmpJanitorReport(
  tmpDir: string,
  report: TmpJanitorReport,
  options: TmpJanitorSources & {
    worktreePrune?: () => Promise<void>;
    reapProcessGroup?: (pgid: number) => Promise<boolean>;
    log?: (line: string) => void;
  } = {},
): Promise<TmpJanitorApplyResult> {
  // The daemon is RE-READ here, not carried from the plan: a Worker may have
  // been born between collect and apply, and the plan is history the moment it
  // is built. A removal is authorised by a CURRENT answer or not at all.
  const liveness = sweepLiveness(
    await readDaemon(options.daemon ?? readDaemonWorkerSet),
    await collectWorkerEvidence(tmpDir),
  );
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
    workerWorkspaces: [],
    protectedLiveWorkspaces: [],
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
      const owner = await feedbackRemovalVerdict(tmpDir, entry.path, liveness);
      if (!owner.safe) {
        protectFeedback(entry.path);
        continue;
      }
      await rm(entry.path, { recursive: true, force: true });
      removedFeedback.add(entry.path);
      result.removals.push({ path: entry.path, livenessVerdict: owner.verdict });
      result.expiredLanes.push(entry.path);
      continue;
    }
    await rm(entry.path, { recursive: true, force: true });
    result.removals.push({ path: entry.path, livenessVerdict: "not-worker-workspace" });
    result.expiredLanes.push(entry.path);
  }

  // The daemon-keyed pass runs FIRST: it is the authority, and the lanes below
  // only narrow what it already decided. Every removal is re-authorised against
  // the answer read at the top of this function.
  for (const verdict of report.workerReclaim.reclaim) {
    const path = verdict.artifact.path;
    if (path === undefined) continue; // No bytes here to remove.
    if (!pathIsInsideTmp(tmpDir, path)) {
      result.refusedOutsideTmp.push(path);
      continue;
    }
    if (liveness(verdict.worker_id) !== "dead") {
      result.protectedLiveWorkspaces.push(path);
      continue;
    }
    await rm(path, { recursive: true, force: true });
    result.removals.push({ path, livenessVerdict: "worker-dead" });
    result.workerWorkspaces.push(path);
  }

  for (const worker of report.staleWorkers.reclaim) {
    if (liveness(basename(worker.path)) !== "dead") {
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
    const owner = await feedbackRemovalVerdict(tmpDir, entry.path, liveness);
    if (!owner.safe) {
      protectFeedback(entry.path);
      continue;
    }
    if (!removedFeedback.has(entry.path)) {
      await rm(entry.path, { recursive: true, force: true });
      removedFeedback.add(entry.path);
      result.removals.push({ path: entry.path, livenessVerdict: owner.verdict });
    }
    result.orphanFeedback.push(entry.path);
  }

  // Removing the BYTES of a registered git worktree is only half the reclaim:
  // git's own registry still points at the deleted path, and a registration
  // nothing cleaned up is the trap this sweep exists to remove — it blocks a new
  // worktree at that path and can hold a lock a later gate run trips over
  // (#2866). Every lane that can delete a worktree is counted, not just the
  // feedback lane that used to be counted alone: a Worker's workspace is a
  // registered worktree exactly as much as a feedback lane is.
  const removedWorktrees =
    removedFeedback.size + result.workerWorkspaces.length + result.staleWorkers.length;
  if (removedWorktrees > 0 && options.worktreePrune) {
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

/** The Worker a Worker-lane path belongs to, or null when no lane owns it.
 * Pure path arithmetic over the ADR 0103/0105 layout — it asks nothing about
 * processes, which is exactly why the answer it feeds must come from the daemon. */
export function workerIdForTmpPath(tmpDir: string, path: string): string | null {
  const resolved = resolve(path);
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    const rel = relative(resolve(workersRoot), resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    return rel.split(sep)[0] ?? null;
  }
  return null;
}

/**
 * The daemon's CURRENT verdict on the Worker that owns one tmp path.
 *
 * This is the guard an apply pass calls immediately before removing: a Worker
 * may have been born since the plan was built. A path no Worker lane owns
 * answers `unknown`, which spares it.
 */
export async function readWorkerLivenessForTmpPath(
  tmpDir: string,
  path: string,
  sources: TmpJanitorSources = {},
): Promise<WorkerProcessVerdict> {
  const workerId = workerIdForTmpPath(tmpDir, path);
  if (workerId === null) return "unknown";
  const liveness = sweepLiveness(
    await readDaemon(sources.daemon ?? readDaemonWorkerSet),
    await collectWorkerEvidence(tmpDir),
  );
  return liveness(workerId);
}

export async function runTmpJanitor(
  tmpDir: string,
  nowS: number,
  lookup: IssueStateLookup,
  options: TmpJanitorSources & {
    fix?: boolean;
    worktreePrune?: () => Promise<void>;
    reapProcessGroup?: (pgid: number) => Promise<boolean>;
    log?: (line: string) => void;
  } = {},
): Promise<TmpJanitorRunResult> {
  const report = await collectTmpJanitorReport(tmpDir, nowS, lookup, options);
  if (!options.fix) return report;
  return { ...report, applied: await applyTmpJanitorReport(tmpDir, report, options) };
}
