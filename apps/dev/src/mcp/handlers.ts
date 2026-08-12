import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { waitsDir } from "@reddb-io/shared/red-paths.js";
import {
  armPr,
  createEnginePaths,
  createFileMergeDriverStore,
  createSingletonLeaseStore,
  releasePr,
} from "@reddb-io/red-castle/engine";
import { resolveHitlDecision } from "../core/hitl-resolve.js";
import * as ghx from "../runtime/gh.js";
import { type DispatchedWorkerBirth } from "../runtime/mcp-worker-birth.js";
import {
  afkPaths,
  resolveRepoContext,
} from "../runtime/wire.js";
import { executeStopWorker } from "../commands/stop.js";
import { verifyFreshBase } from "../commands/requeue.js";
import { executeRetake } from "../commands/retake.js";
import {
  dispatchGo,
} from "../core/go.js";
import { dispatchScout as dispatchScoutCore } from "../core/scout.js";
import { LABEL_GO_LANE, LABEL_SCOUT_LANE } from "../core/triage-labels.js";
import { cleanupDisposableDispatchOnBootFailure } from "../commands/run/disposable-cleanup.js";
import {
  loadConfig,
  readHitlTypeLabels,
  readValidationMoments,
  readValidationResourceBudget,
  readSetupCommands,
} from "../core/config.js";
import * as gitx from "../runtime/git.js";
import { makeFeedbackWorktree } from "../runtime/feedback-worktree.js";
import { runFeedback } from "../core/feedback.js";
import { gateScopes } from "../core/validation-scope.js";
import { doLanding } from "../core/landing.js";
import { dispatchHooks, type HookExec } from "../core/hook-dispatcher.js";
import { resolveHooks } from "../core/hook-config.js";
import { makeHookExec, makeHookResolveOptions } from "../runtime/hooks.js";
import {
  parseClaimRecords,
  renderClaimComment,
} from "../core/claim.js";
import { parseReqLabels, planCloseCascade, type DependentIssue } from "../core/boot-sweep.js";
import {
  branchesToReap,
  planLiveBranchCleanup,
  planLocalBranchCleanup,
} from "../core/branch-cleanup.js";
import { planBranchReclaim } from "../core/branch-reclaim.js";
import { runRepoUnblockPass } from "../runtime/unblock-pass.js";
import { collectReapInputs } from "../runtime/wire/reap.js";
import { collectActivityReview } from "../commands/activity-review.js";
import { executeTriage } from "../commands/triage.js";
import { executeRespond } from "../commands/respond.js";
import { collectDeadendAuditReport } from "../runtime/deadend-audit-report.js";

import type { DevAfkMcpOperations, DevAfkMcpRuntime } from "./operations.js";
import { dispatchArgs, buildWaitArgs, defaultMcpRuntime, resolveConfiguredBase, latestClaimPerWorker } from "./operations.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function mergeDriverIsTicking(root: string): Promise<boolean> {
  const paths = createEnginePaths(join(root, ".red"));
  const lease = await createSingletonLeaseStore(paths).read("merge-driver");
  return lease !== undefined && isProcessAlive(lease.pid);
}

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
      const gateConfig = loadConfig(afkPaths(cwd).configPath, { warn: () => undefined });
      const postDone = readValidationMoments(gateConfig).post_done;
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
          hasHarness: postDone !== undefined && postDone.length > 0,
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
        {
          resourceBudget: readValidationResourceBudget(config),
          setupCommands: readSetupCommands(config),
        },
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
      if (!(await mergeDriverIsTicking(root))) {
        throw new Error(
          `merge_arm refused for PR #${input.pr}: missing live merge-driver process; no tick source will act on this record`,
        );
      }
      const store = createFileMergeDriverStore(createEnginePaths(join(root, ".red")));
      const record = await armPr(store, input.pr, Math.floor(Date.now() / 1000));
      return { armed: { pr: record.pr, status: record.status, armed_at_epoch: record.armedAtEpoch } };
    },
    async mergeStatus() {
      const store = createFileMergeDriverStore(createEnginePaths(join(root, ".red")));
      const state = await store.read();
      const ticking = await mergeDriverIsTicking(root);
      return {
        driver: { process: "merge-driver", status: ticking ? "ticking" : "missing" },
        prs: Object.values(state.prs).map((record) => ({
          pr: record.pr,
          status: record.status,
          ...(record.status === "armed"
            ? { actionability: ticking ? "driver-ticking" : "orphaned" }
            : {}),
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
          verifyBaseFreshness: (body) => verifyFreshBase(context.root, body),
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
