import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { logsDir, waitsDir, worktreesDir } from "@reddb-io/shared/red-paths.js";
import { Writable } from "node:stream";
import { decode as decodeToon } from "@reddb-io/toon";
import {
  castleLanePath,
  createCastleLaneWriters,
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
  type CastleLaneRecord,
  type FleetProfile,
} from "@reddb-io/red-castle/engine";
import type {
  CascadeStatusInput,
  CastleMcpDependencies,
  ClaimIssueInput,
  DailyReviewInput,
  EventsSinceInput,
  FleetCreateInput,
  FleetEditInput,
  FleetNameInput,
  FleetRegisterInput,
  GateRunInput,
  LandBranchInput,
  LogsInput,
  RequeueToolInput,
  RespondToolInput,
  RetakeToolInput,
  WaitStartInput,
  WaitStatusInput,
  TriageToolInput,
  WeeklyReviewInput,
  WorkerDispatchInput,
  WorkerRequestInput,
  WorkerSteerInput,
  WorkerStopInput,
  WorktreeRemoveInput,
} from "../../../packages/red-castle/src/mcp-server.js";
import { listWaits as listRspWaits } from "../../rsp/src/wait/registry.js";
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
  collectStatuslineAfk,
  collectStatuslineDocs,
  collectStatuslineFleet,
  collectStatuslineRepo,
  collectStatuslineWorkers,
  inferGitHubRepoSlug,
  readFleetState,
  resolveRepoContext,
} from "./runtime/wire.js";
import { readAllWorkerStates } from "./core/worker-state-reader.js";
import { resolveProject } from "./commands/statusline.js";
import { stopCommand } from "./commands/stop.js";
import { executeRequeue } from "./commands/requeue.js";
import { retakeCommand } from "./commands/retake.js";
import {
  dispatchGo,
  type DisposableIssueSpec,
} from "./core/go.js";
import {
  getConfig,
  loadConfig,
  readBackpressure,
  readValidationResourceBudget,
} from "./core/config.js";
import * as gitx from "./runtime/git.js";
import { makeFeedbackWorktree } from "./runtime/feedback-worktree.js";
import { relevantScopes, runFeedback } from "./core/feedback.js";
import { doLanding } from "./core/landing.js";
import { dispatchHooks, type HookExec } from "./core/hook-dispatcher.js";
import { resolveHooks } from "./core/hook-config.js";
import { makeHookExec, makeHookResolveOptions } from "./runtime/hooks.js";
import {
  parseClaimRecords,
  renderClaimComment,
  type ClaimRecord,
} from "./core/claim.js";
import { parseReqLabels, planCloseCascade, type DependentIssue } from "./core/boot-sweep.js";
import {
  branchesToReap,
  planLiveBranchCleanup,
  planLocalBranchCleanup,
} from "./core/branch-cleanup.js";
import { executeUnblockSweep } from "./core/boot-sweep.js";
import { collectReapInputs } from "./runtime/wire/reap.js";
import { activityReviewCommand } from "./commands/activity-review.js";
import { triageCommand } from "./commands/triage.js";
import { respondCommand } from "./commands/respond.js";
import {
  ResidentReadCache,
  QUEUE_STATUS_KEY,
  claimStatusKey,
  cascadeStatusKey,
} from "./resident-read-cache.js";

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
  gateRun(input: GateRunInput): Promise<unknown>;
  landBranch(input: LandBranchInput): Promise<unknown>;
  cascadeStatus(input: CascadeStatusInput): Promise<unknown>;
  claimStatus(input: ClaimIssueInput): Promise<unknown>;
  claimRelease(input: ClaimIssueInput): Promise<unknown>;
  waitStart(input: WaitStartInput): Promise<unknown>;
  dailyReview(input: DailyReviewInput): Promise<unknown>;
  weeklyReview(input: WeeklyReviewInput): Promise<unknown>;
  triage(input: TriageToolInput): Promise<unknown>;
  respond(input: RespondToolInput): Promise<unknown>;
}

