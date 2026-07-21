import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { decode as decodeToon } from "@reddb-io/toon";
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
  RUNNER_SPECS,
  detectRunner,
  type FleetProfile,
} from "@reddb-io/red-castle/engine";
import type {
  CastleMcpDependencies,
  FleetCreateInput,
  FleetEditInput,
  FleetNameInput,
  LogsInput,
  RequeueToolInput,
  RetakeToolInput,
  WorkerDispatchInput,
  WorkerRequestInput,
  WorkerStopInput,
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
import { stopCommand } from "./commands/stop.js";
import { executeRequeue } from "./commands/requeue.js";
import { retakeCommand } from "./commands/retake.js";
import {
  dispatchGo,
  type DisposableIssueSpec,
} from "./core/go.js";
import { loadConfig, readBackpressure } from "./core/config.js";
import {
  branchesToReap,
  planLiveBranchCleanup,
  planLocalBranchCleanup,
} from "./core/branch-cleanup.js";
import { executeUnblockSweep } from "./core/boot-sweep.js";
import { collectReapInputs } from "./runtime/wire/reap.js";

interface DispatchOperationInput extends WorkerDispatchInput {
  request?: string;
}

export interface DevAfkMcpOperations {
  dispatchIssue(
    root: string,
    input: DispatchOperationInput & { issue: number },
  ): Promise<unknown>;
  dispatchDemand(
    root: string,
    input: DispatchOperationInput & { demand: string },
  ): Promise<unknown>;
  stopWorker(root: string, input: WorkerStopInput): Promise<unknown>;
  requeue(input: RequeueToolInput): Promise<unknown>;
  retake(input: RetakeToolInput): Promise<unknown>;
  reap(): Promise<unknown>;
  unblockSweep(): Promise<unknown>;
}

export interface DevAfkMcpRuntime {
  launchRun(root: string, args: readonly string[]): Promise<{ pid: number }>;
  ensureLabel(root: string, name: string): Promise<void>;
  createIssue(root: string, spec: DisposableIssueSpec): Promise<number>;
  executeRequeue(root: string, input: RequeueToolInput): Promise<unknown>;
}

function captureStream(): {
  stream: Writable;
  text(): string;
} {
  let output = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
    text: () => output,
  };
}

function parsedCommandOutput(
  output: string,
  exitCode: number,
  format: "json" | "toon",
): unknown {
  const trimmed = output.trim();
  if (trimmed === "") return { exit_code: exitCode };
  try {
    const value = format === "json" ? JSON.parse(trimmed) : decodeToon(trimmed);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>), exit_code: exitCode };
    }
    return { value, exit_code: exitCode };
  } catch {
    return { output: trimmed, exit_code: exitCode };
  }
}

function dispatchArgs(input: DispatchOperationInput): string[] {
  const args: string[] = [];
  if (input.runner) args.push("--runner", input.runner);
  if (input.request) args.push("--request", input.request);
  return args;
}

