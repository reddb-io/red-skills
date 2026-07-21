import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import {
  castleLanePath,
  createEnginePaths,
  fleetRegistryPath,
  readCastleHistoryRecords,
  readCastleLaneRecords,
  readFleetProfile,
  readFleetProfiles,
  removeFleetProfile,
  upsertFleetProfile,
  CASTLE_WORKTREE_LANES,
  type FleetProfile,
} from "@reddb-io/red-castle/engine";
import type {
  ClaimIssueInput,
  ClaimReleaseInput,
  CastleMcpDependencies,
  FleetCreateInput,
  FleetEditInput,
  FleetNameInput,
  GateRunInput,
  LandBranchInput,
  LogsInput,
  WorktreeRemoveInput,
} from "../../../packages/red-castle/src/mcp-server.js";
import { readBuildInfo } from "@reddb-io/build-info";
import { collectDashboardReport } from "./commands/dashboard.js";
import { stopFleet, writeResizeRequest } from "./commands/fleet.js";
import {
  classifySupervisor,
  resolveSupervisorConfig,
} from "./core/supervisor.js";
import { listCandidates, listHitlCandidates } from "./runtime/gh.js";
import * as ghx from "./runtime/gh.js";
import { isLivePid } from "./runtime/kill-tree.js";
import { spawnSupervisor } from "./runtime/supervisor-spawn.js";
import { discoverLiveSupervisorPid } from "./runtime/supervisor-state.js";
import {
  afkPaths,
  collectMonitorInputs,
  readFleetState,
  resolveRepoContext,
} from "./runtime/wire.js";
import { readAllWorkerStates } from "./core/worker-state-reader.js";
import { parseClaimRecords, renderClaimComment } from "./core/claim.js";
import {
  relevantScopes,
  runFeedback,
  type Exec as FeedbackExec,
  type PackageLayout,
} from "./core/feedback.js";
import {
  doLanding,
  type LandingDeps,
  type LandingHookContexts,
} from "./core/landing.js";
import { makeFeedbackWorktree } from "./runtime/feedback-worktree.js";
import { createLandLock } from "./runtime/land-lock.js";
import { pnpm as runPnpm } from "./runtime/exec.js";
import * as gitx from "./runtime/git.js";

export interface DevAfkMcpSensitiveOperations {
  gateRun(input: GateRunInput): Promise<unknown>;
  gateBaselineStatus(): Promise<unknown>;
  landBranch(input: LandBranchInput): Promise<unknown>;
  cascadeStatus(): Promise<unknown>;
  claimStatus(input: ClaimIssueInput): Promise<unknown>;
  claimRelease(input: ClaimReleaseInput): Promise<unknown>;
  worktreeList(): Promise<unknown>;
  worktreeRemove(input: WorktreeRemoveInput): Promise<unknown>;
}

function layoutAt(root: string): PackageLayout {
  return {
    hasPackage(scope) {
      return existsSync(
        join(scope === "." ? root : join(root, scope), "package.json"),
      );
    },
    hasScript(scope, script) {
      try {
        const dir = scope === "." ? root : join(root, scope);
        const pkg = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        ) as {
          scripts?: Record<string, unknown>;
        };
        return Boolean(pkg.scripts && script in pkg.scripts);
      } catch {
        return false;
      }
    },
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function slug(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "worktree"
  );
}

