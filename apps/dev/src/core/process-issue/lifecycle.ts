import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "../base-resolver.js";
import {
  buildRefFromSlug,
  deleteRemote,
  pushAttempt,
  slugifyRef,
  type GitExec,
} from "../remote-branch.js";
import { buildHandoff, exitProtocolFor, type HandoffComment } from "../handoff.js";
import { assignOutputShaping, type OutputShapingConfig } from "../output-shaping.js";
import { evaluateGoalPredicate } from "../goal-predicate.js";
import {
  type AgentOutcome,
  type AgentEffort,
  type AgentStreamEvent,
  type AttemptProgressInfo,
  DONE_SIGNAL,
  type RunAgentInput,
  type RunAgentResult,
  type SandboxMode,
} from "../execution.js";
import {
  runFeedback,
  isInfraFeedbackFailure,
  type Exec as PnpmExec,
  type PackageLayout,
  type RunFeedbackResult,
} from "../feedback.js";
import {
  planMainRedRepair,
  type MainRedRepairIssue,
} from "../main-red-repair.js";
import {
  computeValidationScope,
  formatValidationScope,
  scopesForValidationScope,
  type ValidationScope,
  type WorkspaceGraph,
} from "../validation-scope.js";
import {
  runBackpressure,
  renderBackpressureReviewBody,
  type BackpressureExec,
  type BackpressureCheck,
} from "../backpressure.js";
import { runPostAttemptFormat, type PostAttemptFormatExec } from "../post-attempt-format.js";
import {
  openReviewPr,
  openManualLandingPr,
  type Exec as MergeExec,
  type ConflictResolver,
  type WaitForReviewInput,
  type CiAwaitInput,
} from "../merge.js";
import type { LandLock } from "../land-lock.js";
import { doLanding } from "../landing.js";
import { reconcile, type ReconcileInput } from "../reconcile.js";
import { ExitBarrierError, type ExitReceipt, type TerminalReceipt } from "../exit-barrier.js";
import { markProcessSafetyStep } from "../process-safety.js";
import {
  emitEnvelope,
  type EmitEnvelopeDeps,
  type SectionBodies,
} from "../envelope-emit.js";
import { dispatchHooks, type HookExec } from "../hook-dispatcher.js";
import { type RecoveryEnv } from "../recovery.js";
import { dispose } from "../disposition.js";
import {
  blockedLabelFor,
  envelopeStatusFor,
  type AttemptOutcome,
} from "../attempt-outcome.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "../hook-config.js";
import { formatStartedMarker } from "../heartbeat.js";
import { cascadeAuditCommentFor, parseReqLabels, planCloseCascade, type DependentIssue } from "../boot-sweep.js";
import { buildAttemptRecordPayload, deriveIssueType, type AttemptRecordPayload } from "../attempt-record.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import { acquireClaim, renderClaimComment, type ClaimGh, type ClaimReconcileOptions, type ClaimDecision } from "../claim.js";
import { applyCurrentBlockerEdit, parseCurrentBlocker, type CurrentBlocker } from "../blocker-state.js";
import {
  parseTrustPolicy,
  evaluateClaimTrust,
  resolveActorTrust,
  describeTrustPosture,
  type TrustProvenance,
  type RepoVisibility,
  type ActorTrustSignals,
} from "../trust-gate.js";
import { getConfig } from "../config.js";
import type { AfkModelTier, ConfigValues } from "../config.js";
import { runNotesLoop, notesPath, type NotesLoopConfig } from "../notes-loop.js";
import {
  buildIssueClassificationMetadata,
  shouldRequestReview,
  type IssueClassificationMetadata,
  type ReviewGateConfig,
} from "../issue-classifier.js";
import type { AttemptStatus } from "../envelope.js";
import type { Runner } from "../../types/runner.js";
import { runnerSupportsStructuredOutput, toAgentRunner } from "../runner-spec.js";
import type { HistoryClock } from "../history.js";
import { DEFAULT_GO_VERIFY_RETRIES, LABEL_GO_LANE } from "../go.js";
import { setActiveClaimFinalizer } from "../process-safety.js";
import {
  LABEL_READY,
  LABEL_RUNNING,
  LABEL_HUMAN,
  LABEL_DEPENDENCY,
  LABEL_READY_FOR_REVIEW,
  LABEL_LANDING_MANUAL,
  LABEL_SENSITIVE_PATH,
  LABEL_SPEC,
} from "../triage-labels.js";
import {
  IllegalIssueLifecycleTransitionError,
  validateIssueLifecycleTransition,
  type IssueLifecycleEdge,
} from "../issue-lifecycle.js";
import {
  allowlistExternalWidened,
  ALLOWLIST_PATH,
  checkSensitivePaths,
  gateVerdict,
  type GateStageOutcome,
  type SensitivePathHit,
} from "../shared-gate.js";
import { isPrePrPipelineActive } from "../pre-pr-pipeline.js";
import {
  aggregateAdversarialReviewFindings,
  appendAdversarialReviewCorrectionHandoff,
  decideAdversarialReview,
  renderAdversarialReviewBlockerSummary,
  renderAdversarialReviewComment,
  resolveAdversarialReviewer,
  type AdversarialReviewFindings,
} from "../adversarial-review.js";
import type { ProcessIssueDeps, ProcessIssueInput, ProcessIssueResult, WorkerBaseResolution, ProcessOutcome } from "./types.js";
import { baseResolutionStatePatch, formatBaseResolution, isMergeConflictRetry, markTerminalState, recoveryOrdinalFor, remoteTrackingBaseRef, resolveSpawnTier } from "./types.js";
import { MECHANICAL_BLOCKER_KINDS, appendGoVerifyRetryHandoff, blockedLabelsIn, editIssueLifecycleLabels, formatNoSourceChangeWarning, hasLikelySourceChanges, parseFeedbackClass, refuseNoSandboxForUntrustedAuthor, resolveGoVerifyRetries, resolveUntrustedAuthorSandbox, scoutCapturedDone, scoutReportFrom, syncMainRedRepairIssue } from "./recovery.js";
import { abortAfterClaim, claimLost, emitBackpressureReview, emitDone, handoffForManualLanding, handoffForReview, hookContext, isRunnerRecoverableOutcome, mergeFailed, ciBlocked, prLandingBlocked, trunkDivergedBlocked, sensitivePathGuarded, mainRedUntrackedBlocked, onErrorContext, parseHookEnv, postAttemptContext, recordAttemptBestEffort, reconcileInputFor, releaseOwnedClaim, runCascadeRebase, runCloseCascade, runnerRecoverable, terminalFailure, writeValidationSidecar, type StageCommon } from "./terminal.js";
export async function processIssue(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
): Promise<ProcessIssueResult> {
  const { issue } = input;
  const hooksFired: HookName[] = [];
  const startedEpoch = deps.nowEpoch();
  const resolved: ResolvedHooks = resolveHooks(deps.hooks.config, deps.hooks.resolveOptions);
  let ownsCommentClaim = false;
  const releaseClaim = async () => {
    if (ownsCommentClaim) {
      ownsCommentClaim = false;
      try {
        await releaseOwnedClaim(deps, input);
      } finally {
        setActiveClaimFinalizer(null);
      }
      return;
    }
    await deps.claimLock.release(issue);
  };
  let agentEnv: Record<string, string> | undefined;
  const fireHookCtx = async (name: HookName, context: string): Promise<{ context: string; aborted: boolean }> => {
    hooksFired.push(name);
    const result = await dispatchHooks(name, resolved[name], context, deps.hooks.exec, {
      env: deps.hooks.env ?? {},
      log: (line) => deps.appendIterLog(line),
    });
    if (name === "pre_worktree" && !result.aborted) {
      const parsed = parseHookEnv(result.context);
      if (parsed) agentEnv = parsed;
    }
    return result;
  };
  const fireHook = async (name: HookName, context: string): Promise<boolean> => {
    return !(await fireHookCtx(name, context)).aborted;
  };
  if (!(await deps.claimLock.acquire(issue))) {
    return claimLost(issue, hooksFired);
  }
  const laneLabel = input.laneLabel ?? LABEL_READY;
  const labels = await deps.gh.viewLabels(issue);
  if (!labels.includes(laneLabel)) {
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }
  if (deps.claimGh) {
    const decision = await acquireClaim(
      deps.claimGh,
      { worker: input.claimant ?? input.workerId, runner: input.runner },
      issue,
      { isStale: deps.claimStale, deathFor: deps.recoveredWorkerDeathCause },
    );
    if (decision.verdict === "lost") {
      await deps.claimLock.release(issue);
      return claimLost(issue, hooksFired, deps, decision);
    }
    ownsCommentClaim = true;
    setActiveClaimFinalizer(async () => {
      if (!ownsCommentClaim) return;
      ownsCommentClaim = false;
      await releaseOwnedClaim(deps, input);
    });
  } else if (labels.includes(LABEL_RUNNING)) {
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired, deps, undefined, "running label already present");
  }
  const activeBlocker = parseCurrentBlocker(input.body);
  if (activeBlocker && !MECHANICAL_BLOCKER_KINDS.has(activeBlocker.kind)) {
    await deps.gh.ensureLabel(LABEL_SPEC);
    await editIssueLifecycleLabels(deps, issue, labels, [LABEL_READY], [LABEL_HUMAN, LABEL_SPEC], "preflight-blocked");
    await deps.gh.comment(
      issue,
      `🤖 /afk preflight stopped: active Current blocker (${activeBlocker.kind}) still requires human input: ${activeBlocker.next}`,
    );
    await releaseClaim();
    return {
      outcome: "blocked",
      issue,
      hooksFired,
      preserved: false,
      swept: false,
    };
  }
  const visibility = deps.gh.repoVisibility ? await deps.gh.repoVisibility() : undefined;
  const trustPolicy = parseTrustPolicy(deps.hooks.config, visibility);
  let provenance: TrustProvenance | undefined;
  if (deps.gh.issueTrust) {
    provenance = await deps.gh.issueTrust(issue);
  }
  const canFailClosed = !!(trustPolicy.failClosed && deps.gh.actorTrustSignals);
  if ((trustPolicy.enabled || canFailClosed) && provenance) {
    const signals = deps.gh.actorTrustSignals;
    const lookup = signals ? (login: string) => signals(login) : async () => ({});
    const verdict = await evaluateClaimTrust(trustPolicy, provenance, lookup);
    if (!verdict.executable) {
      deps.appendIterLog(
        `🤖 /afk trust gate refused #${issue} [${describeTrustPosture(trustPolicy)}]: ${verdict.reason} — not claimed; no worktree/handoff materialised.`,
      );
      await releaseClaim();
      return claimLost(issue, hooksFired, deps, undefined, verdict.reason);
    }
  }
  const sandboxDecision = await resolveUntrustedAuthorSandbox(deps, trustPolicy, provenance);
  if (sandboxDecision.refused) {
    const reason = sandboxDecision.reason ?? "untrusted issue author requires container isolation";
    deps.appendIterLog(`🤖 /afk sandbox policy refused #${issue}: ${reason}.`);
    return refuseNoSandboxForUntrustedAuthor(deps, input, hooksFired, reason);
  }
  if (!sandboxDecision.authorTrusted && sandboxDecision.sandboxMode !== (deps.sandboxMode ?? "none")) {
    deps.appendIterLog(
      `🤖 /afk sandbox policy: untrusted issue author forced ${sandboxDecision.sandboxMode} isolation for #${issue}.`,
    );
  }
  const claimRemoveLabels = [LABEL_READY, ...blockedLabelsIn(labels)];
  const promoted = await editIssueLifecycleLabels(deps, issue, labels, claimRemoveLabels, [LABEL_RUNNING], "claim");
  if (!promoted && !deps.claimGh) {
    await releaseClaim();
    return claimLost(issue, hooksFired);
  }
  deps.recordWorkerEvent?.("worker.claimed", { title: input.title });
  const slug = slugifyRef(input.title);
  const branch = buildRefFromSlug("afk", input.workerId, issue, slug);
  if (branch === null) {
    await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], [LABEL_READY], "retry");
    await releaseClaim();
    return claimLost(issue, hooksFired);
  }
  const base = await resolveBase(input.baseInput, deps.lookups.base);
  const trunk = (deps.lookups.base.configTrunk ?? "").trim() || "main";
  const startedAt = deps.nowIso();
  await deps.fs.ensureAttemptDir(input.attemptDir);
  await deps.gh.comment(
    issue,
    `🤖 /afk started at \`${startedAt}\` on runner \`${input.runner}\` (worker \`${input.workerId}\`). branch: \`${branch}\``,
  );
  if (!(await fireHook("pre_worktree", hookContext({ issue, title: input.title, target: branch, branch })))) {
    return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_worktree");
  }
  const comments = await deps.lookups.comments(issue);
  const url = await deps.lookups.issueUrl(issue);
  const priorAttemptContext = await deps.lookups.priorAttemptContext(issue);
  const outputShaping = assignOutputShaping(issue, deps.outputShaping ?? { terseSteering: false });
  const handoff = buildHandoff({
    issue,
    title: input.title,
    body: input.body,
    runner: input.runner,
    started: startedAt,
    attempt: input.attempt,
    url,
    comments,
    priorAttemptContext,
    specRef: input.specRef,
    mergeGateCommands: deps.backpressureCommands ?? [],
    outputShaping,
  });
  deps.markState?.({
    "current.output_shaping_enabled": outputShaping.enabled,
    "current.output_shaping_variant": outputShaping.variant,
  });
  const handoffPath = `${input.attemptDir}/handoff.md`;
  await deps.fs.writeHandoff(handoffPath, handoff);
  deps.appendIterLog(formatStartedMarker(issue, startedAt));
  deps.recordWorkerEvent?.("worker.steered", {
    handoff: handoffPath,
    output_shaping: outputShaping.variant,
  });
  const taskClass =
    (await deps
      .classifyIssue?.(
        buildIssueClassificationMetadata({
          issue,
          title: input.title,
          body: input.body,
          labels,
        }),
      )
      .catch(() => undefined)) ?? "think";
  if (
    !(await fireHook(
      "pre_attempt",
      hookContext({ issue, title: input.title, workspace: branch, runner: input.runner, attempt_n: input.attempt }),
    ))
  ) {
    return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
  }
  let baseResolution: WorkerBaseResolution;
  if (deps.git.resolveFreshBase) {
    baseResolution = await deps.git.resolveFreshBase({ base, remote: input.remote });
  } else {
    if (deps.git.fetchBase) await deps.git.fetchBase(base);
    baseResolution = {
      ok: true,
      base,
      baseRef: remoteTrackingBaseRef(input.remote, base),
      sha: "",
      source: "remote",
      remoteReachable: true,
    };
  }
  deps.markState?.(baseResolutionStatePatch(baseResolution));
  if (!baseResolution.ok) {
    const staleCommon: StageCommon = {
      deps,
      input,
      branch,
      base,
      slug,
      hooksFired,
      startedEpoch,
      issueType: deriveIssueType(labels),
      modelTier: taskClass,
      model: deps.model,
      effort: deps.effort,
      resolvedBase: baseResolution,
    };
    const message = baseResolution.message ?? "Base is stale; remote is unreachable and local ref is behind.";
    return await terminalFailure(staleCommon, "base-stale", "base-stale", {
      notes: message,
      log: message,
    });
  }
  const baseRef = baseResolution.baseRef;
  await deps.git.prepareFreshWorkerBranch?.({
    branch,
    baseRef,
    force: isMergeConflictRetry(priorAttemptContext),
  });
  let activeRunner: Runner = toAgentRunner(input.runner);
  let attemptN = input.attempt;
  let activeTaskClass: AfkModelTier = taskClass;
  const issueType = deriveIssueType(labels);
  let escalatedSimpleFeedback = false;
  let workerBranch = branch;
  let current: ProcessIssueInput = { ...input, runner: activeRunner, attempt: attemptN };
  let common: StageCommon = {
    deps,
    input: current,
    branch: workerBranch,
    base,
    slug,
    hooksFired,
    startedEpoch,
    issueType,
    modelTier: activeTaskClass,
    model: deps.model,
    effort: deps.effort,
    resolvedBase: baseResolution,
  };
  let validationSidecar: string[] = [];
  let lastValidationScope: ValidationScope | undefined = undefined;
  let landingFeedbackScopes: string[] = ["."];
  let noSourceDiffWarning: string | undefined;
  let mainRed = false;
  let mainRedRepairSyncFailure: string | null = null;
  let currentHandoff = handoff;
  let goVerifyRetriesUsed = 0;
  let adversarialReviewCorrectionsUsed = 0;
  let pendingAdversarialCorrection:
    | { diff: string; findings: AdversarialReviewFindings; retry: number; cap: number }
    | undefined;
  let pendingAdversarialPark:
    | { findings: AdversarialReviewFindings; cap: number }
    | undefined;
  let salvagedUncommittedFiles = 0;
  let salvagedUncommittedOutcome: RunAgentResult["outcome"] | undefined;
  let salvagedRunCommitCount = 0;
  let exitReceipt: ExitReceipt | undefined;
  const scoutTextChunks: string[] = [];
  const agentEventSink: typeof deps.recordAgentEvent =
    input.runMode === "scout"
      ? (event: AgentStreamEvent) => {
          if (event.type === "text") scoutTextChunks.push(event.message);
          deps.recordAgentEvent?.(event);
        }
      : deps.recordAgentEvent;
  const salvagedUncommittedNotes = (gate: "feedback" | "backpressure"): string => {
    const prefix =
      salvagedRunCommitCount === 0
        ? `Inner agent emitted ${salvagedUncommittedOutcome} with zero commits`
        : `Inner agent emitted ${salvagedUncommittedOutcome} after ${salvagedRunCommitCount} commit(s) and left dirty worktree paths`;
    const gateText =
      gate === "feedback"
        ? "feedback validation failed"
        : "backpressure validation failed after the feedback gate passed";
    return `${prefix}; AFK salvaged ${salvagedUncommittedFiles} uncommitted file(s), but ${gateText}. The worker branch was not merged.`;
  };
  const goVerifyRetryCap = resolveGoVerifyRetries(deps);
  const retryGoMachineGate = async (gate: "feedback" | "backpressure", validation: string): Promise<boolean> => {
    if (input.laneLabel !== LABEL_GO_LANE) return false;
    if (goVerifyRetriesUsed >= goVerifyRetryCap) return false;
    goVerifyRetriesUsed += 1;
    attemptN += 1;
    currentHandoff = appendGoVerifyRetryHandoff(handoff, {
      gate,
      validation,
      retry: goVerifyRetriesUsed,
      cap: goVerifyRetryCap,
    });
    deps.appendIterLog(
      `🤖 /go: ${gate} machine gate failed after DONE; correction retry ${goVerifyRetriesUsed}/${goVerifyRetryCap}.`,
    );
    return await fireHook(
      "pre_attempt",
      hookContext({ issue, title: input.title, workspace: branch, runner: activeRunner, attempt_n: attemptN }),
    );
  };
  while (true) {
    const initialTier = resolveSpawnTier(deps, activeRunner, activeTaskClass);
    const baseAgentInput: RunAgentInput = {
      runner: activeRunner,
      model: initialTier.model,
      effort: initialTier.effort,
      handoffPath,
      handoffContent: currentHandoff,
      systemPrompt: exitProtocolFor({
        runMode: input.runMode,
        structuredOutput: runnerSupportsStructuredOutput(toAgentRunner(activeRunner)),
        runner: activeRunner,
      }),
      branch,
      base: baseRef,
      cwd: input.attemptDir,
      logPath: `${input.attemptDir}/afk.log`,
      onAgentEvent: agentEventSink,
      onHeartbeat: (info) => {
        const vitals = deps.heartbeatVitals?.();
        void fireHook(
          "on_heartbeat",
          hookContext({
            issue,
            title: input.title,
            workspace: branch,
            runner: activeRunner,
            attempt_n: attemptN,
            ...(vitals ? { vitals } : {}),
          }),
        );
        deps.emitHeartbeat?.({ ...info, base });
      },
      remote: input.remote,
      continuousPush: input.runMode !== "scout",
      goalProbe: () => deps.gh.issueClosed(issue),
      env: agentEnv,
      sandboxMode: sandboxDecision.sandboxMode,
    };
    const notesLoopCfg: NotesLoopConfig = deps.notesLoop ?? {
      enabled: false,
      maxIterations: 1,
      innerMaxIterations: 0,
      tokenBudget: 0,
      wallClockS: 0,
    };
    const notesOutcome = await runNotesLoop({
      config: notesLoopCfg,
      baseHandoff: currentHandoff,
      runOnce: ({ handoff: iterationHandoff }) =>
        deps.runAgent({
          ...baseAgentInput,
          handoffContent: iterationHandoff,
          ...(notesLoopCfg.enabled && notesLoopCfg.innerMaxIterations > 0
            ? { maxIterations: notesLoopCfg.innerMaxIterations }
            : {}),
        }),
      persistNotes: (content) => deps.writeNotes?.(notesPath(input.attemptDir), content),
      now: () => deps.nowEpoch() * 1000,
      tokensSpent: () => {
        const vitals = deps.heartbeatVitals?.();
        return vitals ? (vitals.input_tokens ?? 0) + (vitals.output_tokens ?? 0) : 0;
      },
      log: (message) => deps.appendIterLog(message),
    });
    let run: RunAgentResult = notesOutcome.run;
    if (isRunnerRecoverableOutcome(run.outcome)) {
      if (!deps.fallbackRunner) {
        return await runnerRecoverable(deps, input, branch, base, hooksFired, activeRunner, run.outcome, false);
      }
      await fireHook("post_attempt", postAttemptContext({ ...input, attempt: attemptN }, branch, "fail", run.outcome));
      const other: Runner = activeRunner === "claude" ? "codex" : "claude";
      activeRunner = other;
      attemptN += 1;
      if (
        !(await fireHook(
          "pre_attempt",
          hookContext({ issue, title: input.title, workspace: branch, runner: activeRunner, attempt_n: attemptN }),
        ))
      ) {
        return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
      }
      const fallbackTier = resolveSpawnTier(deps, other, activeTaskClass);
      run = await deps.runAgent({
        runner: other,
        model: fallbackTier.model,
        effort: fallbackTier.effort,
        handoffPath,
        handoffContent: currentHandoff,
        systemPrompt: exitProtocolFor({
          runMode: input.runMode,
          structuredOutput: runnerSupportsStructuredOutput(toAgentRunner(other)),
          runner: other,
        }),
        branch,
        base,
        cwd: input.attemptDir,
        logPath: `${input.attemptDir}/afk.log`,
        onAgentEvent: agentEventSink,
        remote: input.remote,
        continuousPush: input.runMode !== "scout",
        goalProbe: () => deps.gh.issueClosed(issue),
        env: agentEnv,
        sandboxMode: sandboxDecision.sandboxMode,
      });
      if (isRunnerRecoverableOutcome(run.outcome)) {
        await fireHook("post_attempt", postAttemptContext({ ...input, attempt: attemptN }, branch, "fail", run.outcome));
        return await runnerRecoverable(deps, input, branch, base, hooksFired, activeRunner, run.outcome, true);
      }
    }
    workerBranch = run.branch || branch;
    current = { ...input, runner: activeRunner, attempt: attemptN };
    common = {
      deps,
      input: current,
      branch: workerBranch,
      base,
      slug,
      hooksFired,
      startedEpoch,
      issueType,
      modelTier: activeTaskClass,
      model: initialTier.model,
      effort: initialTier.effort,
    } satisfies StageCommon;
    if (input.runMode === "scout" && run.outcome === "no-sentinel" && scoutCapturedDone(run, scoutTextChunks)) {
      deps.appendIterLog(
        "🤖 /scout: AgentOutput was missing, but the captured agent stream ended with DONE — posting the recovered scout report.",
      );
      run = { ...run, outcome: "done", completionSignal: run.completionSignal ?? DONE_SIGNAL };
    }
    if (deps.exitBarrier && run.outcome === "done") {
      try {
        markProcessSafetyStep("exit-barrier:start");
        exitReceipt = await deps.exitBarrier(workerBranch);
        markProcessSafetyStep("exit-barrier:pushed");
      } catch (err) {
        markProcessSafetyStep("exit-barrier:failed");
        if (err instanceof ExitBarrierError) {
          await fireHook("on_attempt_error", onErrorContext(current, workerBranch, "merge-conflict", current.attempt));
          return await terminalFailure(common, "merge-conflict", "merge-conflict", {
            notes: `_(exit barrier: could not push the attempt branch \`${workerBranch}\` to origin after retry — work is NOT confirmed saved, so the attempt is not reported as cleanly done)_`,
            log: String(err),
          });
        }
        throw err;
      }
      if (exitReceipt.salvagedFiles > 0) {
        salvagedUncommittedFiles = exitReceipt.salvagedFiles;
        salvagedUncommittedOutcome = run.outcome;
        salvagedRunCommitCount = run.commits.length;
        const commitFact =
          run.commits.length === 0
            ? "committed nothing"
            : `left dirty worktree paths after ${run.commits.length} commit(s)`;
        deps.appendIterLog(
          `🤖 /afk: inner agent emitted done but ${commitFact} — exit barrier salvaged ${exitReceipt.salvagedFiles} uncommitted file(s) onto \`${workerBranch}\` and pushed to origin (receipt head ${exitReceipt.head || "?"}).`,
        );
      } else {
        deps.appendIterLog(
          `🤖 /afk: exit barrier pushed \`${workerBranch}\` to origin (clean worktree; receipt head ${exitReceipt.head || "?"}).`,
        );
      }
    } else if (deps.salvageUncommitted && (run.outcome === "done" || run.outcome === "no-sentinel")) {
      const salvagedFiles = await deps.salvageUncommitted(workerBranch).catch(() => 0);
      if (salvagedFiles > 0) {
        salvagedUncommittedFiles = salvagedFiles;
        salvagedUncommittedOutcome = run.outcome;
        salvagedRunCommitCount = run.commits.length;
        const commitFact =
          run.commits.length === 0
            ? "committed nothing"
            : `left dirty worktree paths after ${run.commits.length} commit(s)`;
        deps.appendIterLog(
          `🤖 /afk: inner agent emitted ${run.outcome} but ${commitFact} — salvaged ${salvagedFiles} uncommitted file(s) onto \`${workerBranch}\` so the feedback gate + landing see the work.`,
        );
      }
    }
    let salvaged = false;
    if (run.outcome === "no-sentinel") {
      const branchHasWork =
        input.runMode !== "scout" &&
        (await deps.lookups.changedFiles(workerBranch, baseRef)).length > 0 &&
        (!deps.lookups.branchPresent || (await deps.lookups.branchPresent(workerBranch)));
      if (!branchHasWork) {
        await fireHook("on_attempt_error", onErrorContext(current, workerBranch, "no-sentinel", current.attempt));
        return await terminalFailure(common, "no-sentinel", "no-sentinel", {
          notes: "_(no Notes appended; inner agent exited without a sentinel and the branch carries no work)_",
          log: run.stdout ? run.stdout.split("\n").slice(-1)[0] || "(no captured stdout)" : "(no captured stdout)",
        });
      }
      salvaged = true;
      deps.appendIterLog(
        `🤖 /afk: no-sentinel exit but worker branch \`${workerBranch}\` carries work — salvaging through the feedback gate (issue #332).`,
      );
      await fireHook("post_attempt", postAttemptContext(current, workerBranch, "success", "no-sentinel"));
    } else if (run.outcome === "goal-moot") {
      const ownMerge = deps.lookups.branchMerged
        ? await deps.lookups.branchMerged(workerBranch, base).catch(() => false)
        : false;
      const verdict = evaluateGoalPredicate({ closed: true, ownMerge });
      const outcome: ProcessOutcome = verdict === "done" ? "done" : "claim-lost";
      await fireHook(
        "post_attempt",
        postAttemptContext(current, workerBranch, verdict === "done" ? "success" : "fail", "goal-moot"),
      );
      deps.appendIterLog(
        verdict === "done"
          ? `🤖 /afk #${issue}: goal predicate — issue already CLOSED by this attempt's own merge; nothing to land (done).`
          : `🤖 /afk #${issue}: goal predicate — issue already CLOSED by another lander; attempt mooted (claim-lost).`,
      );
      try {
        await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
      } catch {
      }
      await releaseClaim();
      return {
        outcome,
        issue,
        branch: workerBranch,
        base,
        hooksFired,
        preserved: false,
        swept: false,
      };
    } else {
      const pwStatus = run.outcome === "done" ? "success" : "fail";
      await fireHook("post_attempt", postAttemptContext(current, workerBranch, pwStatus, run.outcome));
      if (run.outcome === "blocked") {
        return await terminalFailure(common, "blocked", "blocked", {
          notes: `_(inner agent emitted BLOCKED — see iteration log at \`${input.attemptDir}\`)_`,
        });
      }
    }
    if (input.runMode === "scout") {
      const report = scoutReportFrom(scoutTextChunks, run.stdout);
      await deps.gh.comment(issue, `## 🔍 Scout Report\n\n${report}`);
      await deps.gh.close(issue);
      await releaseClaim();
      return {
        outcome: "done",
        issue,
        hooksFired,
        preserved: false,
        swept: false,
      };
    }
    if (deps.lookups.branchPresent && !(await deps.lookups.branchPresent(workerBranch))) {
      markProcessSafetyStep("post-barrier:branch-present-failed");
      deps.appendIterLog(
        `🤖 /afk: worker branch \`${workerBranch}\` absent on host — sandcastle commits did not reach the host; escalating.`,
      );
      return await mergeFailed(common, "worker branch absent — sandcastle commits did not reach the host");
    }
    const postAttemptFormatCommands = deps.postAttemptFormatCommands ?? [];
    if (deps.postAttemptFormat && postAttemptFormatCommands.length > 0) {
      markProcessSafetyStep("post-barrier:post-attempt-format");
      const pfmt = await runPostAttemptFormat(deps.postAttemptFormat, {
        worktree: workerBranch,
        commands: postAttemptFormatCommands,
        now: deps.nowEpoch,
      });
      for (const line of pfmt.log) deps.appendIterLog(`🤖 /afk: ${line}`);
      if (!pfmt.ok) {
        return await abortAfterClaim(deps, input, branch, base, hooksFired, "post_attempt_format");
      }
    }
    deps.markPhase?.("validating");
    markProcessSafetyStep("post-barrier:feedback-start");

    /**
     * Read the branch diff the trust checks scan: changed paths, the
     * `package.json` diff (for lifecycle scripts), and the TOON-allowlist shrink
     * exemption. Shared by the pre-validation trust scan (ADR 0119) and the
     * landing's own step-0a guard.
     *
     * Deliberately NOT memoised: the landing guard is a trust boundary and must
     * judge the diff as it stands at merge time, not a snapshot taken before
     * validation. Two `git diff` calls are noise next to the suite this ordering
     * saves.
     */
    const resolveDiffPaths = async (): Promise<{
      changedFiles: string[];
      packageJsonDiff: string;
      allowlistExemption?: { path: string; safe: boolean };
    }> => {
      const filesRes = await deps.mergeExec([
        "git", "-C", input.repoDir,
        "diff", "--name-only",
        `${input.remote}/${base}...${workerBranch}`,
      ]);
      const diffFiles = filesRes.stdout.trim().split("\n").filter(Boolean);
      const diffRes = await deps.mergeExec([
        "git", "-C", input.repoDir,
        "diff",
        `${input.remote}/${base}...${workerBranch}`,
        "--",
        "package.json", "**/package.json",
      ]);
      let allowlistExemption: { path: string; safe: boolean } | undefined;
      if (diffFiles.includes(ALLOWLIST_PATH)) {
        const oldContent = (
          await deps.mergeExec(["git", "-C", input.repoDir, "show", `${input.remote}/${base}:${ALLOWLIST_PATH}`])
        ).stdout;
        const newContent = (
          await deps.mergeExec(["git", "-C", input.repoDir, "show", `${workerBranch}:${ALLOWLIST_PATH}`])
        ).stdout;
        allowlistExemption = { path: ALLOWLIST_PATH, safe: !allowlistExternalWidened(oldContent, newContent) };
      }
      return { changedFiles: diffFiles, packageJsonDiff: diffRes.stdout, allowlistExemption };
    };

    const changedFiles = await deps.lookups.changedFiles(workerBranch, baseRef);
    if (changedFiles.length === 0) {
      const validationText =
        "DONE rejected: attempt branch has no diff against the merge-base; no work changed, so the completion claim was not accepted.";
      deps.appendIterLog(`🤖 /afk: ${validationText}`);
      if (await retryGoMachineGate("feedback", validationText)) {
        continue;
      }
      return await terminalFailure(common, "feedback-failed", "feedback", {
        notes: "Inner agent emitted DONE, but the attempt branch has no diff against the merge-base. The worker branch was not merged.",
        validation: validationText,
      }, { validationSummary: validationText });
    }
    noSourceDiffWarning = hasLikelySourceChanges(changedFiles)
      ? undefined
      : formatNoSourceChangeWarning(changedFiles);
    if (noSourceDiffWarning) {
      deps.appendIterLog(`🤖 /afk: ${noSourceDiffWarning}`);
    }
    const validationScope = computeValidationScope(
      changedFiles,
      deps.layout,
      deps.graph ?? { packages: [] },
    );
    const feedbackScopes = scopesForValidationScope(validationScope);
    landingFeedbackScopes = feedbackScopes;

    // The gate's stages accumulate here in GATE_STAGE_ORDER (ADR 0119) and fold
    // into ONE verdict: `gateVerdict(gateStages)` is what decides whether the
    // attempt may proceed, so "which stage blocked this" is read off the fold
    // rather than reassembled from control flow.
    const gateStages: GateStageOutcome[] = [];

    // TRUST BEFORE THE SUITE. A diff that touches a CI workflow, a git hook, a
    // lifecycle script, or `.red/` trust config can NEVER auto-land, so deciding
    // that here — a handful of regexes over a diff we already have — costs
    // seconds and saves the whole package suite. The landing keeps its own
    // step-0a scan as the backstop for the other callers (and for a diff that
    // grows between here and the merge), so this is an early exit, not a move.
    // A diff lookup that fails is NOT a verdict: log it, record the stage as
    // skipped, and let the landing-time guard decide instead of parking on a
    // git error.
    let trustHits: SensitivePathHit[] = [];
    try {
      const trustDiff = await resolveDiffPaths();
      trustHits = checkSensitivePaths(
        trustDiff.changedFiles,
        trustDiff.packageJsonDiff,
        trustDiff.allowlistExemption,
      );
      gateStages.push({ stage: "trust", ok: trustHits.length === 0, sensitivePaths: trustHits });
    } catch (error) {
      gateStages.push({ stage: "trust", ok: false, skipped: true });
      deps.appendIterLog(
        `🤖 /afk: pre-validation sensitive-path scan could not read the diff ` +
          `(${error instanceof Error ? error.message : String(error)}); the landing-time guard still applies.`,
      );
    }
    if (gateVerdict(gateStages).failedStage === "trust") {
      deps.appendIterLog(
        `🤖 /afk: sensitive-path guard tripped BEFORE validation — skipping the suite for #${issue}.`,
      );
      return await sensitivePathGuarded(common, trustHits, await deps.lookups.isLocked());
    }

    if (
      !(await fireHook(
        "pre_feedback",
        hookContext({ issue, title: input.title, workspace: branch, scopes: feedbackScopes }),
      ))
    ) {
      return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_feedback");
    }
    const feedback: RunFeedbackResult = await runFeedback(deps.pnpm, {
      worktree: workerBranch,
      scopes: feedbackScopes,
      layout: deps.layout,
      now: deps.nowEpoch,
      baselineWorktree: base,
      validationScope,
      resourceBudget: deps.validationResourceBudget,
    });
    markProcessSafetyStep("post-barrier:feedback-done");
    gateStages.push({ stage: "feedback", ok: feedback.ok });
    if (!feedback.ok) {
      await fireHook(
        "on_baseline_probe",
        hookContext({
          issue,
          title: input.title,
          workspace: branch,
          ok: feedback.ok,
          downgraded: feedback.baselineDowngraded,
        }),
      );
    }
    mainRed = feedback.baselineProbeRan === true && (feedback.baselineFailures?.length ?? 0) > 0;
    mainRedRepairSyncFailure = await syncMainRedRepairIssue(deps, feedback, baseResolution.sha);
    await fireHook(
      "post_feedback",
      hookContext({
        issue,
        title: input.title,
        workspace: branch,
        result: { status: feedback.ok ? "pass" : "fail" },
      }),
    );
    if (gateVerdict(gateStages).failedStage === "feedback") {
      await writeValidationSidecar(deps, input.attemptDir, feedback.sidecar);
      let isInfra = isInfraFeedbackFailure(feedback);
      const classResult = await fireHookCtx(
        "on_feedback_classify",
        hookContext({ issue, title: input.title, workspace: branch, class: isInfra ? "infra" : "semantic" }),
      );
      const classOverride = parseFeedbackClass(classResult.context);
      if (classOverride !== null) isInfra = classOverride === "infra";
      if (!isInfra && activeTaskClass === "simple" && !escalatedSimpleFeedback) {
        escalatedSimpleFeedback = true;
        activeTaskClass = "complex";
        attemptN += 1;
        deps.appendIterLog(
          `🤖 /afk: simple-tier feedback failed for #${issue}; retrying once on the complex tier before terminal validation routing.`,
        );
        if (
          !(await fireHook(
            "pre_attempt",
            hookContext({ issue, title: input.title, workspace: branch, runner: activeRunner, attempt_n: attemptN }),
          ))
        ) {
          return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
        }
        continue;
      }
      const outcome: ProcessOutcome = isInfra ? "feedback-failed-infra" : "feedback-failed";
      let notes: string;
      if (isInfra) {
        notes = `Feedback validation failed for an INFRA reason (worktree/submodule/pnpm install/OOM) on branch \`${workerBranch}\` — the recovery policy will retry up to its cap.`;
      } else if (salvagedUncommittedFiles > 0) {
        notes = salvagedUncommittedNotes("feedback");
      } else if (salvaged) {
        notes = "Salvaged a no-sentinel branch (it carried work), but feedback validation failed — the branch was not merged.";
      } else {
        notes = "Feedback validation failed after the inner agent emitted DONE. The worker branch was not merged.";
      }
      const scopeHeader = feedback.validationScope
        ? `${formatValidationScope(feedback.validationScope)}\n`
        : "";
      const validationText = `${scopeHeader}${feedback.sidecar.join("\n")}`;
      if (!isInfra && await retryGoMachineGate("feedback", validationText)) {
        continue;
      }
      return await terminalFailure(common, outcome, "feedback", {
        notes,
        validation: validationText,
      }, { validationSummary: feedback.sidecar.join("\n") });
    }
    const backpressureCommands = deps.backpressureCommands ?? [];
    let backpressureSidecar: string[] = [];
    if (deps.backpressure && backpressureCommands.length > 0) {
      markProcessSafetyStep("post-barrier:backpressure-start");
      const backpressure = await runBackpressure(deps.backpressure, {
        worktree: workerBranch,
        commands: backpressureCommands,
        now: deps.nowEpoch,
      });
      backpressureSidecar = backpressure.sidecar;
      markProcessSafetyStep("post-barrier:backpressure-done");
      common.backpressureChecks = backpressure.checks;
      gateStages.push({ stage: "backpressure", ok: backpressure.ok });
      if (gateVerdict(gateStages).failedStage === "backpressure") {
        await writeValidationSidecar(deps, input.attemptDir, [...feedback.sidecar, ...backpressure.sidecar]);
        const notes =
          salvagedUncommittedFiles > 0
            ? salvagedUncommittedNotes("backpressure")
            : "Backpressure validation failed after the feedback gate passed. The worker branch was not merged.";
        const validationText = backpressure.sidecar.join("\n");
        if (await retryGoMachineGate("backpressure", validationText)) {
          continue;
        }
        return await terminalFailure(common, "feedback-failed", "feedback", {
          notes,
          validation: validationText,
        }, { validationSummary: validationText });
      }
    }
    validationSidecar = [...feedback.sidecar, ...backpressureSidecar];
    lastValidationScope = feedback.validationScope;
    // ONE verdict for the whole gate (ADR 0119): the stages accumulated above
    // fold into a single `ok` instead of three independent booleans a reader has
    // to reassemble. A backpressure stage that never ran is simply absent from
    // the fold, and an absent stage cannot block.
    const gateOk = gateVerdict(gateStages).ok;
    deps.recordWorkerEvent?.("worker.validated", {
      feedback_records: feedback.sidecar.length,
      backpressure_records: backpressureSidecar.length,
      scope: feedback.validationScope?.type ?? "",
      gate_ok: gateOk,
    });

  markProcessSafetyStep("post-barrier:landing-start");
  const locked = await deps.lookups.isLocked();
  const openPr = deps.worktreeLaunchesPr !== false;
  if (labels.includes(LABEL_LANDING_MANUAL)) {
    return await handoffForManualLanding(common, base, validationSidecar);
  }
  if (openPr && deps.reviewGate && shouldRequestReview(activeTaskClass, deps.reviewGate)) {
    return await handoffForReview(common, activeTaskClass, validationSidecar);
  }
  const markLandingPhase = (phase: "gate" | "push-pr" | "merge" | "cascade"): void => {
    const startedAt = deps.nowIso();
    deps.markState?.({
      "current.activity": "landing",
      "current.phase": phase,
      "current.started_at": startedAt,
    });
    deps.markPhase?.(phase);
  };
  const runAdversarialReview = async (pr: number): Promise<"abort" | void> => {
    const config = deps.adversarialReview;
    if (!config?.enabled || !deps.extractAdversarialReview || !deps.postAdversarialReview) return;
    // /go direct-PR skips adversarial review; /go no-mistakes and /afk run it.
    if (input.laneLabel === LABEL_GO_LANE && !isPrePrPipelineActive(input.runMode, input.laneLabel)) return;
    try {
      const diff = await deps.mergeExec(["gh", "-R", input.repo, "pr", "diff", String(pr)]);
      const context = {
        issueNumber: input.issue,
        issueTitle: input.title,
        issueBody: input.body,
        prNumber: pr,
        diff: diff.code === 0 ? diff.stdout : "",
      };
      const implementerTier = resolveSpawnTier(deps, activeRunner, activeTaskClass);
      const reviewer = resolveAdversarialReviewer({
        config,
        implementer: {
          runner: toAgentRunner(activeRunner),
          model: implementerTier.model,
          effort: implementerTier.effort,
        },
        taskClass: activeTaskClass,
        resolveTier: deps.resolveTier,
      });
      const reviews: AdversarialReviewFindings[] = [];
      for (let i = 0; i < config.reviewerCount; i++) {
        reviews.push(
          await deps.extractAdversarialReview({
            context,
            runner: reviewer.runner,
            model: reviewer.model,
            effort: reviewer.effort,
            maxIterations: config.maxIterations,
          }),
        );
      }
      const findings = aggregateAdversarialReviewFindings(reviews, config.quorum);
      const retry = adversarialReviewCorrectionsUsed + 1;
      const decision = decideAdversarialReview(findings, retry, config.maxIterations);
      await deps.postAdversarialReview({
        pr,
        issue: input.issue,
        findings,
        body: renderAdversarialReviewComment(findings, decision),
      });
      if (decision === "correct") {
        pendingAdversarialCorrection = {
          diff: diff.code === 0 ? diff.stdout : "",
          findings,
          retry,
          cap: config.maxIterations,
        };
        return "abort";
      }
      if (decision === "park") {
        pendingAdversarialPark = { findings, cap: config.maxIterations };
        return "abort";
      }
    } catch (error) {
      deps.appendIterLog(`[adversarial-review] advisory pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  markLandingPhase("gate");
  const landing = await doLanding(
    {
      mergeExec: deps.mergeExec,
      remoteGit: deps.remoteGit,
      fireHook,
      conflictResolver: deps.conflictResolver,
      resolveMechanicalConflict: deps.resolveMechanicalConflict,
      resolveAgentConflict: deps.resolveAgentConflict,
      maxAgentConflictResolveAttempts: deps.maxAgentConflictResolveAttempts,
      waitForReview: deps.waitForReview,
      ciAwait: deps.ciAwait,
      findMainRedRepairIssue: deps.gh.findMainRedRepairIssue,
      makeLandingWorktree: deps.makeLandingWorktree,
      removeLandingWorktree: deps.removeLandingWorktree,
      makeRebaseWorktree: deps.makeRebaseWorktree,
      removeRebaseWorktree: deps.removeRebaseWorktree,
      landLock: deps.landLock,
      onPrResolved: async (pr) => {
        await emitBackpressureReview(common, pr);
        return await runAdversarialReview(pr);
      },
      postMergeGate: async (mergedTreeDir) => {
        const mergedFeedback = await runFeedback(deps.pnpm, {
          worktree: mergedTreeDir,
          scopes: landingFeedbackScopes,
          layout: deps.layout,
          now: deps.nowEpoch,
          baselineWorktree: base,
          validationScope: lastValidationScope,
          resourceBudget: deps.validationResourceBudget,
        });
        if (!mergedFeedback.ok) {
          validationSidecar = mergedFeedback.sidecar;
          await writeValidationSidecar(deps, input.attemptDir, mergedFeedback.sidecar);
          return { ok: false };
        }
        const gateBackpressureCommands = deps.backpressureCommands ?? [];
        if (deps.backpressure && gateBackpressureCommands.length > 0) {
          const mergedBackpressure = await runBackpressure(deps.backpressure, {
            worktree: mergedTreeDir,
            commands: gateBackpressureCommands,
            now: deps.nowEpoch,
          });
          common.backpressureChecks = mergedBackpressure.checks;
          validationSidecar = [...mergedFeedback.sidecar, ...mergedBackpressure.sidecar];
          if (!mergedBackpressure.ok) {
            await writeValidationSidecar(deps, input.attemptDir, validationSidecar);
          }
          return { ok: mergedBackpressure.ok };
        }
        validationSidecar = mergedFeedback.sidecar;
        return { ok: true };
      },
      // The same resolver the pre-validation trust scan used (ADR 0119). The
      // landing re-reads it so its step-0a guard judges the diff as it stands at
      // merge time, not the snapshot taken before validation.
      getDiffPaths: resolveDiffPaths,
      landingPhase: markLandingPhase,
    },
    {
      openPr,
      locked,
      repo: input.repo,
      repoDir: input.repoDir,
      remote: input.remote,
      branch: workerBranch,
      base,
      trunk,
      issue,
      title: input.title,
      labels,
      mainRed,
      nativeMergeQueue: deps.nativeMergeQueue,
    },
    {
      preMerge: () =>
        hookContext({ issue, title: input.title, workspace: input.repoDir, branch: workerBranch, merge_base: base }),
      postMerge: (mergeSha?: string) =>
        hookContext({
          issue,
          title: input.title,
          workspace: input.repoDir,
          branch: workerBranch,
          merge_commit: mergeSha ? { sha: mergeSha, short: mergeSha.slice(0, 7) } : undefined,
        }),
    },
  );
  if (!landing.ok) {
    if (landing.reason === "adversarial-correction") {
      const park = pendingAdversarialPark;
      pendingAdversarialPark = undefined;
      if (park) {
        const validation = renderAdversarialReviewBlockerSummary(park.findings, park.cap);
        deps.appendIterLog(`🤖 /afk: ${validation} Parked to ready-for-human.`);
        return await terminalFailure(
          common,
          "feedback-failed",
          "feedback",
          {
            notes: "Blocking adversarial review findings remained after the configured correction budget. The worker branch was not merged.",
            validation,
          },
          { validationSummary: validation },
        );
      }
      const correction = pendingAdversarialCorrection;
      pendingAdversarialCorrection = undefined;
      if (!correction) {
        return await mergeFailed(common, "adversarial correction requested without captured findings", landing.locked);
      }
      adversarialReviewCorrectionsUsed = correction.retry;
      attemptN += 1;
      currentHandoff = appendAdversarialReviewCorrectionHandoff(handoff, correction);
      deps.appendIterLog(
        `🤖 /afk: adversarial review found blocking issue(s); correction retry ${correction.retry}/${correction.cap}.`,
      );
      if (
        !(await fireHook(
          "pre_attempt",
          hookContext({ issue, title: input.title, workspace: branch, runner: activeRunner, attempt_n: attemptN }),
        ))
      ) {
        return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
      }
      continue;
    }
    if (landing.reason === "trunk-diverged") {
      return await trunkDivergedBlocked(
        common,
        trunk,
        landing.localTrunkSha ?? "",
        landing.originTrunkSha ?? "",
        landing.locked,
      );
    }
    if (landing.reason === "sensitive-paths") {
      return await sensitivePathGuarded(common, landing.sensitivePaths ?? [], landing.locked);
    }
    if (landing.reason === "main-red-untracked") {
      return await mainRedUntrackedBlocked(
        common,
        landing.message ?? "Admin-merge refused: main is red without an open main-red repair issue.",
        landing.locked,
        mainRedRepairSyncFailure,
      );
    }
    if (landing.reason === "ci-failed" || landing.reason === "ci-pending") {
      return await ciBlocked(common, landing.reason, landing.prNumber);
    }
    if (landing.reason === "infra") {
      const reason = landing.infraReason ?? "landing infrastructure precondition failed";
      return await terminalFailure(
        common,
        "infra",
        "infra",
        { log: reason },
        { notes: reason },
      );
    }
    if (landing.reason === "pr-conflict") {
      return await prLandingBlocked(
        common,
        "merge-conflict",
        landing.prNumber,
        `the open PR has merge conflicts and could not be landed`,
      );
    }
    if (landing.reason === "pr-merge-failed") {
      return await prLandingBlocked(
        common,
        "ci-failed",
        landing.prNumber,
        `the open PR merge was rejected by GitHub, usually because branch protection or CI is not satisfied`,
      );
    }
    if (landing.reason === "post-merge-gate") {
      // The post-merge integration gate (#1335) rejected the integrated tree —
      // a VALIDATION outcome, never a merge conflict (#2339). The rebase that
      // precedes it already succeeded, so parking `blocked:merge-conflict` sent
      // humans down the wrong recovery path (same class as #2096), most visibly
      // when the gate could not even materialise its worktree and every check
      // short-circuited with `durationMs: 0`.
      const validation =
        validationSidecar.join("\n") ||
        "The post-merge integration gate failed on the rebased tree; nothing was merged.";
      return await terminalFailure(
        common,
        "feedback-failed",
        "feedback",
        {
          notes: "The post-merge integration gate failed; the worker branch was not merged.",
          validation,
        },
        { validationSummary: validation },
      );
    }
    return await mergeFailed(common, landing.reason, landing.locked);
  }
  const mergeSha = landing.mergeSha ?? (await deps.git.headShortSha());
  const durationS = deps.nowEpoch() - startedEpoch;
  markLandingPhase("cascade");
  deps.recordWorkerEvent?.("worker.landed", { merge_sha: mergeSha, base });
  await writeValidationSidecar(deps, input.attemptDir, validationSidecar);
  const posted = await emitDone(common, mergeSha, durationS, validationSidecar, lastValidationScope, noSourceDiffWarning);
  await recordAttemptBestEffort(common, "done", {
    durationS,
    mergeSha,
    validationSummary: [noSourceDiffWarning, validationSidecar.join("\n")].filter(Boolean).join("\n"),
    notes: exitReceipt
      ? `exit-barrier receipt: branch \`${exitReceipt.branch}\` pushed to origin at ${exitReceipt.pushedAt} (head ${exitReceipt.head || "?"}, salvaged ${exitReceipt.salvagedFiles} file(s)).`
      : undefined,
  });
  await deps.gh.close(issue);
  await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
  await deleteRemote(deps.remoteGit, input.repoDir, workerBranch);
  let cleanupError: string | undefined;
  try {
    const cleanup = await deps.git.deleteLocalBranch(workerBranch);
    if (cleanup && !cleanup.ok) cleanupError = cleanup.error;
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  if (cleanupError) {
    deps.appendIterLog(`🤖 /afk landing cleanup warning: ${cleanupError}`);
  }
  await deps.fs.completionSweep(issue);
  await deps.claimLock.release(issue);
  markTerminalState(deps, "done");
  await runCloseCascade(deps, issue);
  if (landing.mergeSha) {
    await runCascadeRebase(deps, input, issue, landing.mergeSha, labels);
  }
  return {
    outcome: "done",
    issue,
    branch: workerBranch,
    base,
    locked,
    mergeSha,
    ...(cleanupError ? { cleanupError } : {}),
    hooksFired,
    envelopePosted: posted,
    exitReceipt,
    preserved: true,
    swept: true,
  };
  }
}