async function launchDetachedRun(
  root: string,
  args: readonly string[],
): Promise<{ pid: number }> {
  const mcpBundle = process.argv[1];
  if (!mcpBundle) {
    throw new Error("cannot dispatch worker: MCP bundle path is missing");
  }
  const bundle = resolveDevCliBundle(mcpBundle);
  if (!existsSync(bundle)) {
    throw new Error("cannot dispatch worker: sibling dev bundle is missing");
  }
  const child = spawn(process.execPath, [bundle, "run", ...args], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (!pid) throw new Error("cannot dispatch worker: spawn returned no pid");
  child.unref();
  return { pid };
}

export function resolveDevCliBundle(mcpBundle: string): string {
  const file = basename(mcpBundle);
  if (file === "afk-mcp.bundle.min.mjs") {
    return join(dirname(mcpBundle), "dev.bundle.min.mjs");
  }
  if (file.startsWith("afk-mcp-") && file.endsWith(".bundle.min.mjs")) {
    return join(dirname(mcpBundle), file.replace(/^afk-mcp-/, "dev-"));
  }
  throw new Error(
    `cannot dispatch worker: unrecognized MCP bundle name ${JSON.stringify(file)}`,
  );
}

const defaultMcpRuntime: DevAfkMcpRuntime = {
  launchRun: launchDetachedRun,
  async ensureLabel(root, name) {
    const context = await resolveRepoContext(root);
    await ghx.ensureLabel({ cwd: context.root, repo: context.repo }, name);
  },
  async createIssue(root, spec) {
    const context = await resolveRepoContext(root);
    return ghx.createIssue({ cwd: context.root, repo: context.repo }, spec);
  },
  executeRequeue: (root, input) => executeRequeue(input, { cwd: root }),
};

export function createDefaultDevAfkMcpOperations(
  root: string,
  overrides: Partial<DevAfkMcpRuntime> = {},
): DevAfkMcpOperations {
  const runtime: DevAfkMcpRuntime = { ...defaultMcpRuntime, ...overrides };
  return {
    async dispatchIssue(cwd, input) {
      const args = [
        "--issues",
        String(input.issue),
        "--once",
        ...dispatchArgs(input),
      ];
      const launch = await runtime.launchRun(cwd, args);
      return {
        kind: "afk",
        issue: input.issue,
        worker_pid: launch.pid,
        status: "dispatched",
      };
    },
    async dispatchDemand(cwd, input) {
      let workerPid: number | undefined;
      const configuredBackpressure = readBackpressure(
        loadConfig(afkPaths(cwd).configPath, { warn: () => undefined }),
      );
      const result = await dispatchGo(
        {
          ensureLabel: (name) => runtime.ensureLabel(cwd, name),
          createIssue: (spec) => runtime.createIssue(cwd, spec),
          runEngine: async (args) => {
            const launch = await runtime.launchRun(cwd, args);
            workerPid = launch.pid;
            return 0;
          },
        },
        input.demand,
        {
          runner: input.runner,
          mode: input.mode,
          request: input.request,
          hasHarness: configuredBackpressure.length > 0,
        },
      );
      if (workerPid === undefined) {
        throw new Error("cannot dispatch demand: worker was not spawned");
      }
      return {
        kind: "go",
        demand: input.demand,
        issue: result.issue,
        worker_pid: workerPid,
        status: "dispatched",
      };
    },
    async stopWorker(cwd, input) {
      const capture = captureStream();
      const exitCode = await stopCommand(
        ["--worker", input.worker],
        cwd,
        capture.stream,
      );
      return {
        ...(parsedCommandOutput(capture.text(), exitCode, "toon") as object),
        recycle: input.recycle,
      };
    },
    requeue: (input) => runtime.executeRequeue(root, input),
    async retake(input) {
      const args = [String(input.issue), "--json"];
      if (input.repo) args.push("--repo", input.repo);
      if (input.prLimit) args.push("--pr-limit", String(input.prLimit));
      const capture = captureStream();
      const exitCode = await retakeCommand(args, root, capture.stream);
      return parsedCommandOutput(capture.text(), exitCode, "json");
    },
    async reap() {
      const context = await resolveRepoContext(root);
      const inputs = await collectReapInputs(context);
      const nowS = Math.floor(Date.now() / 1_000);
      const remotePlan = planLiveBranchCleanup(
        inputs.remoteLiveRefs,
        inputs.lookup,
        nowS,
      );
      const localPlan = planLocalBranchCleanup(
        inputs.localLiveRefs,
        inputs.lookup,
        nowS,
      );
      const remoteReaped = branchesToReap(remotePlan).map((item) => item.branch);
      const localReaped = branchesToReap(localPlan).map((item) => item.branch);
      for (const branch of remoteReaped) await inputs.deleteRemote(branch);
      for (const branch of localReaped) await inputs.deleteLocal(branch);
      return {
        remote_found: inputs.remoteLiveRefs.length,
        local_found: inputs.localLiveRefs.length,
        remote_reaped: remoteReaped,
        local_reaped: localReaped,
      };
    },
    async unblockSweep() {
      const context = await resolveRepoContext(root);
      const gh = { cwd: context.root, repo: context.repo };
      const candidates = await ghx.listUnblockCandidates(gh);
      const promoted = await executeUnblockSweep(
        candidates,
        async (issue) => ((await ghx.issueClosed(gh, issue)) ? "CLOSED" : "OPEN"),
        {
          editLabels: async (issue, remove, add) => {
            await ghx.editLabels(gh, issue, remove, add);
          },
          comment: (issue, body) => ghx.comment(gh, issue, body),
          issueReference: (issue) => ghx.issueReference(gh, issue),
        },
      );
      return { promoted };
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
  operations: DevAfkMcpOperations = createDefaultDevAfkMcpOperations(root),
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
    workerDispatch: (input) => {
      if (input.issue !== undefined) {
        return operations.dispatchIssue(root, {
          ...input,
          issue: input.issue,
        });
      }
      if (input.demand !== undefined) {
        return operations.dispatchDemand(root, {
          ...input,
          demand: input.demand,
        });
      }
      throw new Error("worker dispatch requires an issue or demand");
    },
    workerStatus: async ({ worker }) => {
      const workers = await workerVitals(root);
      return worker === undefined
        ? workers
        : workers.filter((record) => record.worker.id === worker);
    },
    workerStop: (input) => operations.stopWorker(root, input),
    runnerList: async () =>
      Object.fromEntries(
        Object.entries(RUNNER_SPECS).map(([runner, spec]) => [
          runner,
          {
            efforts: spec.efforts,
            channel: spec.channel,
            factory: spec.factory,
            ...(spec.forcedModel ? { forced_model: spec.forcedModel } : {}),
            ...(spec.defaultEffort
              ? { default_effort: spec.defaultEffort }
              : {}),
            structured_output: spec.structuredOutput === true,
            auth_env: spec.resolveAuthEnv !== undefined,
          },
        ]),
      ),
    runnerDetect: async ({ runner }) => detectRunner({ flag: runner }),
    workerRequest: (input: WorkerRequestInput) => {
      const dispatch = { ...input, request: input.text };
      delete (dispatch as Partial<WorkerRequestInput>).text;
      if (dispatch.issue !== undefined) {
        return operations.dispatchIssue(root, {
          ...dispatch,
          issue: dispatch.issue,
        });
      }
      if (dispatch.demand !== undefined) {
        return operations.dispatchDemand(root, {
          ...dispatch,
          demand: dispatch.demand,
        });
      }
      throw new Error("worker request requires an issue or demand");
    },
    requeue: (input) => operations.requeue(input),
    retake: (input) => operations.retake(input),
    reap: () => operations.reap(),
    unblockSweep: () => operations.unblockSweep(),
  };
}