export interface DevAfkMcpRuntime {
  launchRun(root: string, args: readonly string[]): Promise<{ pid: number; log?: string }>;
  /** Spawn rsp wait detached; returns the child PID. */
  launchRspWait(args: readonly string[], cwd: string): Promise<number>;
  ensureLabel(root: string, name: string): Promise<void>;
  createIssue(root: string, spec: DisposableIssueSpec): Promise<number>;
  executeRequeue(root: string, input: RequeueToolInput): Promise<unknown>;
  /** Injected in tests to intercept hook execution without spawning a shell. */
  hookExec?: HookExec;
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

/** Where a detached worker's boot stdout/stderr is persisted, in the disposable
 * logs lane (ADR 0098). A worker that dies before it writes its own state used
 * to leave nothing but `worker.pid` — three silent spawn deaths in a row with
 * zero evidence anywhere (#2385, #2376). The dispatch keeps the bytes. */
export function dispatchLogPath(root: string, stampIso: string): string {
  const safe = stampIso.replace(/[:.]/g, "-");
  return join(logsDir(root, stampIso.slice(0, 10)), `dispatch-${safe}.log`);
}

async function launchDetachedRun(
  root: string,
  args: readonly string[],
): Promise<{ pid: number; log?: string }> {
  const mcpBundle = process.argv[1];
  if (!mcpBundle) {
    throw new Error("cannot dispatch worker: MCP bundle path is missing");
  }
  const bundle = resolveDevCliBundle(mcpBundle);
  if (!existsSync(bundle)) {
    throw new Error("cannot dispatch worker: sibling dev bundle is missing");
  }
  // Capture boot stdout+stderr to a discoverable file. Best-effort: if the log
  // cannot be opened, the dispatch still runs (with the old blind stdio) rather
  // than failing over an observability concern.
  const logFile = dispatchLogPath(root, `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`);
  let fd: number | undefined;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    fd = openSync(logFile, "a");
  } catch {
    fd = undefined;
  }
  try {
    const child = spawn(process.execPath, [bundle, "run", ...args], {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: fd === undefined ? "ignore" : ["ignore", fd, fd],
    });
    const pid = child.pid;
    if (!pid) throw new Error("cannot dispatch worker: spawn returned no pid");
    child.unref();
    return { pid, log: fd === undefined ? undefined : logFile };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function resolveDevCliBundle(mcpBundle: string): string {
  const file = basename(mcpBundle);
  if (file === "castle-mcp.bundle.min.mjs") {
    return join(dirname(mcpBundle), "dev.bundle.min.mjs");
  }
  if (file.startsWith("castle-mcp-") && file.endsWith(".bundle.min.mjs")) {
    return join(dirname(mcpBundle), file.replace(/^castle-mcp-/, "dev-"));
  }
  throw new Error(
    `cannot dispatch worker: unrecognized MCP bundle name ${JSON.stringify(file)}`,
  );
}

export function resolveRspCliBundle(mcpBundle: string): string {
  const file = basename(mcpBundle);
  if (file === "castle-mcp.bundle.min.mjs") {
    return join(dirname(mcpBundle), "rsp.bundle.min.mjs");
  }
  if (file.startsWith("castle-mcp-") && file.endsWith(".bundle.min.mjs")) {
    return join(dirname(mcpBundle), file.replace(/^castle-mcp-/, "rsp-"));
  }
  throw new Error(
    `cannot spawn rsp wait: unrecognized MCP bundle name ${JSON.stringify(file)}`,
  );
}

async function launchDetachedRspWait(
  args: readonly string[],
  cwd: string,
): Promise<number> {
  const mcpBundle = process.argv[1];
  if (!mcpBundle) {
    throw new Error("cannot spawn rsp wait: MCP bundle path is missing");
  }
  const bundle = resolveRspCliBundle(mcpBundle);
  if (!existsSync(bundle)) {
    throw new Error("cannot spawn rsp wait: sibling rsp bundle is missing");
  }
  const child = spawn(process.execPath, [bundle, ...args], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (!pid) throw new Error("cannot spawn rsp wait: spawn returned no pid");
  child.unref();
  return pid;
}

function buildWaitArgs(
  kind: WaitStartInput["kind"],
  target: string,
  resultFile: string,
  opts: { timeout_ms?: number; reason?: string },
): string[] {
  const args: string[] = ["wait", kind];
  if (kind !== "cmd" && kind !== "release") {
    args.push(target);
  }
  if (kind === "release" && target !== "*") {
    args.push("--tag", target);
  }
  if (opts.timeout_ms !== undefined) args.push("--timeout", String(opts.timeout_ms));
  if (opts.reason) args.push("--reason", opts.reason);
  args.push("--result-file", resultFile);
  if (kind === "cmd") {
    args.push("--", target);
  }
  return args;
}

const defaultMcpRuntime: DevAfkMcpRuntime = {
  launchRun: launchDetachedRun,
  launchRspWait: launchDetachedRspWait,
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

/** Resolve the base branch a gate/landing runs against: explicit input first,
 * then the configured trunk, then `main`. */
function resolveConfiguredBase(root: string, base?: string): string {
  if (base) return base;
  const config = loadConfig(afkPaths(root).configPath, { warn: () => undefined });
  return getConfig(config, "dev.trunk") || "main";
}

/** Fold claim markers to the LATEST record per worker — the same
 * highest-comment-id-wins order the reconciler uses. */
function latestClaimPerWorker(
  records: readonly ClaimRecord[],
): Map<string, ClaimRecord> {
  const latest = new Map<string, ClaimRecord>();
  for (const record of records) {
    const seen = latest.get(record.worker);
    if (!seen || record.commentId > seen.commentId) latest.set(record.worker, record);
  }
  return latest;
}

/**
 * Build the `fireHook` closure used by MCP-initiated landings.
 * Resolves the configured hook command list once at call time, then dispatches
 * via `dispatchHooks` on each invocation. Exported for direct unit-testing with
 * an injected `HookExec` fake.
 */
export function buildMcpLandingFireHook(
  root: string,
  exec: HookExec,
): (name: "pre_merge" | "post_merge", context: string) => Promise<boolean> {
  const paths = afkPaths(root);
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const resolveOptions = makeHookResolveOptions(root);
  const resolved = resolveHooks(config, resolveOptions);
  return async (name, context) => {
    const result = await dispatchHooks(name, resolved[name], context, exec);
    return !result.aborted;
  };
}

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
        // Post-mortem handle for a worker that dies before writing its own
        // state (#2385): its boot stdout/stderr lands here.
        worker_log: launch.log,
        status: "dispatched",
      };
    },
    async dispatchDemand(cwd, input) {
      let workerPid: number | undefined;
      let workerLog: string | undefined;
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
            workerLog = launch.log;
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
        worker_log: workerLog,
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
    async gateRun(input) {
      const paths = afkPaths(root);
      const config = loadConfig(paths.configPath, { warn: () => undefined });
      const base = resolveConfiguredBase(root, input.base);
      const feedback = makeFeedbackWorktree(
        root,
        paths.feedbackWorktreesDir,
        undefined,
        { resourceBudget: readValidationResourceBudget(config) },
      );
      try {
        const changedFiles = await gitx.changedFiles({ cwd: root }, input.branch, base);
        const result = await runFeedback(feedback.pnpm, {
          worktree: input.branch,
          scopes: relevantScopes(feedback.layout, changedFiles),
          layout: feedback.layout,
          now: () => Date.now(),
          baselineWorktree: base,
        });
        return {
          branch: input.branch,
          base,
          ok: result.ok,
          changed_files: changedFiles,
          checks: result.checks.map((check) => ({
            name: check.name,
            script: check.script,
            scope: check.scope,
            status: check.status,
          })),
          baseline_probe_ran: result.baselineProbeRan === true,
          baseline_verdict: result.baselineVerdict ?? null,
          baseline_inconclusive: result.baselineInconclusive,
        };
      } finally {
        await feedback.cleanup();
      }
    },
    async landBranch(input) {
      const context = await resolveRepoContext(root);
      const paths = afkPaths(root);
      const gitCtx: gitx.GitContext = { cwd: root };
      const base = resolveConfiguredBase(root, input.base);
      const changedFiles = await gitx.changedFiles(gitCtx, input.branch, base);
      const slug = (value: string) =>
        value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "base";
      const fireHook = buildMcpLandingFireHook(root, runtime.hookExec ?? makeHookExec(root));
      const result = await doLanding(
        {
          mergeExec: gitx.mergeExec(gitCtx),
          remoteGit: gitx.gitExec(gitCtx),
          fireHook,
          makeLandingWorktree: async (target) => {
            const dest = join(paths.landingWorktreesDir, `${slug(target)}-mcp-${input.issue}`);
            await gitx.worktreeRemove(gitCtx, dest);
            return (await gitx.worktreeAdd(gitCtx, dest, target)).ok ? dest : null;
          },
          removeLandingWorktree: (dir) => gitx.worktreeRemove(gitCtx, dir),
          makeRebaseWorktree: async (branch) => {
            const dest = join(paths.rebaseWorktreesDir, `${slug(branch)}-mcp-${input.issue}`);
            await gitx.worktreeRemove(gitCtx, dest);
            return (await gitx.worktreeAdd(gitCtx, dest, branch)).ok ? dest : null;
          },
          removeRebaseWorktree: (dir) => gitx.worktreeRemove(gitCtx, dir),
        },
        {
          openPr: input.openPr !== false,
          locked: false,
          repo: context.repo,
          repoDir: root,
          remote: context.remote,
          branch: input.branch,
          base,
          trunk: base,
          issue: input.issue,
          title: input.title ?? `Issue #${input.issue}`,
          changedFiles,
        },
        {
          preMerge: () =>
            JSON.stringify({
              issue: { number: input.issue, title: input.title ?? `Issue #${input.issue}` },
              workspace: root,
              branch: input.branch,
              merge_base: base,
            }),
          postMerge: (mergeSha) =>
            JSON.stringify({
              issue: { number: input.issue, title: input.title ?? `Issue #${input.issue}` },
              workspace: root,
              branch: input.branch,
              ...(mergeSha ? { merge_commit: { sha: mergeSha, short: mergeSha.slice(0, 7) } } : {}),
            }),
        },
      );
      return { issue: input.issue, branch: input.branch, base, ...result };
    },
    async cascadeStatus(input) {
      const context = await resolveRepoContext(root);
      const gh = { cwd: context.root, repo: context.repo };
      const states = await ghx.listIssueStates(gh);
      const dependents: DependentIssue[] = [];
      for (const [number, row] of states) {
        if (row.state.toUpperCase() !== "OPEN") continue;
        const reqs = parseReqLabels(row.labels);
        if (!reqs.includes(input.issue)) continue;
        dependents.push({
          number,
          reqs: reqs.map((n) => ({
            n,
            closed: (states.get(n)?.state ?? "").toUpperCase() === "CLOSED",
          })),
        });
      }
      return {
        issue: input.issue,
        dependents: dependents.map((dependent) => ({
          number: dependent.number,
          reqs: dependent.reqs,
        })),
        promotable: planCloseCascade(input.issue, dependents).map((plan) => ({
          number: plan.number,
          refs: plan.refs,
          req_labels: plan.reqLabels,
        })),
      };
    },
    async claimStatus(input) {
      const context = await resolveRepoContext(root);
      const gh = { cwd: context.root, repo: context.repo };
      const records = parseClaimRecords(await ghx.listClaimComments(gh, input.issue));
      const latest = latestClaimPerWorker(records);
      const holders = [...latest.values()].filter((record) => record.kind === "claim");
      return {
        issue: input.issue,
        records: records.map((record) => ({
          comment_id: record.commentId,
          worker: record.worker,
          kind: record.kind,
          runner: record.runner ?? "",
          created_at: record.createdAt ?? "",
        })),
        holders: holders.map((record) => ({
          worker: record.worker,
          comment_id: record.commentId,
          runner: record.runner ?? "",
          created_at: record.createdAt ?? "",
        })),
      };
    },
    async claimRelease(input) {
      const context = await resolveRepoContext(root);
      const gh = { cwd: context.root, repo: context.repo };
      const records = parseClaimRecords(await ghx.listClaimComments(gh, input.issue));
      const holders = [...latestClaimPerWorker(records).values()].filter(
        (record) => record.kind === "claim",
      );
      const conceded: string[] = [];
      for (const holder of holders) {
        await ghx.postClaimComment(
          gh,
          input.issue,
          renderClaimComment({ worker: holder.worker, runner: holder.runner }, "concede", "released"),
        );
        conceded.push(holder.worker);
      }
      return { issue: input.issue, conceded };
    },
    async waitStart(input) {
      const id = randomUUID();
      const resultFile = join(waitsDir(root), `${id}.toon`);
      const args = buildWaitArgs(input.kind, input.target, resultFile, {
        timeout_ms: input.timeout_ms,
        reason: input.reason,
      });
      const pid = await runtime.launchRspWait(args, root);
      return { id, pid, result_file: resultFile, status: "spawned" };
    },
    async dailyReview(_input) {
      const capture = captureStream();
      const exitCode = await activityReviewCommand("daily", [], root, capture.stream);
      return parsedCommandOutput(capture.text(), exitCode, "toon");
    },
    async weeklyReview(_input) {
      const capture = captureStream();
      const exitCode = await activityReviewCommand("weekly", [], root, capture.stream);
      return parsedCommandOutput(capture.text(), exitCode, "toon");
    },
    async triage(input) {
      const args: string[] = [String(input.issue), "--decision", input.decision, "--json"];
      if (input.summon) args.push("--summon");
      if (input.repo) args.push("--repo", input.repo);
      const capture = captureStream();
      const exitCode = await triageCommand(args, root, capture.stream);
      return parsedCommandOutput(capture.text(), exitCode, "json");
    },
    async respond(input) {
      const args: string[] = ["--body", input.body, "--number", String(input.number)];
      if (input.author) args.push("--author", input.author);
      if (input.is_pr) args.push("--is-pr");
      if (input.runner) args.push("--runner", input.runner);
      if (input.repo) args.push("--repo", input.repo);
      const capture = captureStream();
      const exitCode = await respondCommand(args, root, capture.stream);
      return parsedCommandOutput(capture.text(), exitCode, "toon");
    },
  };
}

async function waitStatusImpl(root: string, input: WaitStatusInput): Promise<unknown> {
  const resultFile = join(waitsDir(root), `${input.id}.toon`);
  try {
    const raw = await readFile(resultFile, "utf8");
    const trimmed = raw.trim();
    if (trimmed) {
      return { id: input.id, status: "finished", result: decodeToon(trimmed) };
    }
  } catch {
    // result file not present — wait is still running or never started
  }
  const active = await listRspWaits(root);
  return { id: input.id, status: "running", waits: active };
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
  // Build a PID set for the slot-pid fallback: workers without a fleet stamp
  // (legacy or pre-stamp) are attributed to this fleet if their pid appears in
  // the supervisor's slot map. Workers with a stamp that differs from this fleet
  // name go to the unattributed bucket even if their pid matches.
  const fleetPidSet = new Set(
    (fleet?.slotPids ?? []).map((sp) => sp.pid).filter((pid) => pid > 0),
  );
  const allLiveWorkers = monitor.workers.filter(
    (worker) => worker.pidLive === true || worker.live,
  );
  function attributedToThisFleet(worker: (typeof allLiveWorkers)[number]): boolean {
    const stampedFleet = worker.state.fleet;
    // Stamped workers: use the stamp as the definitive source of truth.
    if (stampedFleet !== undefined) return stampedFleet === paths.fleet;
    // Legacy/unstamped workers: fall back to the supervisor's slot-pid map.
    return fleetPidSet.has(worker.state.pid);
  }
  const liveWorkers = allLiveWorkers.filter(attributedToThisFleet);
  const unattributedWorkers = allLiveWorkers.filter((w) => !attributedToThisFleet(w));
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
    unattributed_workers: unattributedWorkers.map((worker) => ({
      id: worker.state.worker_id,
      pid: worker.state.pid,
      issue: String(worker.state.current.number),
      activity: worker.state.current.activity,
      origin: worker.state.origin ?? "afk",
      fleet: worker.state.fleet ?? null,
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
  let supervisorLogStart: number | undefined;
  try {
    supervisorLogStart = (await stat(paths.supervisorLogPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      supervisorLogStart = 0;
    }
  }
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
    let rollbackConfirmed = false;
    try {
      const removed = await removeFleetProfile(path, profile.name);
      rollbackConfirmed =
        removed || (await readFleetProfile(path, profile.name)) === undefined;
    } catch {
      // The failure below must not claim that registry rollback succeeded.
    }
    let tail = "";
    if (supervisorLogStart !== undefined) {
      try {
        const bytes = await readFile(paths.supervisorLogPath);
        const launchBytes =
          bytes.length < supervisorLogStart
            ? bytes
            : bytes.subarray(supervisorLogStart);
        tail = launchBytes
          .toString("utf8")
          .split(/\r?\n/)
          .slice(-20)
          .join("\n");
      } catch {
        // The explicit no-output marker below still distinguishes an empty boot
        // from a caller-visible but unexplained registry rollback.
      }
    }
    const evidence = tail || "(no supervisor log output was captured)";
    const rollback = rollbackConfirmed
      ? "profile rolled back."
      : "profile rollback was attempted but could not be confirmed.";
    throw new Error(
      `fleet ${JSON.stringify(profile.name)} failed to start: supervisor pid file did not appear; ` +
        `${rollback} log: .red/tmp/supervisors/${paths.fleet}/supervisor.log.toonl\n${evidence}`,
    );
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

const LOGS_DEFAULT_LIMIT = 200;

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
  const records = await readCastleLaneRecords(path);
  const filtered =
    input.kind !== undefined
      ? records.filter((r) => r.kind === input.kind)
      : records;
  const limit = input.limit ?? LOGS_DEFAULT_LIMIT;
  return filtered.length <= limit ? filtered : filtered.slice(-limit);
}

async function workerVitals(root: string, opts: { live_only?: boolean } = {}) {
  const records = await readAllWorkerStates(afkPaths(root).tmpDir);
  const all = records.map(({ state, ...record }) => ({
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
        model: state.current.model,
        effort: state.current.effort,
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
  return opts.live_only !== false ? all.filter((r) => r.live === true) : all;
}

function projectFields(
  records: Array<Record<string, unknown>>,
  fields: string[] | undefined,
): unknown[] {
  if (!fields || fields.length === 0) return records;
  const fieldSet = new Set(fields);
  return records.map((r) => {
    const out: Record<string, unknown> = {};
    for (const key of fieldSet) {
      if (Object.prototype.hasOwnProperty.call(r, key)) out[key] = r[key];
    }
    return out;
  });
}

/** Every checkout under the disposable `.red/tmp/worktrees/<lane>/` lanes, in
 * lane-then-name order. A missing lane root is an empty list, not an error. */
async function listDisposableWorktrees(root: string) {
  const { readdir } = await import("node:fs/promises");
  const worktreesRoot = worktreesDir(root);
  const lanes = await readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
  const out: { lane: string; name: string; path: string }[] = [];
  for (const lane of lanes.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const entries = await readdir(join(worktreesRoot, lane.name), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({
        lane: lane.name,
        name: entry.name,
        path: relative(root, join(worktreesRoot, lane.name, entry.name)),
      });
    }
  }
  return out;
}

/** Remove ONE checkout under the disposable worktree lanes. A path that escapes
 * `.red/tmp/worktrees/` is refused — the tool never removes a real checkout. */
async function removeDisposableWorktree(root: string, input: WorktreeRemoveInput) {
  const worktreesRoot = resolve(worktreesDir(root));
  const target = resolve(root, input.path);
  const rel = relative(worktreesRoot, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("worktree path escapes the disposable worktree lanes");
  }
  await gitx.worktreeRemove({ cwd: root }, target);
  return { path: relative(root, target), removed: !existsSync(target) };
}

/**
 * The castle-side statusline aggregate, assembled from the SAME collector cores
 * the command-backed `statusline` render path uses — `resolveProject`,
 * `collectStatuslineRepo`, `collectStatuslineDocs`, `collectStatuslineAfk`,
 * `collectStatuslineFleet` — plus the `fleet_status` and `worker_vitals`
 * projections, so the tool never grows a parallel implementation.
 *
 * Every collector reads local state or the TTL cache the collectors already
 * own (ADR 0084: no synchronous network fetch in a render path), so this tool
 * is as cheap as one statusline tick.
 *
 * Host-side render inputs (session model/effort, context %, 5h/7d usage) come
 * from the Claude Code statusline stdin payload and are deliberately absent —
 * the tool must not fake them.
 */
export async function collectStatuslineAggregate(root: string) {
  const repoCtx = {
    root,
    repo: inferGitHubRepoSlug(root),
    remote: "origin",
  };

  const [project, repoStats, docs, afkBlock, fleetChip, fleet, workers] =
    await Promise.all([
      resolveProject(root),
      collectStatuslineRepo(repoCtx),
      collectStatuslineDocs(repoCtx).catch(() => undefined),
      collectStatuslineAfk(repoCtx).catch(() => null),
      collectStatuslineFleet(repoCtx).catch(() => undefined),
      fleetStatus(root, {}).catch(() => null),
      workerVitals(root),
    ]);

  return {
    project: {
      basename: project.basename,
      branch: project.branch || null,
      detached_sha: project.detachedSha ?? null,
      version: project.version ?? readBuildInfo("dev").version,
      latest_cached_version: project.latestCachedVersion ?? null,
      pointer_version: project.pointerVersion ?? null,
      docs_unlanded: docs?.count ?? 0,
    },
    repo: {
      open_prs: repoStats.openPrs ?? 0,
      today_prs: repoStats.todayPrs ?? 0,
      open_issues: repoStats.openIssues ?? 0,
      local_added: repoStats.localAdded ?? 0,
      local_removed: repoStats.localRemoved ?? 0,
      cache_age_s: repoStats.cacheAgeS ?? null,
    },
    docs: { unlanded: docs?.count ?? 0 },
    fleet,
    /** The repo-summary fleet CHIP the header line renders: the two facts the
     * `fleet_status` snapshot does not carry (supervisor-reported queue depth
     * and the busy-but-no-fresh-worker `degraded` marker), from the statusline
     * fleet collector. Null when no fresh supervisor snapshot exists. */
    fleet_chip: fleetChip
      ? {
          runner: fleetChip.runner,
          busy: fleetChip.busy,
          total: fleetChip.total,
          queue: fleetChip.queue,
          parked: fleetChip.parked ?? 0,
          degraded: fleetChip.degraded ?? false,
          churn_deaths: fleetChip.churnDeaths ?? 0,
          churn_respawns: fleetChip.churnRespawns ?? 0,
          churn_window_s: fleetChip.churnWindowS ?? 0,
          bundle_version: fleetChip.bundleVersion ?? null,
        }
      : null,
    workers,
    /** The aggregated AFK block exactly as the plain single-line form renders
     * it — summed across live workers, including the fleet runner/model/effort
     * label the per-worker rows carry individually. Null when no live worker. */
    afk: afkBlock,
    queue: {
      ready_for_agent: afkBlock?.queue ?? 0,
      ready_for_human: afkBlock?.human ?? 0,
      cache_age_s: afkBlock?.cacheAgeS ?? null,
    },
  };
}

/** The `statusline_aggregate` payload contract, inferred from its single
 * producer so a field-coverage test can pin the shape without restating it. */
export type StatuslineAggregate = Awaited<
  ReturnType<typeof collectStatuslineAggregate>
>;

async function registerFleet(root: string, input: FleetRegisterInput) {
  const path = registryPath(root);
  const paths = afkPaths(root, input.name);
  const running = await discoverLiveSupervisorPid(
    paths.supervisorRuntimeDir,
    isLivePid,
    { fleet: paths.fleet },
  );
  if (!running) {
    throw new Error(`fleet ${JSON.stringify(paths.fleet)} is not running`);
  }
  const profile = await upsertFleetProfile(path, {
    name: paths.fleet,
    runner: input.runner,
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.config ? { config: input.config } : {}),
    ...(input.base ? { base: input.base } : {}),
  });
  return { status: "registered", profile, pid: running.pid };
}

const CURSOR_VERSION = 1;
const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function encodeCursor(at: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, at })).toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string,
): { at: string } | { refused: true; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return {
      refused: true,
      reason:
        "Unknown cursor format; call queue_status or worker_status to re-baseline.",
    };
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).v !== CURSOR_VERSION ||
    typeof (raw as Record<string, unknown>).at !== "string"
  ) {
    return {
      refused: true,
      reason:
        "Unknown cursor format; call queue_status or worker_status to re-baseline.",
    };
  }
  const at = (raw as Record<string, unknown>).at as string;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs) || Date.now() - atMs > CURSOR_MAX_AGE_MS) {
    return {
      refused: true,
      reason:
        "Cursor expired; call queue_status or worker_status to re-baseline.",
    };
  }
  return { at };
}

