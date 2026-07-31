import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { logsDir, waitsDir, worktreesDir } from "@reddb-io/shared/red-paths.js";
import { Writable } from "node:stream";
import { decode as decodeToon } from "@reddb-io/toon";
import {
  armPr,
  castleLanePath,
  createCastleLaneWriters,
  createEnginePaths,
  createFileMergeDriverStore,
  releasePr,
  readCastleHistoryRecords,
  readCastleLaneRecords,
  parseWorkSelector,
  PROJECT_SUPERVISOR_LANE,
  RUNNER_SPECS,
  detectRunner,
  type CastleLaneRecord,
} from "@reddb-io/red-castle/engine";
import type { LivenessStatus } from "@reddb-io/red-castle";
import type {
  CascadeStatusInput,
  CastleMcpDependencies,
  ClaimIssueInput,
  HitlResolveInput,
  DailyReviewInput,
  EventsSinceInput,
  ProjectStartInput,
  ProjectResizeInput,
  ProjectStatusOutput,
  GateRunInput,
  LandBranchInput,
  LogsInput,
  QueueStatusInput,
  QueueStatusOutput,
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
  WorkerSteerStatusInput,
  WorkerStopInput,
  WorkerVitalsOutput,
  WorkerVitalsProjectedOutput,
  WorktreeRemoveInput,
} from "@reddb-io/red-castle/mcp-server";
import { listWaits as listRspWaits } from "../../rsp/src/wait/registry.js";
import { readBuildInfo } from "@reddb-io/build-info";
import { publishedVersionReport, readPublishedBundleVersion } from "./core/published-version.js";
import { collectDashboardReport } from "./commands/dashboard.js";
import { stopFleet, writeResizeRequest } from "./commands/fleet.js";
import {
  classifySupervisor,
  resolveSupervisorConfig,
} from "./core/supervisor.js";
import type { HitlCandidate } from "./core/hitl-selection.js";
import type { IssueCandidate } from "./core/session.js";
import { listCandidates, listHitlCandidates } from "./runtime/gh.js";
import { matchesSelector } from "./core/session.js";
import { resolveHitlDecision } from "./core/hitl-resolve.js";
import * as ghx from "./runtime/gh.js";
import { publishedBundleArgv } from "./runtime/supervisor-entry.js";
import {
  createRedskilledBirthPort,
  redskilledRegistrationRefusal,
} from "./runtime/redskilled-birth.js";
import {
  publishWorkerLiveness,
  readDaemonWorkerSet,
  readSupervisorLiveness,
  resolveWorkerLiveness,
  type DaemonWorkerSet,
} from "./runtime/liveness-anchor.js";
import {
  afkPaths,
  collectMonitorInputs,
  collectStatuslineAfk,
  collectStatuslineDocs,
  collectStatuslineFleet,
  collectStatuslineRepo,
  inferGitHubRepoSlug,
  readFleetState,
  resolveRepoContext,
} from "./runtime/wire.js";
import { readAllWorkerStates } from "./core/worker-state-reader.js";
import { resolveProject } from "./commands/statusline.js";
import { executeStopWorker } from "./commands/stop.js";
import { executeRequeue } from "./commands/requeue.js";
import { executeRetake } from "./commands/retake.js";
import {
  dispatchGo,
  type DisposableIssueSpec,
} from "./core/go.js";
import { dispatchScout as dispatchScoutCore } from "./core/scout.js";
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
import { planBranchReclaim } from "./core/branch-reclaim.js";
import { executeUnblockSweep } from "./core/boot-sweep.js";
import { collectReapInputs } from "./runtime/wire/reap.js";
import { collectActivityReview } from "./commands/activity-review.js";
import { executeTriage } from "./commands/triage.js";
import { executeRespond } from "./commands/respond.js";
import {
  ResidentReadCache,
  QUEUE_STATUS_KEY,
  DEADEND_AUDIT_KEY,
  claimStatusKey,
  cascadeStatusKey,
} from "./resident-read-cache.js";
import { collectDeadendAuditReport } from "./runtime/deadend-audit-report.js";

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
  dispatchScout(
    root: string,
    input: { demand: string; runner?: string },
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
  hitlResolve(input: HitlResolveInput): Promise<unknown>;
  mergeArm(input: { pr: number }): Promise<unknown>;
  mergeStatus(): Promise<unknown>;
  mergeRelease(input: { pr: number }): Promise<unknown>;
  waitStart(input: WaitStartInput): Promise<unknown>;
  dailyReview(input: DailyReviewInput): Promise<unknown>;
  weeklyReview(input: WeeklyReviewInput): Promise<unknown>;
  triage(input: TriageToolInput): Promise<unknown>;
  respond(input: RespondToolInput): Promise<unknown>;
  deadendAudit(): Promise<unknown>;
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
          // scout is routed before dispatchDemand is reached — cast to go-mode union
          mode: input.mode as "no-mistakes" | "direct-PR" | "local-only" | undefined,
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
    async dispatchScout(cwd, input) {
      let workerPid: number | undefined;
      let workerLog: string | undefined;
      const result = await dispatchScoutCore(
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
        { runner: input.runner },
      );
      if (workerPid === undefined) {
        throw new Error("cannot dispatch scout: worker was not spawned");
      }
      return {
        kind: "scout",
        demand: input.demand,
        issue: result.issue,
        worker_pid: workerPid,
        worker_log: workerLog,
        status: "dispatched",
      };
    },
    async stopWorker(cwd, input) {
      const result = await executeStopWorker(input.worker, afkPaths(cwd).tmpDir);
      return { ...result, recycle: input.recycle };
    },
    requeue: (input) => runtime.executeRequeue(root, input),
    retake: (input) =>
      executeRetake(
        { issue: input.issue, repo: input.repo, prLimit: input.prLimit },
        { cwd: root },
      ),
    async reap() {
      const context = await resolveRepoContext(root);
      const inputs = await collectReapInputs(context);
      const nowS = Math.floor(Date.now() / 1_000);
      const remotePlan = planLiveBranchCleanup(
        inputs.remoteLiveRefs,
        inputs.lookup,
        nowS,
      );
      // The local pass runs the one reclaim (#2866): it decides on the landed
      // fact and refuses infrastructure refs by name, and it reports its spares
      // so a caller of this tool sees what was kept on purpose.
      const issueClosed = new Set(
        branchesToReap(planLocalBranchCleanup(inputs.localLiveRefs, inputs.lookup, nowS))
          .map((item) => item.branch),
      );
      const landed = new Set(inputs.landedLocalBranches);
      const localPlan = planBranchReclaim(
        inputs.localLiveRefs.map((ref) => ({
          branch: ref.branch,
          landed: landed.has(ref.branch),
          issueClosed: issueClosed.has(ref.branch),
        })),
        { trunk: inputs.trunk },
      );
      const remoteReaped = branchesToReap(remotePlan).map((item) => item.branch);
      const localReaped = localPlan.reclaim.map((item) => item.branch);
      for (const branch of remoteReaped) await inputs.deleteRemote(branch);
      for (const branch of localReaped) await inputs.deleteLocal(branch);
      return {
        remote_found: inputs.remoteLiveRefs.length,
        local_found: inputs.localLiveRefs.length,
        remote_reaped: remoteReaped,
        local_reaped: localReaped,
        local_spared: localPlan.spare.map((item) => ({
          branch: item.branch,
          verdict: item.verdict,
          reason: item.reason,
        })),
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
      const gitCtx: gitx.GitContext = { cwd: root, ghProbeTimeoutMs: 60_000 };
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
    async mergeArm(input: { pr: number }) {
      const store = createFileMergeDriverStore(createEnginePaths(join(root, ".red")));
      const record = await armPr(store, input.pr, Math.floor(Date.now() / 1000));
      return { armed: { pr: record.pr, status: record.status, armed_at_epoch: record.armedAtEpoch } };
    },
    async mergeStatus() {
      const store = createFileMergeDriverStore(createEnginePaths(join(root, ".red")));
      const state = await store.read();
      return {
        prs: Object.values(state.prs).map((record) => ({
          pr: record.pr,
          status: record.status,
          attempts: record.attempts,
          armed_at_epoch: record.armedAtEpoch,
          updated_at_epoch: record.updatedAtEpoch,
          last_state: record.lastState ?? "",
          note: record.note ?? "",
        })),
      };
    },
    async mergeRelease(input: { pr: number }) {
      const store = createFileMergeDriverStore(createEnginePaths(join(root, ".red")));
      const record = await releasePr(store, input.pr, Math.floor(Date.now() / 1000));
      return record === null
        ? { released: null, note: "pr was not owned by the driver" }
        : { released: { pr: record.pr, status: record.status } };
    },
    async claimStatus(input) {
      const context = await resolveRepoContext(root);
      const gh = { cwd: context.root, repo: context.repo };
      const statusOf = async (issue: number) => {
        const records = parseClaimRecords(await ghx.listClaimComments(gh, issue));
        const latest = latestClaimPerWorker(records);
        const holders = [...latest.values()].filter((record) => record.kind === "claim");
        return {
          issue,
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
      };
      // Single-issue form keeps its historic shape; the batch form (#2369) is
      // keyed per issue, with per-issue errors instead of one failed call.
      if (input.issue !== undefined) return statusOf(input.issue);
      const issues = input.issues ?? [];
      if (issues.length === 0) return { error: "provide `issue` or a non-empty `issues`" };
      const byIssue: Record<string, unknown> = {};
      for (const issue of issues) {
        try {
          byIssue[String(issue)] = await statusOf(issue);
        } catch (error) {
          byIssue[String(issue)] = { issue, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return { issues: byIssue };
    },
    async claimRelease(input) {
      const context = await resolveRepoContext(root);
      const gh = { cwd: context.root, repo: context.repo };
      const releaseOf = async (issue: number) => {
        const records = parseClaimRecords(await ghx.listClaimComments(gh, issue));
        const holders = [...latestClaimPerWorker(records).values()].filter(
          (record) => record.kind === "claim",
        );
        const conceded: string[] = [];
        for (const holder of holders) {
          await ghx.postClaimComment(
            gh,
            issue,
            renderClaimComment({ worker: holder.worker, runner: holder.runner }, "concede", "released"),
          );
          conceded.push(holder.worker);
        }
        return { issue, conceded };
      };
      if (input.issue !== undefined) return releaseOf(input.issue);
      const issues = input.issues ?? [];
      if (issues.length === 0) return { error: "provide `issue` or a non-empty `issues`" };
      const byIssue: Record<string, unknown> = {};
      for (const issue of issues) {
        try {
          byIssue[String(issue)] = await releaseOf(issue);
        } catch (error) {
          byIssue[String(issue)] = { issue, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return { issues: byIssue };
    },
    async hitlResolve(input) {
      const context = await resolveRepoContext(root);
      const gh = { cwd: context.root, repo: context.repo };
      return resolveHitlDecision(
        {
          comment: (issue, body) => ghx.comment(gh, issue, body),
          closeIssue: (issue) => ghx.closeIssue(gh, issue),
          viewLabels: (issue) => ghx.viewLabels(gh, issue),
          editLabels: async (issue, remove, add) => {
            await ghx.editLabels(gh, issue, remove, add);
          },
          releaseClaims: async (issue) => {
            const released = (await this.claimRelease({ issue })) as { conceded?: string[] };
            return released.conceded ?? [];
          },
          viewBody: async (issue) => (await ghx.issueBody(gh, issue)) ?? "",
          editBody: async (issue, body) => {
            await ghx.editBody(gh, issue, body);
          },
        },
        input,
      );
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
    dailyReview: (_input) => collectActivityReview("daily", { cwd: root }),
    weeklyReview: (_input) => collectActivityReview("weekly", { cwd: root }),
    triage: (input) =>
      executeTriage(
        { issue: input.issue, decision: input.decision, summon: input.summon, repo: input.repo },
        { cwd: root },
      ),
    respond: (input) =>
      executeRespond(
        {
          body: input.body,
          number: input.number,
          author: input.author,
          isPr: input.is_pr,
          runner: input.runner,
          repo: input.repo,
        },
        { cwd: root },
      ),
    deadendAudit: () => collectDeadendAuditReport(root),
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

/**
 * Concretize a `@me` user facet on an MCP-supplied selector before it reaches a
 * producer or a scoped queue preview, so every selector carries a real login
 * (D2: `@me` never survives past the dispatch boundary).
 */
async function concretizeSelectorUser<T extends { user?: string }>(
  root: string,
  selector: T | undefined,
): Promise<T | undefined> {
  if (!selector || selector.user !== "@me") return selector;
  const context = await resolveRepoContext(root);
  return ghx.resolveSelectorUser(selector, () =>
    ghx.resolveViewerLogin({ cwd: root, repo: context.repo }),
  );
}

async function projectStatus(root: string): Promise<ProjectStatusOutput> {
  const paths = afkPaths(root);
  const now = Math.floor(Date.now() / 1_000);
  const config = resolveSupervisorConfig();
  const [fleet, monitor] = await Promise.all([
    readFleetState(paths.fleetStatePath),
    collectMonitorInputs(root),
  ]);
  // ONE anchor decides identity, liveness AND freshness together (ADR 0128 §5).
  // The snapshot below is read for slots, churn and runner only — never for a
  // second opinion on whether the supervisor is there.
  const supervisor = await readSupervisorLiveness(paths.supervisorRuntimeDir, {
    heartbeatEpoch: fleet?.epoch ?? null,
    staleAfterS: config.supervisorStaleS,
    nowS: now,
  });
  const pid = supervisor.alive ? supervisor.pid : null;
  const health = classifySupervisor(
    {
      pid,
      pidAlive: supervisor.alive,
      lastHeartbeatEpoch: fleet?.epoch ?? null,
      lastProgressEpoch: fleet?.lastProgressEpoch ?? null,
      slotsBusy: fleet?.slotsBusy ?? 0,
    },
    now,
    config.supervisorStaleS,
    config.progressStaleS,
  );
  // Build a PID set for the slot-pid fallback: workers without a lane stamp
  // (legacy or pre-stamp) are attributed to this project if their pid appears in
  // the supervisor's slot map. Workers with a stamp for another lane go to the
  // unattributed bucket even if their pid matches.
  const fleetPidSet = new Set(
    (fleet?.slotPids ?? []).map((sp) => sp.pid).filter((pid) => pid > 0),
  );
  const allLiveWorkers = monitor.workers.filter(
    (worker) => worker.pidLive === true || worker.live,
  );
  function attributedToThisProject(worker: (typeof allLiveWorkers)[number]): boolean {
    const stampedLane = worker.state.fleet;
    // Stamped workers: use the stamp as the definitive source of truth.
    if (stampedLane !== undefined) return stampedLane === PROJECT_SUPERVISOR_LANE;
    // Legacy/unstamped workers: fall back to the supervisor's slot-pid map.
    return fleetPidSet.has(worker.state.pid);
  }
  const liveWorkers = allLiveWorkers.filter(attributedToThisProject);
  const unattributedWorkers = allLiveWorkers.filter((w) => !attributedToThisProject(w));
  // The published version comes from the one owner the boot probe also consults
  // (#2809) — never from the fleet snapshot's stamped copy, which ages with the
  // snapshot and contradicted the path that was halting every Worker boot.
  const version = publishedVersionReport(fleet?.bundleVersion, readPublishedBundleVersion());
  return {
    supervisor: {
      pid: supervisor.pid,
      alive: supervisor.alive,
      health,
      runner: fleet?.runner ?? "",
      target: fleet?.target ?? fleet?.slotsTotal ?? 0,
      bundle_version: fleet?.bundleVersion ?? "",
      // Unknown is its own answer, distinct from `version_skew: 0` — hiding it
      // behind an empty string is what let an unmeasured version read as a
      // measured match (#2752). `published_version` carries the currency of the
      // latest answer, so a cached read cannot render as current (#2809).
      ...version,
      heartbeat_age_s: supervisor.heartbeat.age_s,
      identity_anchor: supervisor.anchor,
      heartbeat: supervisor.heartbeat,
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
    })),
  };
}

/**
 * The one string this project hands the daemon as its work query.
 *
 * The same JSON the launch argv already carried, so the registration and the
 * argv state the selector once rather than twice — two encodings of one query is
 * how a registered project and the Worker born for it start drifting. An absent
 * selector encodes as the empty object: "all this project's ready work" is a
 * query, and a registration that named no work at all would be refused.
 */
function encodeRegistrationSelector(selector: ProjectStartInput["selector"]): string {
  return JSON.stringify(selector ?? {});
}

/**
 * Start work on this project — by REGISTERING it, not by launching it.
 *
 * ADR 0130 Amendment 4's two-player model, from the operator's side: **the MCP
 * registers, the daemon drives.** The project's presence on the machine is the
 * record the daemon holds — a repository identity, an opaque selector, an opaque
 * argv and a target width — and beginning work creates no process of the
 * project's own. The runner, the work scope and the base branch are still the
 * whole request; what changed is who is handed them.
 *
 * **A daemon that does not answer refuses the start** (ADR 0130 rule 6). Falling
 * back to spawning a supervisor here would put a demand producer on the machine
 * that no host admitted, no host counts and no host can stop — precisely the
 * shape the registration exists to end.
 */
async function projectStart(root: string, rawInput: ProjectStartInput) {
  const input: ProjectStartInput = {
    ...rawInput,
    ...(rawInput.selector
      ? { selector: await concretizeSelectorUser(root, rawInput.selector) }
      : {}),
  };
  const paths = afkPaths(root);
  const running = await readSupervisorLiveness(paths.supervisorRuntimeDir);
  if (running.alive) {
    throw new Error(
      "this project's workers are already running; use project_resize to re-aim them or project_status to read them",
    );
  }

  const selector = encodeRegistrationSelector(input.selector);
  // What runs when a Worker is born for this project — resolved from the
  // PUBLISHED bundle, exactly as a supervisor launch resolves it (#2808), so a
  // registration made from a stale plugin cache never commits the host to an
  // older Worker than the one this project publishes.
  const argv = [
    ...publishedBundleArgv(),
    "run",
    "--once",
    "--runner",
    input.runner,
    ...(input.selector ? ["--selector", JSON.stringify(input.selector)] : []),
  ];

  const port = createRedskilledBirthPort({ root });
  let registered;
  try {
    await port.reach();
    // Where a Worker runs, stated rather than derived: the daemon owns the demand
    // loop (ADR 0130 Amendment 4), so it births the Worker itself, and a host that
    // had to work out a working directory would have to know what a checkout looks
    // like — the one thing rule 3 forbids.
    registered = await port.register({ selector, argv, workspace_path: root, target: input.target });
  } catch (err) {
    throw new Error(redskilledRegistrationRefusal(port.socketPath, err));
  }

  return {
    status: "registered",
    project: registered.project_label,
    target: registered.target,
    runner: input.runner,
    selector: registered.selector,
    argv: [...registered.argv],
    socket: port.socketPath,
    renew_by: registered.renew_by,
    ...(input.selector ? { work_selector: input.selector } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    // Stated, never swallowed: the frozen contract carries no environment, and a
    // trunk override travels to a Worker in one. Naming it here keeps a dropped
    // override visible to the operator who asked for it.
    ...(input.base !== undefined
      ? {
          warnings: [
            `the base branch ${JSON.stringify(input.base)} does not travel in a registration yet; ` +
              `a Worker born from it will use this project's configured trunk`,
          ],
        }
      : {}),
  };
}

/**
 * Give this project's registration back — the other half of stopping work.
 *
 * A stop that could not reach the daemon reports it and does NOT raise, unlike a
 * start: refusing to stop would leave an operator holding a project they cannot
 * put down, and the registration lapses on its own renewal deadline anyway. What
 * is never allowed is silence — the outcome always rides on the answer.
 */
async function releaseProjectRegistration(root: string) {
  const port = createRedskilledBirthPort({ root });
  try {
    // The Workers go FIRST, and they go through the host. A registration given
    // back while its Workers run leaves work nothing is watching: the demand loop
    // has stopped asking for them, so nobody would ever ask them to stop either.
    // The kill is the daemon's — this only names which of its Workers are ours.
    //
    // A Worker the host no longer names is the outcome asked for, not a failure:
    // between the read and the stop it may have finished, and a teardown that
    // raised on it would leave the registration standing over an empty project.
    const stopped: string[] = [];
    for (const workerId of await port.workerIds()) {
      try {
        if (await port.stop(workerId, "project_stop gave this project's registration back")) {
          stopped.push(workerId);
        }
      } catch {
        // Already gone. The next read is the daemon's, and it agrees.
      }
    }
    return { deregistered: await port.deregister(), project: port.projectLabel, workers_stopped: stopped };
  } catch (err) {
    return {
      deregistered: false,
      project: port.projectLabel,
      warnings: [redskilledRegistrationRefusal(port.socketPath, err)],
    };
  }
}

/**
 * Re-aim this project's running workers. The directive carries the new width
 * and runner to the live supervisor; with no registry there is nothing to
 * persist, so a change that the supervisor cannot yet apply reads as pending
 * rather than as saved.
 */
async function projectResize(root: string, rawInput: ProjectResizeInput) {
  const input: ProjectResizeInput = {
    ...rawInput,
    ...(rawInput.selector
      ? { selector: await concretizeSelectorUser(root, rawInput.selector) }
      : {}),
  };
  const paths = afkPaths(root);
  const running = await readSupervisorLiveness(paths.supervisorRuntimeDir);
  if (!running.alive) {
    throw new Error(
      "this project has no running workers to re-aim; use project_start to start them",
    );
  }

  let directive: "not-requested" | "written" = "not-requested";
  if (input.target !== undefined || input.runner !== undefined) {
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
  return {
    status: "resized",
    directive,
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
  };
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

async function workerVitals(
  root: string,
  opts: { live_only?: boolean } = {},
): Promise<WorkerVitalsOutput> {
  const paths = createEnginePaths(join(root, ".red"));
  // Process liveness comes from the DAEMON, the single anchor: it owns birth and
  // death, so it is the only authority on whether a Worker is still running. One
  // read serves every Worker in the answer, and an unreachable daemon yields
  // `unknown` rather than a Worker reported dead beside evidence of life.
  const [records, workerDirs, hostAnswer] = await Promise.all([
    readAllWorkerStates(afkPaths(root).tmpDir),
    readdir(paths.workersRoot, { withFileTypes: true }).catch(() => []),
    readDaemonWorkerSet().catch((): DaemonWorkerSet | null => null),
  ]);
  const alerts = new Map<string, { type: string; at: string; message: string }>();
  await Promise.all(workerDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const lane = await readCastleLaneRecords(castleLanePath(paths, "worker", entry.name));
    const latest = [...lane].reverse().find((record) => record.kind === "worker.session-error");
    const payload = latest?.payload;
    if (
      latest && payload &&
      typeof payload.type === "string" &&
      typeof payload.message === "string"
    ) {
      alerts.set(entry.name, {
        type: payload.type,
        at: typeof payload.at === "string" ? payload.at : latest.at,
        message: payload.message,
      });
    }
  }));
  const all = records.map(({ state, ...record }) => {
    return {
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
    alert: alerts.get(state.worker_id),
    // The record's own live flag can only WITHHOLD a death claim (see the
    // anchor): it never becomes an `alive` verdict of its own, so this payload
    // stays one anchor deep while refusing to call a visibly running Worker gone.
    daemon_liveness: publishWorkerLiveness(
      resolveWorkerLiveness(hostAnswer, state.worker_id, { evidenceOfLife: record.live }),
    ),
    };
  });
  const represented = new Set(all.map((record) => record.worker.id));
  for (const [workerId, alert] of alerts) {
    if (represented.has(workerId)) continue;
    all.push({
      worker: {
        id: workerId,
        pid: 0,
        runner: "",
        origin: "",
        started_at: alert.at,
        done: 0,
        total: 0,
        blocked: 0,
        failed: 1,
        current: {
          number: "",
          runner: "",
          retries: 0,
          phase: "blocked",
          iteration: "",
          model: "",
          effort: "",
          activity: "session-error",
          loc_added: 0,
          loc_removed: 0,
          last_commit_at: "",
          tools_called_count: 0,
          text_chunk_count: 0,
          reasoning_events: 0,
          reasoning_tokens: 0,
          last_event_at: alert.at,
          waiting_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
        },
      },
      live: false,
      active: false,
      renderable_live: false,
      liveness: "dead",
      liveness_verdict: {
        // Widened to the shared union so the synthetic session-error record
        // stays assignable as `LivenessStatus` grows (#2701 added `capped`).
        status: "stalled" as LivenessStatus,
        reason: "session-error",
        laneFresh: false,
        crossCheckArmed: false,
      },
      alert,
      // Asked of the same read as every other record, so a worker known only by
      // its session error still carries the daemon's verdict rather than a gap.
      daemon_liveness: publishWorkerLiveness(resolveWorkerLiveness(hostAnswer, workerId)),
    });
  }
  return opts.live_only !== false ? all.filter((r) => r.live === true || r.alert !== undefined) : all;
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

/**
 * The `queue_status` payload, built from the two candidate lists. Pure and
 * exported so the declared output contract is round-trippable over fixture
 * candidates — the GitHub reads stay in the dependency wiring above.
 *
 * The ready-for-agent bodies are dropped: the queue answer is "which issues",
 * and a full body per candidate would dwarf the rest of the payload.
 */
export function buildQueueStatus(
  readyForAgent: readonly IssueCandidate[],
  readyForHuman: readonly HitlCandidate[],
): QueueStatusOutput {
  return {
    ready_for_agent: readyForAgent.map(
      ({ body: _body, ...candidate }) => candidate,
    ),
    ready_for_human: [...readyForHuman],
    counts: {
      ready_for_agent: readyForAgent.length,
      ready_for_human: readyForHuman.length,
    },
  };
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
      projectStatus(root).catch(() => null),
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
          breaker_count: fleetChip.breaker?.count ?? 0,
          bundle_version: fleetChip.bundleVersion ?? null,
          /** Staleness inside the payload (ADR 0128 §6): the chip travels with
           * the anchor's verdict, so a renderer cannot draw it as current. */
          stale: fleetChip.stale ?? false,
          stale_age_s: fleetChip.staleAgeS ?? 0,
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
    queueStatus: async (input) => {
      // Scoped previews bypass the cache: the cache key is selector-blind, so a
      // scoped result must never be stored as (or served from) the full view.
      if (input?.selector) return deps.queueStatus(input);
      const cached = cache.get(QUEUE_STATUS_KEY) as
        | Awaited<ReturnType<typeof deps.queueStatus>>
        | undefined;
      if (cached !== undefined) return cached;
      const result = await deps.queueStatus(input);
      cache.set(QUEUE_STATUS_KEY, result);
      return result;
    },
    claimStatus: async (input) => {
      // Batch reads (#2369) bypass the single-issue cache key.
      if (input.issue === undefined) return deps.claimStatus(input);
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
    deadendAudit: async () => {
      // The resident cron refreshes this envelope; repeated tool calls within
      // the refresh window are served from cache and cost zero GitHub quota.
      const cached = cache.get(DEADEND_AUDIT_KEY);
      if (cached !== undefined) return cached;
      const result = await deps.deadendAudit();
      cache.set(DEADEND_AUDIT_KEY, result);
      return result;
    },
    claimRelease: async (input) => {
      for (const issue of input.issues ?? (input.issue !== undefined ? [input.issue] : [])) {
        cache.invalidate(claimStatusKey(issue));
      }
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
    projectStatus: () => projectStatus(root),
    projectStart: (input) => projectStart(root, input),
    projectResize: (input) => projectResize(root, input),
    projectStop: async (input) => {
      const silent = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const stopped = await stopFleet(root, silent, {
        ...(input.force ? { force: true } : {}),
      });
      return { ...stopped, ...(await releaseProjectRegistration(root)) };
    },
    logs: (input) => laneLogs(root, input),
    workerVitals: async (input) => {
      const records = await workerVitals(root, { live_only: input.live_only });
      if (!input.fields?.length) return records;
      // A `fields` projection deliberately narrows the declared shape; the
      // contract validates those calls against its relaxed projection schema.
      return projectFields(
        records as unknown as Array<Record<string, unknown>>,
        input.fields,
      ) as WorkerVitalsProjectedOutput;
    },
    dashboard: ({ periodDays }) => collectDashboardReport(periodDays, root),
    monitor: () => collectMonitorInputs(root),
    history: async ({ limit }) => {
      const records = await readCastleHistoryRecords(
        createEnginePaths(join(root, ".red")).castleHistory,
      );
      return limit === undefined ? records : records.slice(-limit);
    },
    queueStatus: async (input?: QueueStatusInput) => {
      const context = await resolveRepoContext(root);
      const gh = { cwd: root, repo: context.repo };
      let [readyForAgent, readyForHuman] = await Promise.all([
        listCandidates(gh),
        listHitlCandidates(gh),
      ]);
      // Scoped preview: apply a fleet selector (tags/user/spec/lane/…) over the
      // ready pool, mirroring exactly what a fleet with that selector would see.
      if (input?.selector) {
        const selector = await concretizeSelectorUser(
          root,
          parseWorkSelector(input.selector),
        );
        readyForAgent = readyForAgent.filter((c) => matchesSelector(c, selector ?? {}));
      }
      return buildQueueStatus(readyForAgent, readyForHuman);
    },
    workerDispatch: (input) => {
      if (input.issue !== undefined) {
        return operations.dispatchIssue(root, {
          ...input,
          issue: input.issue,
        });
      }
      if (input.demand !== undefined) {
        if (input.mode === "scout") {
          return operations.dispatchScout(root, {
            demand: input.demand,
            runner: input.runner,
          });
        }
        return operations.dispatchDemand(root, {
          ...input,
          demand: input.demand,
          // scout was handled above — narrow mode back to go-mode union
          mode: input.mode as "no-mistakes" | "direct-PR" | "local-only" | undefined,
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
    steerStatus: async (input: WorkerSteerStatusInput) => {
      const paths = createEnginePaths(join(root, ".red"));
      const steerPath = paths.workerSteerFile(input.worker);
      const { access } = await import("node:fs/promises");
      const pending = await access(steerPath).then(() => true).catch(() => false);
      if (pending) {
        return { worker: input.worker, status: "pending" };
      }
      const lanePath = castleLanePath(paths, "worker", input.worker);
      const records = await readCastleLaneRecords(lanePath);
      const consumed = records.filter((r) => r.kind === "worker.steer_consumed");
      if (consumed.length > 0) {
        const last = consumed[consumed.length - 1]!;
        const iteration =
          typeof last.payload?.iteration === "number"
            ? last.payload.iteration
            : undefined;
        return { worker: input.worker, status: "consumed", iteration };
      }
      return { worker: input.worker, status: "none" };
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
        if (dispatch.mode === "scout") {
          return operations.dispatchScout(root, {
            demand: dispatch.demand,
            runner: dispatch.runner,
          });
        }
        return operations.dispatchDemand(root, {
          ...dispatch,
          demand: dispatch.demand,
          mode: dispatch.mode as "no-mistakes" | "direct-PR" | "local-only" | undefined,
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
    hitlResolve: (input) => operations.hitlResolve(input),
    mergeArm: (input) => operations.mergeArm(input),
    mergeStatus: () => operations.mergeStatus(),
    mergeRelease: (input) => operations.mergeRelease(input),
    worktreeList: () => listDisposableWorktrees(root),
    worktreeRemove: (input) => removeDisposableWorktree(root, input),
    waitStart: (input) => operations.waitStart(input),
    waitList: () => listRspWaits(root),
    waitStatus: (input) => waitStatusImpl(root, input),
    dailyReview: (input) => operations.dailyReview(input),
    weeklyReview: (input) => operations.weeklyReview(input),
    triage: (input) => operations.triage(input),
    respond: (input) => operations.respond(input),
    deadendAudit: () => operations.deadendAudit(),
    statuslineAggregate: () => collectStatuslineAggregate(root),
    eventsSince: (input) => eventsSinceImpl(root, input),
  };
  return withCachedDeps(baseDeps, new ResidentReadCache());
}