export function createDefaultDevAfkMcpSensitiveOperations(
  root: string,
): DevAfkMcpSensitiveOperations {
  const paths = afkPaths(root);
  const gitContext: gitx.GitContext = { cwd: root };

  async function gateRun(input: GateRunInput) {
    const branch = input.branch;
    const localWorktree = input.worktree
      ? resolve(root, input.worktree)
      : undefined;
    if (localWorktree && !isWithin(root, localWorktree)) {
      throw new Error("gate worktree must resolve inside the repository");
    }
    const manager = branch
      ? makeFeedbackWorktree(root, paths.feedbackWorktreesDir)
      : undefined;
    const layout = manager?.layout ?? layoutAt(localWorktree!);
    const changedFiles =
      input.changedFiles ??
      (await gitx.changedFiles(
        { cwd: localWorktree ?? root },
        branch ?? "HEAD",
        input.base ?? "main",
      ));
    const scopes = relevantScopes(layout, changedFiles);
    const feedbackExec: FeedbackExec = manager
      ? manager.pnpm
      : async (args, opts) => {
          const commandArgs = args[0] === "pnpm" ? args.slice(1) : args;
          const result = await runPnpm(commandArgs, {
            cwd: localWorktree!,
            env: opts?.env,
          });
          return {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        };
    try {
      return await runFeedback(feedbackExec, {
        worktree: branch ?? localWorktree!,
        scopes,
        layout,
        now: Date.now,
        ...(branch && input.base ? { baselineWorktree: input.base } : {}),
      });
    } finally {
      await manager?.cleanup();
    }
  }

  async function baselineStatus() {
    const context = await resolveRepoContext(root);
    const issue = await ghx.findMainRedRepairIssue({
      cwd: context.root,
      repo: context.repo,
    });
    return { red: issue !== null, issue };
  }

  function landingDeps(input: LandBranchInput): LandingDeps {
    const makeWorktree = async (laneRoot: string, ref: string) => {
      await mkdir(laneRoot, { recursive: true });
      const dest = join(laneRoot, `${slug(ref)}-mcp-${process.pid}`);
      await gitx.worktreeRemove(gitContext, dest);
      return (await gitx.worktreeAdd(gitContext, dest, ref)) ? dest : null;
    };
    return {
      mergeExec: gitx.mergeExec(gitContext),
      remoteGit: gitx.gitExec(gitContext),
      fireHook: async () => true,
      makeLandingWorktree: (base) =>
        makeWorktree(paths.landingWorktreesDir, base),
      removeLandingWorktree: (dir) => gitx.worktreeRemove(gitContext, dir),
      makeRebaseWorktree: (branch) =>
        makeWorktree(paths.rebaseWorktreesDir, branch),
      removeRebaseWorktree: (dir) => gitx.worktreeRemove(gitContext, dir),
      getDiffPaths: async () => ({
        changedFiles: await gitx.changedFiles(
          gitContext,
          input.branch,
          input.base,
        ),
        packageJsonDiff: "",
      }),
      findMainRedRepairIssue: async () => {
        const context = await resolveRepoContext(root);
        return ghx.findMainRedRepairIssue({
          cwd: context.root,
          repo: context.repo,
        });
      },
      postMergeGate: async (worktree) => {
        const result = await gateRun({
          worktree,
          base: input.base,
          changedFiles: await gitx.changedFiles(
            gitContext,
            input.branch,
            input.base,
          ),
        });
        return { ok: Boolean((result as { ok?: boolean }).ok) };
      },
      landLock: createLandLock(paths.tmpDir, `mcp-${process.pid}`),
    };
  }

  return {
    gateRun,
    gateBaselineStatus: baselineStatus,
    async landBranch(input) {
      if (input.gatePassed !== true) {
        throw new Error("land_branch requires a passing gate verdict");
      }
      const context = await resolveRepoContext(root);
      if (!context.repo)
        throw new Error("land_branch could not resolve the repository slug");
      const baseline = await baselineStatus();
      const hooks: LandingHookContexts = {
        preMerge: () =>
          JSON.stringify({ issue: input.issue, branch: input.branch }),
        postMerge: (mergeSha) =>
          JSON.stringify({
            issue: input.issue,
            branch: input.branch,
            mergeSha,
          }),
      };
      return doLanding(
        landingDeps(input),
        {
          openPr: input.openPr ?? true,
          locked: false,
          repo: context.repo,
          repoDir: root,
          remote: context.remote,
          branch: input.branch,
          validatedBranchTip: input.validatedBranchTip,
          base: input.base,
          trunk: input.trunk ?? input.base,
          issue: input.issue,
          title: input.title,
          mainRed: (baseline as { red: boolean }).red,
        },
        hooks,
      );
    },
    async cascadeStatus() {
      const records = await readAllWorkerStates(paths.tmpDir);
      return records
        .filter(({ state }) => state.current.phase === "cascade")
        .map(({ state, live, active }) => ({
          worker: state.worker_id,
          issue: state.current.number,
          phase: state.current.phase,
          live,
          active,
        }));
    },
    async claimStatus(input) {
      const context = await resolveRepoContext(root);
      const comments = await ghx.listClaimComments(
        { cwd: context.root, repo: context.repo },
        input.issue,
      );
      return parseClaimRecords(comments);
    },
    async claimRelease(input) {
      const context = await resolveRepoContext(root);
      await ghx.comment(
        { cwd: context.root, repo: context.repo },
        input.issue,
        renderClaimComment(
          { worker: input.worker, runner: input.runner },
          "concede",
        ),
      );
      return { released: true, issue: input.issue, worker: input.worker };
    },
    async worktreeList() {
      const worktreesRoot = createEnginePaths(join(root, ".red")).worktreesRoot;
      const entries: Array<{ lane: string; name: string; path: string }> = [];
      for (const lane of CASTLE_WORKTREE_LANES) {
        const laneRoot = join(worktreesRoot, lane);
        const children = await readdir(laneRoot, { withFileTypes: true }).catch(
          () => [],
        );
        for (const child of children) {
          if (child.isDirectory()) {
            entries.push({
              lane,
              name: child.name,
              path: join(laneRoot, child.name),
            });
          }
        }
      }
      return entries;
    },
    async worktreeRemove(input) {
      const worktreesRoot = createEnginePaths(join(root, ".red")).worktreesRoot;
      const candidate = resolve(worktreesRoot, input.worktree);
      const rel = relative(worktreesRoot, candidate);
      const [lane, name, ...rest] = rel.split(sep);
      if (
        !lane ||
        !name ||
        rest.length > 0 ||
        !(CASTLE_WORKTREE_LANES as readonly string[]).includes(lane) ||
        !isWithin(worktreesRoot, candidate)
      ) {
        throw new Error(
          "worktree_remove requires <lane>/<name> inside a canonical worktree lane",
        );
      }
      await gitx.worktreeRemove(gitContext, candidate);
      if (existsSync(candidate)) {
        throw new Error(`worktree removal failed for ${lane}/${name}`);
      }
      return { removed: true, lane, name };
    },
  };
}

function registryPath(root: string): string {
  return fleetRegistryPath(createEnginePaths(join(root, ".red")));
}

function profileForCreate(input: FleetCreateInput): FleetProfile {
  return {
    name: input.name,
    runner: input.runner,
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.config ? { config: input.config } : {}),
    ...(input.base ? { base: input.base } : {}),
  };
}

