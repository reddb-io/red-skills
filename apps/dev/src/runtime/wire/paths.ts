import { join } from "node:path";
import * as rp from "@reddb-io/shared/red-paths.js";
import { PROJECT_SUPERVISOR_LANE } from "@reddb-io/worker/engine";
import { inferGitHubRepoSlug } from "./github-slug.js";

export interface RepoContext {
  /** Primary checkout dir. */
  root: string;
  /** owner/repo slug for gh, or "" when unresolved. */
  repo: string;
  /** Remote name (always "origin" for AFK). */
  remote: string;
}

/** Resolve owner/repo from the configured git remote, best-effort. */
export async function resolveRepoSlug(root: string): Promise<string> {
  return inferGitHubRepoSlug(root);
}

export async function resolveRepoContext(root = process.cwd()): Promise<RepoContext> {
  const repo = await resolveRepoSlug(root);
  return { root, repo, remote: "origin" };
}

// ---------- standard paths ----------

export interface AfkPaths {
  tmpDir: string;
  stateDir: string;
  workersRoot: string;
  historyPath: string;
  /** The project's native supervisor runtime lane (tmp tier, ADR 0105). */
  supervisorRuntimeDir: string;
  /** Supervisor heartbeat snapshot (tmp supervisor lane, ADR 0105). */
  fleetStatePath: string;
  /** Supervisor firehose log (tmp supervisor lane). */
  fleetFirehosePath: string;
  /** Monitor log-cursor cache (tmp supervisor lane). */
  monitorLogCursorPath: string;
  /** Supervisor pid file (tmp supervisor lane). */
  supervisorPidPath: string;
  /** Stable process-start token paired with the supervisor pid lock. */
  supervisorPidStartPath: string;
  /** Durable marker for an interrupted quiescent-supervisor replacement. */
  supervisorRecoveryPath: string;
  /** Supervisor stop sentinel (tmp supervisor lane). */
  supervisorStopPath: string;
  /** Supervisor human-readable view source (structured TOONL firehose). */
  supervisorLogPath: string;
  /** Runtime elastic resize request (tmp supervisor lane). */
  supervisorResizePath: string;
  /** Watchdog restart ledger (tmp supervisor lane). */
  supervisorRestartsPath: string;
  /** Runner circuit-breaker directory (tmp supervisor lane). */
  runnerCircuitDir: string;
  /** Local git bedrock facts under their own micro-TTL (statusline state lane). */
  statuslineGitCachePath: string;
  /** Branch lock (state tier root). */
  branchLockPath: string;
  /** Global land lock (tmp tier — disposable coordination). */
  landLockPath: string;
  /** Claim-lock registry (tmp tier). */
  claimsDir: string;
  /** Failure-diagnostics lane (tmp tier). */
  diagnosticsDir: string;
  /** Merge-resolve scratch file (tmp scratch lane). */
  mergeResolveScratchPath: string;
  /** Disposable scratch worktree lanes (tmp/worktrees, ADR 0098). */
  landingWorktreesDir: string;
  rebaseWorktreesDir: string;
  cascadeWorktreesDir: string;
  feedbackWorktreesDir: string;
  adoptWorktreesDir: string;
  reconcileWorktreesDir: string;
  configPath: string;
}

/**
 * Resolve every AFK path for this project. There is ONE supervisor runtime lane
 * — `.red/tmp/supervisors/<PROJECT_SUPERVISOR_LANE>/` — because a project has
 * one demand producer and no fleet left to partition it by (ADR 0130). The
 * worker/claim/worktree lanes stay repo-wide, as the 3-layer claim already
 * coordinates across them.
 */
export function afkPaths(root: string): AfkPaths {
  const tmp = rp.tmpDir(root);
  const state = rp.stateDir(root);
  const afkState = rp.afkStateDir(root);
  const statusline = rp.statuslineStateDir(root);
  const supervisorRuntime = join(tmp, "supervisors", PROJECT_SUPERVISOR_LANE);
  return {
    tmpDir: tmp,
    stateDir: state,
    workersRoot: rp.workersDir(root),
    historyPath: join(afkState, "history.toonl"),
    supervisorRuntimeDir: supervisorRuntime,
    fleetStatePath: join(supervisorRuntime, "state.toon"),
    fleetFirehosePath: join(supervisorRuntime, "supervisor.log.toonl"),
    monitorLogCursorPath: join(supervisorRuntime, "monitor-log-cursors.toon"),
    supervisorPidPath: join(supervisorRuntime, "afk-supervisor.pid"),
    supervisorPidStartPath: join(supervisorRuntime, "afk-supervisor.pid.start"),
    supervisorRecoveryPath: join(supervisorRuntime, "afk-supervisor.recovering"),
    supervisorStopPath: join(supervisorRuntime, "afk-supervisor.stop"),
    supervisorLogPath: join(supervisorRuntime, "supervisor.log.toonl"),
    supervisorResizePath: join(supervisorRuntime, "resize.toon"),
    supervisorRestartsPath: join(supervisorRuntime, "restarts.toon"),
    runnerCircuitDir: join(supervisorRuntime, "runner-circuit"),
    statuslineGitCachePath: join(statusline, "statusline-git-cache.toon"),
    branchLockPath: rp.branchLockFile(root),
    landLockPath: join(tmp, "afk-land.lock"),
    claimsDir: rp.claimsDir(root),
    diagnosticsDir: rp.diagnosticsDir(root),
    mergeResolveScratchPath: join(rp.scratchDir(root), "merge-resolve.last"),
    landingWorktreesDir: rp.landingWorktreesDir(root),
    rebaseWorktreesDir: rp.rebaseWorktreesDir(root),
    cascadeWorktreesDir: rp.cascadeWorktreesDir(root),
    feedbackWorktreesDir: rp.feedbackWorktreesDir(root),
    adoptWorktreesDir: rp.adoptWorktreesDir(root),
    reconcileWorktreesDir: rp.reconcileWorktreesDir(root),
    configPath: join(rp.redDir(root), "config.yaml"),
  };
}