async function readAllWorkerLaneRecordsSince(
  paths: ReturnType<typeof createEnginePaths>,
  since: string,
): Promise<CastleLaneRecord[]> {
  const { readdir } = await import("node:fs/promises");
  let ids: string[];
  try {
    ids = (await readdir(paths.workersRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const records: CastleLaneRecord[] = [];
  for (const id of ids) {
    const lanePath = castleLanePath(paths, "worker", id);
    const workerRecords = await readCastleLaneRecords(lanePath);
    records.push(...workerRecords.filter((r) => r.at >= since));
  }
  return records;
}

async function eventsSinceImpl(
  root: string,
  input: EventsSinceInput,
): Promise<unknown> {
  if (input.cursor === undefined) {
    return { history: [], lane_records: [], cursor: encodeCursor(new Date().toISOString()) };
  }
  const decoded = decodeCursor(input.cursor);
  if ("refused" in decoded) return decoded;

  const { at: since } = decoded;
  const paths = createEnginePaths(join(root, ".red"));
  const [historyRecords, laneRecords] = await Promise.all([
    readCastleHistoryRecords(paths.castleHistory),
    readAllWorkerLaneRecordsSince(paths, since),
  ]);

  return {
    history: historyRecords.filter((r) => r.ts >= since),
    lane_records: laneRecords,
    cursor: encodeCursor(new Date().toISOString()),
  };
}

/**
 * Wrap the GitHub-backed read deps with a short-TTL cache. Repeated calls
 * within the TTL cost zero GitHub requests. Mutating tools invalidate the
 * affected keys so the next read reflects the new state immediately.
 *
 * Exported for unit-testing the cache wiring with fake deps.
 */
export function withCachedDeps(
  deps: CastleMcpDependencies,
  cache: ResidentReadCache,
): CastleMcpDependencies {
  return {
    ...deps,
    queueStatus: async () => {
      const cached = cache.get(QUEUE_STATUS_KEY);
      if (cached !== undefined) return cached;
      const result = await deps.queueStatus();
      cache.set(QUEUE_STATUS_KEY, result);
      return result;
    },
    claimStatus: async (input) => {
      const key = claimStatusKey(input.issue);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const result = await deps.claimStatus(input);
      cache.set(key, result);
      return result;
    },
    cascadeStatus: async (input) => {
      const key = cascadeStatusKey(input.issue);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const result = await deps.cascadeStatus(input);
      cache.set(key, result);
      return result;
    },
    claimRelease: async (input) => {
      cache.invalidate(claimStatusKey(input.issue));
      return deps.claimRelease(input);
    },
    landBranch: async (input) => {
      cache.invalidate(cascadeStatusKey(input.issue));
      return deps.landBranch(input);
    },
    requeue: async (input) => {
      cache.invalidate(QUEUE_STATUS_KEY);
      return deps.requeue(input);
    },
    unblockSweep: async () => {
      cache.invalidate(QUEUE_STATUS_KEY);
      return deps.unblockSweep();
    },
    triage: async (input) => {
      cache.invalidate(QUEUE_STATUS_KEY);
      return deps.triage(input);
    },
  };
}

export function createCastleMcpDependencies(
  root = process.cwd(),
  operations: DevAfkMcpOperations = createDefaultDevAfkMcpOperations(root),
): CastleMcpDependencies {
  const baseDeps: CastleMcpDependencies = {
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
    fleetRegister: (input) => registerFleet(root, input),
    logs: (input) => laneLogs(root, input),
    workerVitals: async (input) => {
      const records = await workerVitals(root, { live_only: input.live_only });
      return projectFields(records as Array<Record<string, unknown>>, input.fields);
    },
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
    workerStatus: async ({ worker, live_only, fields }) => {
      const records = await workerVitals(root, { live_only });
      const filtered = worker === undefined
        ? records
        : records.filter((record) => record.worker.id === worker);
      return projectFields(filtered as Array<Record<string, unknown>>, fields);
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
    runnerSteer: async (input: WorkerSteerInput) => {
      const paths = createEnginePaths(join(root, ".red"));
      const steerPath = paths.workerSteerFile(input.worker);
      const { writeFile: writeFileAsync, mkdir: mkdirAsync } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdirAsync(dirname(steerPath), { recursive: true });
      const { encode } = await import("@reddb-io/toon");
      await writeFileAsync(steerPath, encode({ text: input.text }), "utf8");
      const writers = createCastleLaneWriters(paths);
      await writers.worker(input.worker).append({
        kind: "worker.steered",
        worker_id: input.worker,
        payload: { reason: input.text.slice(0, 200) },
      });
      return { worker: input.worker, steer: "written" };
    },
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
    gateRun: (input) => operations.gateRun(input),
    landBranch: (input) => operations.landBranch(input),
    cascadeStatus: (input) => operations.cascadeStatus(input),
    claimStatus: (input) => operations.claimStatus(input),
    claimRelease: (input) => operations.claimRelease(input),
    worktreeList: () => listDisposableWorktrees(root),
    worktreeRemove: (input) => removeDisposableWorktree(root, input),
    waitStart: (input) => operations.waitStart(input),
    waitList: () => listRspWaits(root),
    waitStatus: (input) => waitStatusImpl(root, input),
    dailyReview: (input) => operations.dailyReview(input),
    weeklyReview: (input) => operations.weeklyReview(input),
    triage: (input) => operations.triage(input),
    respond: (input) => operations.respond(input),
    statuslineAggregate: () => collectStatuslineAggregate(root),
    eventsSince: (input) => eventsSinceImpl(root, input),
  };
  return withCachedDeps(baseDeps, new ResidentReadCache());
}