async function fleetStatus(root: string, input: FleetNameInput) {
  const paths = afkPaths(root, input.name);
  const [fleet, monitor, discovered] = await Promise.all([
    readFleetState(paths.fleetStatePath),
    collectMonitorInputs(root),
    discoverLiveSupervisorPid(paths.supervisorRuntimeDir, isLivePid, {
      fleet: paths.fleet,
    }),
  ]);
  const pid = discovered?.pid ?? null;
  const now = Math.floor(Date.now() / 1_000);
  const config = resolveSupervisorConfig();
  const health = classifySupervisor(
    {
      pid,
      pidAlive: pid !== null,
      lastHeartbeatEpoch: fleet?.epoch ?? null,
      lastProgressEpoch: fleet?.lastProgressEpoch ?? null,
      slotsBusy: fleet?.slotsBusy ?? 0,
    },
    now,
    config.supervisorStaleS,
    config.progressStaleS,
  );
  const liveWorkers = monitor.workers.filter(
    (worker) => worker.pidLive === true || worker.live,
  );
  const latestBundleVersion =
    fleet?.latestBundleVersion ?? readBuildInfo("dev").version;
  return {
    fleet: paths.fleet,
    supervisor: {
      pid: pid ?? 0,
      alive: pid !== null,
      health,
      runner: fleet?.runner ?? "",
      target: fleet?.target ?? fleet?.slotsTotal ?? 0,
      bundle_version: fleet?.bundleVersion ?? "",
      bundle_latest: latestBundleVersion,
      version_skew: Number(
        Boolean(
          fleet?.bundleVersion &&
          latestBundleVersion &&
          fleet.bundleVersion !== latestBundleVersion,
        ),
      ),
      heartbeat_age_s: fleet ? now - fleet.epoch : -1,
    },
    slots: {
      busy: fleet?.slotsBusy ?? 0,
      free: fleet?.slotsFree ?? 0,
      parked: fleet?.slotsParked ?? 0,
      total: fleet?.slotsTotal ?? 0,
    },
    churn: {
      deaths: fleet?.churnDeaths ?? 0,
      respawns: fleet?.churnRespawns ?? 0,
      window_s: fleet?.churnWindowS ?? 0,
    },
    live_workers: liveWorkers.map((worker) => ({
      id: worker.state.worker_id,
      pid: worker.state.pid,
      issue: String(worker.state.current.number),
      activity: worker.state.current.activity,
      origin: worker.state.origin ?? "afk",
    })),
  };
}

