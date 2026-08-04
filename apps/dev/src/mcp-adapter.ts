import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { waitsDir, worktreesDir } from "@reddb-io/shared/red-paths.js";
import {
  composeRepair,
  noRepair,
  registrationRepair,
  type RepairAction,
} from "@reddb-io/shared/repair.js";
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
import {
  newestInstalledPluginVersion,
  publishedVersionReport,
  readPublishedBundleVersion,
} from "./core/published-version.js";
import { collectDashboardReport } from "./commands/dashboard.js";
import type { HitlCandidate } from "./core/hitl-selection.js";
import type { IssueCandidate } from "./core/session.js";
import { listCandidates, listHitlCandidates } from "./runtime/gh.js";
import { matchesSelector } from "./core/session.js";
import { resolveHitlDecision } from "./core/hitl-resolve.js";
import { detectWedgedOrchestrator } from "./core/wedged-orchestrator.js";
import * as ghx from "./runtime/gh.js";
import { requestWorkerBirth, type DispatchedWorkerBirth } from "./runtime/mcp-worker-birth.js";
import { checkDispatchEngineFloor } from "./runtime/engine-floor-check.js";
import type { EngineFloorVerdict } from "./core/engine-floor.js";
import { launchDetachedRspWait } from "./runtime/rsp-wait-launch.js";
import {
  createRedskilledBirthPort,
  redskilledRegistrationRefusal,
} from "./runtime/redskilled-birth.js";
import { registrationLogPathTemplate } from "./runtime/redskilled-worker-log.js";
import { registrationLaunch } from "./runtime/registration-launch.js";
import { registrationDeliveryLanes } from "./runtime/registration-delivery.js";
import { attributeProjectWorkers } from "./core/project-attribution.js";
import { migrateToTwoPlayer } from "./runtime/two-player-migration.js";
import {
  publishWorkerLiveness,
  readDaemonWorkerSet,
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
import { LABEL_GO_LANE, LABEL_SCOUT_LANE } from "./core/triage-labels.js";
import { cleanupDisposableDispatchOnBootFailure } from "./commands/run/disposable-cleanup.js";
import {
  getConfig,
  loadConfig,
  readBackpressure,
  readHitlTypeLabels,
  readValidationResourceBudget,
} from "./core/config.js";
import {
  evaluateClaimTrust,
  parseTrustPolicy,
  type ActorTrustLookup,
  type TrustPolicy,
  type TrustProvenance,
} from "./core/trust-gate.js";
import * as gitx from "./runtime/git.js";
import { makeFeedbackWorktree } from "./runtime/feedback-worktree.js";
import { runFeedback } from "./core/feedback.js";
import { gateScopes } from "./core/validation-scope.js";
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
import {
  buildRegistrationQuery,
  registrationQueryUnexpressedFacets,
} from "./core/registration-query.js";
import { resolveRepoSlugForDir } from "@reddb-io/shared/project-identity-resolve.js";
import { runRepoUnblockPass } from "./runtime/unblock-pass.js";
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
  /**
   * Ask the HOST for one Worker, and refuse when it does not answer.
   *
   * Named for the request rather than for a launch because there is no launch
   * here any more (#2976): `worker_dispatch` used to spawn the Worker itself, so
   * a dispatched Worker was counted by no budget, absent from the host event
   * lane and reported by no surface — the exact shape ADR 0130 rule 6 forbids.
   */
  birthWorker(
    root: string,
    args: readonly string[],
    options?: { readonly reservation?: "interactive" },
  ): Promise<DispatchedWorkerBirth>;
  /**
   * Judge the engine a dispatch would run against the published dist-tag
   * (#3031). Every `worker_dispatch` shape asks before it mints or births, so a
   * superseded engine is refused or NAMED rather than quietly forfeiting the
   * fixes that already landed for it.
   */
  checkEngineFloor(root: string): Promise<EngineFloorVerdict>;
  /** Spawn rsp wait detached; returns the child PID. */
  launchRspWait(args: readonly string[], cwd: string): Promise<number>;
  ensureLabel(root: string, name: string): Promise<void>;
  createIssue(root: string, spec: DisposableIssueSpec): Promise<number>;
  commentIssue(root: string, issue: number, body: string): Promise<void>;
  closeIssue(root: string, issue: number): Promise<void>;
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

// The dispatch surface starts nothing itself: `dispatchLogPath` and the birth
// request live in `runtime/mcp-worker-birth.ts`, and the rsp-wait spawn — which
// is not a Worker — lives in `runtime/rsp-wait-launch.ts`. Both are re-exported
// here because this module is a declared `host-owns-birth` site (#2976), and
// that ratchet reads whether a MODULE can create a process at all.
export { dispatchLogPath } from "./runtime/mcp-worker-birth.js";
export { resolveRspCliBundle } from "./runtime/rsp-wait-launch.js";


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
  birthWorker: (root, args, options) => requestWorkerBirth(root, args, options),
  checkEngineFloor: (root) => checkDispatchEngineFloor(root),
  launchRspWait: launchDetachedRspWait,
  async ensureLabel(root, name) {
    const context = await resolveRepoContext(root);
    await ghx.ensureLabel({ cwd: context.root, repo: context.repo }, name);
  },
  async createIssue(root, spec) {
    const context = await resolveRepoContext(root);
    return ghx.createIssue({ cwd: context.root, repo: context.repo }, spec);
  },
  async commentIssue(root, issue, body) {
    const context = await resolveRepoContext(root);
    await ghx.comment({ cwd: context.root, repo: context.repo }, issue, body);
  },
  async closeIssue(root, issue) {
    const context = await resolveRepoContext(root);
    await ghx.closeIssue({ cwd: context.root, repo: context.repo }, issue);
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
  /**
   * The engine floor, applied once for every dispatch shape (#3031). A refusal
   * throws BEFORE any issue is minted or any Worker asked for, so a refused
   * dispatch leaves nothing behind; a warning travels back in the payload's
   * `warnings`, where the operator-facing surfaces already render it.
   */
  const engineFloorWarnings = async (cwd: string): Promise<string[]> => {
    const verdict = await runtime.checkEngineFloor(cwd);
    if (verdict.decision === "refuse") throw new Error(verdict.message);
    return verdict.decision === "warn" ? [verdict.message] : [];
  };
  return {
    async dispatchIssue(cwd, input) {
      const floorWarnings = await engineFloorWarnings(cwd);
      const args = [
        "--issues",
        String(input.issue),
        "--once",
        ...dispatchArgs(input),
      ];
      const granted = await runtime.birthWorker(cwd, args);
      return {
        kind: "afk",
        issue: input.issue,
        // The host's id for this Worker, so the surface that dispatched it and
        // the surface that reports it name the same thing (#2976).
        worker_id: granted.worker_id,
        worker_pid: granted.pid,
        // Post-mortem handle for a worker that dies before writing its own
        // state (#2385): its boot stdout/stderr lands here.
        worker_log: granted.log,
        admission: granted.admission,
        ...(floorWarnings.length + granted.warnings.length > 0
          ? { warnings: [...floorWarnings, ...granted.warnings] }
          : {}),
        status: "dispatched",
      };
    },
    async dispatchDemand(cwd, input) {
      const floorWarnings = await engineFloorWarnings(cwd);
      let granted: DispatchedWorkerBirth | undefined;
      const configuredBackpressure = readBackpressure(
        loadConfig(afkPaths(cwd).configPath, { warn: () => undefined }),
      );
      const result = await dispatchGo(
        {
          ensureLabel: (name) => runtime.ensureLabel(cwd, name),
          createIssue: (spec) => runtime.createIssue(cwd, spec),
          runEngine: async (args) => {
            granted = await runtime.birthWorker(cwd, args, { reservation: "interactive" });
            return 0;
          },
          disposeIssue: async (issue) => {
            await cleanupDisposableDispatchOnBootFailure(
              {
                comment: (number, body) => runtime.commentIssue(cwd, number, body),
                close: (number) => runtime.closeIssue(cwd, number),
              },
              {
                declaredLane: LABEL_GO_LANE,
                consultedQueue: LABEL_GO_LANE,
                filter: { kind: "issues", numbers: [issue] },
                failureType: "boot-error",
              },
            );
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
      if (granted === undefined) {
        throw new Error("cannot dispatch demand: the host granted no Worker");
      }
      return {
        kind: "go",
        demand: input.demand,
        issue: result.issue,
        worker_id: granted.worker_id,
        worker_pid: granted.pid,
        worker_log: granted.log,
        admission: granted.admission,
        ...(floorWarnings.length + granted.warnings.length > 0
          ? { warnings: [...floorWarnings, ...granted.warnings] }
          : {}),
        status: "dispatched",
      };
    },
    async dispatchScout(cwd, input) {
      const floorWarnings = await engineFloorWarnings(cwd);
      let granted: DispatchedWorkerBirth | undefined;
      const result = await dispatchScoutCore(
        {
          ensureLabel: (name) => runtime.ensureLabel(cwd, name),
          createIssue: (spec) => runtime.createIssue(cwd, spec),
          runEngine: async (args) => {
            granted = await runtime.birthWorker(cwd, args, { reservation: "interactive" });
            return 0;
          },
          disposeIssue: async (issue) => {
            await cleanupDisposableDispatchOnBootFailure(
              {
                comment: (number, body) => runtime.commentIssue(cwd, number, body),
                close: (number) => runtime.closeIssue(cwd, number),
              },
              {
                declaredLane: LABEL_SCOUT_LANE,
                consultedQueue: LABEL_SCOUT_LANE,
                filter: { kind: "issues", numbers: [issue] },
                failureType: "boot-error",
              },
            );
          },
        },
        input.demand,
        { runner: input.runner },
      );
      if (granted === undefined) {
        throw new Error("cannot dispatch scout: the host granted no Worker");
      }
      return {
        kind: "scout",
        demand: input.demand,
        issue: result.issue,
        worker_id: granted.worker_id,
        worker_pid: granted.pid,
        worker_log: granted.log,
        admission: granted.admission,
        ...(floorWarnings.length + granted.warnings.length > 0
          ? { warnings: [...floorWarnings, ...granted.warnings] }
          : {}),
        status: "dispatched",
      };
    },
    async stopWorker(cwd, input) {
      // The checkout travels with the stop so a record with no process is
      // RELEASED rather than reported as `none` (#3123): the host is the only
      // thing holding the slot, and this verb is the only one that can free it.
      const result = await executeStopWorker(input.worker, afkPaths(cwd).tmpDir, undefined, cwd);
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
      // One pass, one implementation (#3014): the tool, the resident's Unblock
      // belt, and the boot suite's step 7 promote through the same core, so an
      // operator invoking this by hand gets exactly what the belt does on its
      // own schedule. The lane comes from THIS repo's installed vocabulary
      // (#2966), so a HUMAN-ONLY dependent parks for its human instead of
      // joining the queue.
      const promoted = await runRepoUnblockPass(root);
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
        const rootPackageJson = changedFiles.includes("package.json")
          ? await gitx.changedFileContents({ cwd: root }, input.branch, base, "package.json")
          : undefined;
        const result = await runFeedback(feedback.pnpm, {
          worktree: input.branch,
          scopes: gateScopes(
            feedback.layout,
            changedFiles,
            rootPackageJson ? { rootPackageJson } : undefined,
          ),
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
          labels: row.labels,
          reqs: reqs.map((n) => ({
            n,
            closed: (states.get(n)?.state ?? "").toUpperCase() === "CLOSED",
          })),
        });
      }
      // An operator reading this projection must see WHERE each promotion would
      // land, not just that it would happen (#2966).
      const hitlTypes = readHitlTypeLabels(
        loadConfig(afkPaths(root).configPath, { warn: () => undefined }),
      );
      return {
        issue: input.issue,
        dependents: dependents.map((dependent) => ({
          number: dependent.number,
          reqs: dependent.reqs,
        })),
        promotable: planCloseCascade(input.issue, dependents, hitlTypes).map((plan) => ({
          number: plan.number,
          refs: plan.refs,
          req_labels: plan.reqLabels,
          lane: plan.lane,
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

/**
 * What the host holds for this project, and which Workers it is running.
 *
 * ADR 0130 Amendment 4 removed the per-project process, so there is no
 * `supervisor:` left to report — the question "is this project being driven"
 * is answered by the REGISTRATION the daemon holds and by the poll it last ran
 * against it (#2909). A daemon that does not answer reports `daemon_reachable:
 * false` rather than an absent registration, because "the host holds nothing"
 * and "the host said nothing" send an operator to opposite places.
 */
async function projectStatus(root: string): Promise<ProjectStatusOutput> {
  const port = createRedskilledBirthPort({ root });
  const [monitor, registrationState, interactiveReservation] = await Promise.all([
    collectMonitorInputs(root),
    port.registrationState().catch(() => undefined),
    port.interactiveReservation().catch(() => 0),
  ]);
  const held = registrationState?.held;
  const lapse = registrationState?.lapse;
  const allLiveWorkers = monitor.workers.filter(
    (worker) => worker.pidLive === true || worker.live,
  );
  // Attribution is the HOST's, never a pid map of our own: a Worker is ours when
  // the daemon says its project is ours. A stamp for another project — or none
  // at all — lands in the unattributed bucket even when the pid looks familiar.
  //
  // The join works because the two ids are ONE id: the launch declares
  // `RED_AFK_WORKER_ID={{worker_id}}` and the Worker adopts the string the host
  // assigned rather than minting its own (#3081). A predicate that matches
  // nothing across a non-empty Worker set is that wire broken, and it is
  // reported rather than rendered as an idle project.
  // ONE host read for both the ids and their birth instants: the dates are what
  // tell a newborn holding its slot apart from a record outliving its Worker
  // (#3123), and asking twice would date them to two different answers.
  const hostBirths = await port.workerBirths().catch(() => null);
  const attribution = attributeProjectWorkers({
    workers: allLiveWorkers,
    hostWorkerIds: hostBirths == null ? null : Object.keys(hostBirths),
    ...(hostBirths == null ? {} : { hostWorkerBirths: hostBirths }),
  });
  const liveWorkers = attribution.live;
  const unattributedWorkers = attribution.unattributed;
  // The published version comes from the one owner the boot probe also consults
  // (#2809), so a reader replays that answer instead of deriving its own.
  const published = readPublishedBundleVersion();
  const version = publishedVersionReport("", published);
  const delivery = registrationDeliveryLanes({
    registrationArgv: held?.argv,
    publishedVersion: published.version,
    pluginCacheVersion: newestInstalledPluginVersion(),
  });
  const target = held?.target ?? 0;
  // The host's count, not the matched list's: a Worker born a moment ago holds
  // its slot before it has written any project-side state, and a `busy` that
  // waited for that file would read free while the daemon refused to fill it.
  const busy = attribution.busy;
  const registrationAbsence = held != null
    ? null
    : registrationState === undefined
      ? composeRepair({
          state: "the redskilled daemon did not answer, so registration state is unknown",
          repair: noRepair("the daemon must answer before registration can be changed safely"),
        })
      : composeRepair({
          state: lapse?.detail ?? "the host holds no registration for this project and recorded no lapse",
          repair: registrationRepair(),
        });
  return {
    registration: {
      held: held != null,
      daemon_reachable: registrationState !== undefined,
      project: port.projectLabel,
      socket: port.socketPath,
      selector: held?.selector ?? "",
      target,
      renewal: held?.renewal ?? "unknown",
      renew_by: held?.renew_by ?? "",
      renewals: held?.renewals ?? 0,
      lapsed_at: held == null ? (lapse?.at ?? "") : "",
      reason: registrationAbsence?.prose ?? "",
      ...(registrationAbsence == null
        ? {}
        : {
            repair: registrationAbsence.repair,
            ...(registrationAbsence.repair === "none"
              ? { repair_reason: registrationAbsence.repair_reason }
              : {}),
          }),
      launch_revision: held?.launch_revision ?? 0,
      bundle_version: delivery.bundle_version,
      plugin_cache_version: delivery.plugin_cache_version,
      ...(held?.last_poll ? { last_poll: held.last_poll } : {}),
      ...(version.published_version ? { published_version: version.published_version } : {}),
    },
    slots: {
      busy,
      free: Math.max(0, target - busy),
      parked: 0,
      total: target,
      interactive_reservation: interactiveReservation,
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
    ...(attribution.warnings.length > 0 ? { warnings: [...attribution.warnings] } : {}),
  };
}

/**
 * The one string this project hands the daemon as its work query.
 *
 * **A tracker query, because the daemon hands it to the tracker.** It used to be
 * this project's own JSON selector shape — one encoding for two readers, which
 * looked like the frugal choice and was the defect: the daemon carries the
 * string verbatim (ADR 0130 rule 3), so it asked GitHub to search for `{}`, got
 * an answer about nothing, and every registered project sat at a depth that
 * birthed no Worker (#2974). The JSON still travels, in the argv, to the one
 * reader that can read it — the Worker.
 */
function encodeRegistrationSelector(repo: string, selector: ProjectStartInput["selector"]): string {
  return buildRegistrationQuery({ repo, selector });
}

/** What the operator is told about a start that could not carry everything. */
function startWarnings(input: ProjectStartInput, unexpressed: readonly string[]): string[] {
  const warnings: string[] = [];
  if (input.base !== undefined) {
    warnings.push(
      `the base branch ${JSON.stringify(input.base)} does not travel in a registration yet; ` +
        `a Worker born from it will use this project's configured trunk`,
    );
  }
  if (unexpressed.length > 0) {
    warnings.push(
      `the ${unexpressed.join(" and ")} facet(s) cannot be expressed as a tracker query, so the host counts this ` +
        `project's queue without them and may see more work than the selector matches; the Worker still narrows to ` +
        `the selector it is launched with`,
    );
  }
  return warnings;
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
 * back to a process of the project's own would put a demand producer on the
 * machine that no host admitted, no host counts and no host can stop — precisely
 * the shape the registration exists to end.
 */
async function projectStart(root: string, rawInput: ProjectStartInput) {
  const input: ProjectStartInput = {
    ...rawInput,
    ...(rawInput.selector
      ? { selector: await concretizeSelectorUser(root, rawInput.selector) }
      : {}),
  };
  // A project already registered is refused by the DAEMON, which is the one
  // party that can see the record — a pre-check of our own would be a second
  // opinion racing the authority (ADR 0130 Amendment 4).
  const port = createRedskilledBirthPort({ root });
  // ADR 0130 Amendment 6 (#2910): registering is the boundary between a machine
  // that still carries a per-project runtime and one in the two-player model, so
  // the one-time carry-across runs exactly here — before anything this project
  // registers, which is the very thing a leftover runtime would collide with.
  // Stamped, idempotent, and INERT until an operator declares the era with
  // `RED_TWO_PLAYER_CUTOVER=1`: an undeclared era must never stop a runtime the
  // operator is still relying on.
  await migrateToTwoPlayer(root, {
    deps: {
      projectLabel: () => port.projectLabel,
      // The host's own answer to "which Workers are mine", so a Worker it already
      // holds is never re-adopted and a Worker it does not hold is named rather
      // than assumed — re-adoption is confirmed against host state, never claimed.
      hostWorkers: async () =>
        new Map((await port.workerIds()).map((workerId) => [workerId, port.projectLabel])),
      readopt: async (workerId) => (await port.workerIds()).includes(workerId),
    },
  }).catch(() => undefined);
  // A host that does not answer is the FIRST refusal, ahead of anything this
  // project could get wrong about itself: an operator whose daemon is down must
  // be told that, not told about their remote (ADR 0130 rule 6).
  try {
    await port.reach();
  } catch (err) {
    throw new Error(redskilledRegistrationRefusal(port.socketPath, err));
  }
  // Which tracker this project's queue lives in — resolved HERE, because the
  // daemon may not learn what a checkout is (rule 3) and a query without a
  // `repo:` term counts every repository the host token can see. From the
  // `origin` remote rather than the tracker CLI: starting work must not wait on
  // a network call, and a checkout with no remote has no queue to register for.
  const repo = resolveRepoSlugForDir(root);
  if (repo == null) {
    throw new Error(
      `this checkout has no \`origin\` remote, so there is no tracker to count its queue in: the host polls the ` +
        `query a registration hands it, and a project that names no repository would either count nothing or ` +
        `count every repository the host token can see`,
    );
  }
  const selector = encodeRegistrationSelector(repo, input.selector);
  const warnings = startWarnings(input, registrationQueryUnexpressedFacets(input.selector));
  // Where this project's Workers write their output, and how each one addresses
  // the host it must publish its last line to (#3079). Declared HERE because a
  // registration is the only thing this lane ever tells the daemon: a project
  // that states neither births Workers whose logs no surface can show, which is
  // exactly how the herdr plugin, the VS Code extension and the verbose
  // statusline all came to report a Worker with nothing to say.
  const logPathTemplate = registrationLogPathTemplate(root, new Date().toISOString().slice(0, 10));

  // What runs when a Worker is born for this project — resolved from the
  // PUBLISHED bundle rather than from this process's own entry (#2808), so a
  // registration made from a stale plugin cache never commits the host to an
  // older Worker than the one this project publishes.
  //
  // Composed by the ONE namer (#3081). The argv used to be assembled here and
  // the env stated separately, so the env carried only the host's log handle
  // while the three vars a Worker needs to know who and where it is — its id,
  // its slot and its runner — lived in a builder nothing called. A Worker born
  // without its id minted a second one, and no surface could join the two.
  const launch = registrationLaunch({ runner: input.runner, selector: input.selector, logPath: logPathTemplate });

  let registered;
  try {
    // Where a Worker runs, stated rather than derived: the daemon owns the demand
    // loop (ADR 0130 Amendment 4), so it births the Worker itself, and a host that
    // had to work out a working directory would have to know what a checkout looks
    // like — the one thing rule 3 forbids.
    registered = await port.register({
      selector,
      argv: [...launch.argv],
      workspace_path: root,
      // Both halves of the env come from the ONE composer (#3081): the host's log
      // handle it carries through `registrationLaunchEnv`, and the per-birth facts
      // — the runner this start decided, the slot the host places the Worker on
      // (#3118) and the worker id it assigns — that the pure builder re-pins.
      env: launch.env ?? {},
      ...(launch.log_path == null ? {} : { log_path: launch.log_path }),
      target: input.target,
    });
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
    // Reported rather than assumed: an operator who cannot see a Worker's output
    // needs to know which path was declared for it, and a registration answering
    // with none is the defect rather than a Worker that says nothing.
    log_path: registered.log_path ?? null,
    ...(input.selector ? { work_selector: input.selector } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    // Stated, never swallowed: the frozen contract carries no environment, and a
    // trunk override travels to a Worker in one. Naming it here keeps a dropped
    // override visible to the operator who asked for it. The unexpressed facets
    // ride the same list, so a host depth wider than the selector's real pool is
    // an answer the operator already has rather than a contradiction they find.
    ...(warnings.length > 0 ? { warnings } : {}),
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
 * Re-aim this project's work by RESTATING its launch, not by messaging a process.
 *
 * ADR 0130 Amendment 5: the launch is the one part of a registration a renewal
 * may restate, so a runner swap rides the message a live session already sends
 * and the daemon holds it as the launch for the NEXT Worker. The width lives in
 * the registration itself and a renewal does not carry it, so a target change is
 * reported as unapplied rather than silently dropped — a resize that answered
 * "resized" while changing nothing is the failure this states out loud.
 */
async function projectResize(root: string, rawInput: ProjectResizeInput) {
  const input: ProjectResizeInput = {
    ...rawInput,
    ...(rawInput.selector
      ? { selector: await concretizeSelectorUser(root, rawInput.selector) }
      : {}),
  };
  const port = createRedskilledBirthPort({ root });
  const held = await port.registration().catch(() => undefined);
  if (held == null) {
    throw new Error(
      held === undefined
        ? redskilledRegistrationRefusal(port.socketPath, new Error("the host did not answer"))
        : "this project holds no registration to re-aim; use project_start to register it",
    );
  }

  let directive: "not-requested" | "restated" = "not-requested";
  const warnings: string[] = [];
  if (input.runner !== undefined) {
    // All-or-nothing, as the amendment requires: the argv is restated whole, and
    // the env and the log path travel with it, so the next Worker is never half
    // one tick's decision and half an older one. Restated through the SAME namer
    // the registration used (#3081) — a resize that rebuilt the argv by hand and
    // carried the old env forward is how a launch came to be half-composed, and
    // a restatement that omitted the log path would clear it outright.
    await port.restateLaunch(
      registrationLaunch({
        runner: input.runner,
        selector: input.selector,
        logPath: held.log_path ?? registrationLogPathTemplate(root, new Date().toISOString().slice(0, 10)),
      }),
    );
    directive = "restated";
  }
  if (input.target !== undefined && input.target !== held.target) {
    warnings.push(
      `the target ${input.target} does not travel on a renewal; this project stays registered at ` +
        `${held.target} until it is registered again (ADR 0130 Amendment 5)`,
    );
  }
  return {
    status: "resized",
    directive,
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
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
  const nowIso = new Date().toISOString();
  const all = records.map(({ state, ...record }) => {
    // The post-DONE hang the liveness lane cannot see (#2985): alive, no child,
    // orchestrator-owned phase, silent for minutes. A session-error alert is a
    // harder fact and always wins; this fills the gap where there is none.
    const wedged = detectWedgedOrchestrator({
      live: record.live,
      phase: state.current.phase,
      laneAgeMs: record.livenessVerdict?.laneAgeMs,
      liveDescendants: record.livenessVerdict?.liveDescendants,
      blockedOn: state.current.blocked_on,
      blockedDetail: state.current.blocked_detail,
    });
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
        wait_kind: state.current.wait_kind,
        wait_subject: state.current.wait_subject,
        wait_pid: state.current.wait_pid,
        wait_started_at: state.current.wait_started_at,
        wait_deadline: state.current.wait_deadline,
        wait_escalation: state.current.wait_escalation,
      },
    },
    live: record.live,
    active: record.active,
    renderable_live: record.renderableLive,
    liveness: record.liveness,
    liveness_verdict: record.livenessVerdict,
    alert:
      alerts.get(state.worker_id) ??
      (wedged ? { type: wedged.type, at: nowIso, message: wedged.message } : undefined),
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
          wait_kind: "",
          wait_subject: "",
          wait_pid: 0,
          wait_started_at: "",
          wait_deadline: "",
          wait_escalation: "",
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
  return boundWorkerVitals(filterWorkerVitalsLiveOnly(all, opts.live_only !== false));
}

/**
 * How long a dead worker's alert keeps it on the DEFAULT (live) read.
 *
 * An alert is a page: a boot death must surface on the very next read, or a
 * fast-dying worker is invisible (the case the session-error lane exists for).
 * But a page ages — past this window it has either been acted on or superseded
 * by a respawn, and keeping it on the live read is how 344 corpses buried the
 * one live worker under 559KB of payload. `live_only: false` still returns
 * every record, however old.
 */
export const WORKER_VITALS_ALERT_FRESH_MS = 30 * 60 * 1000;

/**
 * `live_only` means live — plus deaths fresh enough to still be a page.
 * The unconditional alert arm let every stalled corpse through forever,
 * because nothing reclaims the records (#2978).
 */
export function filterWorkerVitalsLiveOnly<
  T extends { live?: boolean; alert?: { at?: string } | undefined },
>(records: readonly T[], liveOnly: boolean, nowMs = Date.now()): T[] {
  if (!liveOnly) return [...records];
  return records.filter((r) => {
    if (r.live === true) return true;
    const at = r.alert?.at === undefined ? NaN : Date.parse(r.alert.at);
    return Number.isFinite(at) && nowMs - at <= WORKER_VITALS_ALERT_FRESH_MS;
  });
}

/**
 * The ceiling on how many rows one `worker_vitals` answer may carry.
 *
 * The reclaim (#2978) is what keeps the record lane small; this is what keeps
 * the PAYLOAD small while a pile exists at all — a surface must stay correct
 * during the window between a Worker dying and the retention releasing its
 * record, and on a `live_only: false` read that deliberately asks for the dead
 * ones. Thirty-two rows is an order of magnitude above any real fleet width on
 * one host, so a bounded answer never truncates a live fleet, and it holds the
 * payload near the ~1KB-per-row this record shape costs instead of the 559KB
 * that 345 corpses produced.
 */
export const WORKER_VITALS_MAX_RECORDS = 32;

/**
 * Bound the answer, LIVE ROWS FIRST.
 *
 * The ordering is the whole point, not a tidiness preference: when the pile
 * buried the one live Worker, the first row a reader saw was a corpse whose
 * `loc 0` read as "the worker produced nothing". Live rows sort ahead of dead
 * ones and recent ahead of old, so the rows a bound can ever drop are the
 * oldest dead ones — the rows whose evidence the Worker's own lane log and the
 * castle history still carry.
 */
export function boundWorkerVitals<
  T extends {
    live?: boolean;
    worker?: { started_at?: string; current?: { last_event_at?: string } };
  },
>(records: readonly T[], limit = WORKER_VITALS_MAX_RECORDS): T[] {
  if (records.length <= limit) return [...records];
  const recency = (record: T): number => {
    const last = Date.parse(record.worker?.current?.last_event_at ?? "");
    if (Number.isFinite(last)) return last;
    const started = Date.parse(record.worker?.started_at ?? "");
    return Number.isFinite(started) ? started : 0;
  };
  return [...records]
    .sort((a, b) => {
      if (a.live !== b.live) return a.live === true ? -1 : 1;
      return recency(b) - recency(a);
    })
    .slice(0, limit);
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
  eligibleForAgent: readonly IssueCandidate[],
  heldForSummon: readonly IssueCandidate[],
  readyForHuman: readonly HitlCandidate[],
): QueueStatusOutput {
  const projectCandidate = ({ body: _body, author: _author, ...candidate }: IssueCandidate) => candidate;
  return {
    ready_for_agent: {
      eligible: eligibleForAgent.map(projectCandidate),
      held_for_summon: heldForSummon.map(projectCandidate),
    },
    ready_for_human: [...readyForHuman],
    counts: {
      ready_for_agent_eligible: eligibleForAgent.length,
      ready_for_agent_held: heldForSummon.length,
      ready_for_human: readyForHuman.length,
    },
  };
}

export async function partitionReadyForAgentByTrust(
  candidates: readonly IssueCandidate[],
  policy: TrustPolicy,
  deps: {
    issueTrust(candidate: IssueCandidate): Promise<TrustProvenance>;
    actorTrustSignals: ActorTrustLookup;
  },
): Promise<{
  eligible: IssueCandidate[];
  heldForSummon: IssueCandidate[];
}> {
  const eligible: IssueCandidate[] = [];
  const heldForSummon: IssueCandidate[] = [];
  const gateActive = policy.enabled || policy.failClosed === true;
  for (const candidate of candidates) {
    if (!gateActive) {
      eligible.push(candidate);
      continue;
    }
    const verdict = await evaluateClaimTrust(
      policy,
      await deps.issueTrust(candidate),
      deps.actorTrustSignals,
    );
    (verdict.executable ? eligible : heldForSummon).push(candidate);
  }
  return { eligible, heldForSummon };
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

interface CursorRefusal {
  refused: true;
  reason: string;
  repair: RepairAction;
}

function cursorRefusal(state: string): CursorRefusal {
  const composed = composeRepair({
    state,
    repair: {
      tool: "events_since",
      args: {},
      why: "re-baseline with a fresh cursor",
    },
  });
  if (composed.repair === "none") throw new Error("invalid cursor refusal repair");
  return { refused: true, reason: composed.prose, repair: composed.repair };
}

function decodeCursor(cursor: string): { at: string } | CursorRefusal {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return cursorRefusal("Unknown cursor format");
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).v !== CURSOR_VERSION ||
    typeof (raw as Record<string, unknown>).at !== "string"
  ) {
    return cursorRefusal("Unknown cursor format");
  }
  const at = (raw as Record<string, unknown>).at as string;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs) || Date.now() - atMs > CURSOR_MAX_AGE_MS) {
    return cursorRefusal("Cursor expired");
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
    // Stopping is giving the registration back and asking the host to end this
    // project's Workers. There is no process of the project's own left to kill
    // (ADR 0130 Amendment 4), so `force` no longer selects a harder teardown —
    // the kill is the daemon's either way.
    projectStop: async () => ({ status: "stopped", ...(await releaseProjectRegistration(root)) }),
    hostState: () => createRedskilledBirthPort({ root }).hostState(),
    hostDashboard: () => createRedskilledBirthPort({ root }).hostDashboard(),
    hostProvisionCheck: () => createRedskilledBirthPort({ root }).provisionCheck(),
    hostUnitStatus: () => createRedskilledBirthPort({ root }).unitStatus(),
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
    monitor: async () => {
      const [monitor, interactiveReservation] = await Promise.all([
        collectMonitorInputs(root),
        createRedskilledBirthPort({ root }).interactiveReservation().catch(() => 0),
      ]);
      return {
        ...monitor,
        fleet: monitor.fleet == null
          ? null
          : { ...monitor.fleet, interactiveReservation },
      };
    },
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
      const config = loadConfig(afkPaths(root).configPath, { warn: () => undefined });
      const policy = parseTrustPolicy(config, await ghx.repoVisibility(gh));
      const { eligible, heldForSummon } = await partitionReadyForAgentByTrust(
        readyForAgent,
        policy,
        {
          issueTrust: (candidate) => ghx.issueTrust(gh, candidate.number),
          actorTrustSignals: (actor) => ghx.actorTrustSignals(gh, actor),
        },
      );
      return buildQueueStatus(eligible, heldForSummon, readyForHuman);
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