async function createFleet(root: string, input: FleetCreateInput) {
  const path = registryPath(root);
  if (await readFleetProfile(path, input.name)) {
    throw new Error(`fleet ${JSON.stringify(input.name)} already exists`);
  }
  const paths = afkPaths(root, input.name);
  const running = await discoverLiveSupervisorPid(
    paths.supervisorRuntimeDir,
    isLivePid,
    { fleet: paths.fleet },
  );
  if (running) {
    throw new Error(`fleet ${JSON.stringify(paths.fleet)} is already running`);
  }

  const profile = await upsertFleetProfile(path, profileForCreate(input));
  const pid = await spawnSupervisor({
    root,
    target: input.target,
    runner: profile.runner,
    fleet: profile.name,
    passthrough: profile.selector
      ? ["--selector", JSON.stringify(profile.selector)]
      : [],
  });
  if (pid === null) {
    await removeFleetProfile(path, profile.name).catch(() => false);
    throw new Error(`fleet ${JSON.stringify(profile.name)} failed to start`);
  }
  return { status: "launched", profile, pid, target: input.target };
}

async function editFleet(root: string, input: FleetEditInput) {
  const path = registryPath(root);
  const existing = await readFleetProfile(path, input.name);
  if (!existing)
    throw new Error(`fleet ${JSON.stringify(input.name)} does not exist`);
  const profile = await upsertFleetProfile(path, {
    ...existing,
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
  });

  let directive: "not-requested" | "written" = "not-requested";
  if (input.target !== undefined || input.runner !== undefined) {
    const paths = afkPaths(root, profile.name);
    const state = await readFleetState(paths.fleetStatePath);
    const target = input.target ?? state?.target ?? state?.slotsTotal;
    if (target !== undefined) {
      await writeResizeRequest(
        paths.supervisorResizePath,
        target,
        state?.shrinkMode ?? resolveSupervisorConfig().shrinkMode,
        input.runner,
      );
      directive = "written";
    }
  }
  return { status: "edited", profile, directive };
}

async function laneLogs(root: string, input: LogsInput) {
  const paths = createEnginePaths(join(root, ".red"));
  const laneRoot =
    input.lane === "supervisor"
      ? paths.supervisorsRoot
      : input.lane === "monitor"
        ? paths.monitorsRoot
        : paths.workersRoot;
  const path = resolve(castleLanePath(paths, input.lane, input.id));
  const rel = relative(resolve(laneRoot), path);
  if (rel.startsWith("..") || resolve(laneRoot) === path) {
    throw new Error("log lane id escapes its Castle lane root");
  }
  return readCastleLaneRecords(path);
}

async function workerVitals(root: string) {
  const records = await readAllWorkerStates(afkPaths(root).tmpDir);
  return records.map(({ state, ...record }) => ({
    worker: {
      id: state.worker_id,
      pid: state.pid,
      runner: state.runner,
      origin: state.origin,
      started_at: state.started_at,
      done: state.done,
      total: state.total,
      blocked: state.blocked,
      failed: state.failed,
      current: {
        number: state.current.number,
        runner: state.current.runner,
        retries: state.current.retries,
        phase: state.current.phase,
        iteration: state.current.iteration,
        activity: state.current.activity,
        loc_added: state.current.loc_added,
        loc_removed: state.current.loc_removed,
        last_commit_at: state.current.last_commit_at,
        tools_called_count: state.current.tools_called_count,
        text_chunk_count: state.current.text_chunk_count,
        reasoning_events: state.current.reasoning_events,
        reasoning_tokens: state.current.reasoning_tokens,
        last_event_at: state.current.last_event_at,
        waiting_count: state.current.waiting_count,
        input_tokens: state.current.input_tokens,
        output_tokens: state.current.output_tokens,
        cost_usd: state.current.cost_usd,
      },
    },
    live: record.live,
    active: record.active,
    renderable_live: record.renderableLive,
    liveness: record.liveness,
    liveness_verdict: record.livenessVerdict,
  }));
}

export function createDevAfkMcpDependencies(
  root = process.cwd(),
  sensitive = createDefaultDevAfkMcpSensitiveOperations(root),
): CastleMcpDependencies {
  return {
    fleetList: () => readFleetProfiles(registryPath(root)),
    fleetStatus: (input) => fleetStatus(root, input),
    fleetCreate: (input) => createFleet(root, input),
    fleetEdit: (input) => editFleet(root, input),
    fleetStop: async (input) => {
      const silent = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const result = await stopFleet(root, silent, input.name);
      return { fleet: input.name ?? "default", ...result };
    },
    logs: (input) => laneLogs(root, input),
    workerVitals: () => workerVitals(root),
    dashboard: ({ periodDays }) => collectDashboardReport(periodDays, root),
    monitor: () => collectMonitorInputs(root),
    history: async ({ limit }) => {
      const records = await readCastleHistoryRecords(
        createEnginePaths(join(root, ".red")).castleHistory,
      );
      return limit === undefined ? records : records.slice(-limit);
    },
    queueStatus: async () => {
      const context = await resolveRepoContext(root);
      const gh = { cwd: root, repo: context.repo };
      const [readyForAgent, readyForHuman] = await Promise.all([
        listCandidates(gh),
        listHitlCandidates(gh),
      ]);
      return {
        ready_for_agent: readyForAgent.map(
          ({ body: _body, ...candidate }) => candidate,
        ),
        ready_for_human: readyForHuman,
        counts: {
          ready_for_agent: readyForAgent.length,
          ready_for_human: readyForHuman.length,
        },
      };
    },
    gateRun: (input) => sensitive.gateRun(input),
    gateBaselineStatus: () => sensitive.gateBaselineStatus(),
    landBranch: (input) => sensitive.landBranch(input),
    cascadeStatus: () => sensitive.cascadeStatus(),
    claimStatus: (input) => sensitive.claimStatus(input),
    claimRelease: (input) => sensitive.claimRelease(input),
    worktreeList: () => sensitive.worktreeList(),
    worktreeRemove: (input) => sensitive.worktreeRemove(input),
  };
}
