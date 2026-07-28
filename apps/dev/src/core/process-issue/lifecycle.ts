import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "../base-resolver.js";
import {
  buildRefFromSlug,
  deleteRemote,
  pushAttempt,
  slugifyRef,
  type GitExec,
} from "../remote-branch.js";
import { buildHandoff, buildHumanGuidance, exitProtocolFor, type HandoffComment } from "../handoff.js";
import {
  buildResumeInstruction,
  discoverResumableBranch,
  extractFailureReason,
  isExplicitRestartRequested,
  isGateGreenBranch,
  pullRequestMatchesAttempt,
  selectAttemptPullRequest,
} from "../branch-resume.js";
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
  buildValidationRecord,
  formatValidationLine,
  runFeedback,
  isInfraFeedbackFailure,
  type Exec as PnpmExec,
  type PackageLayout,
  type RunFeedbackResult,
} from "../feedback.js";
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
import { runPostWorkerFormat, type PostWorkerFormatExec } from "../post-worker-format.js";
import {
  openReviewPr,
  openManualLandingPr,
  type Exec as MergeExec,
  type ConflictResolver,
  type WaitForReviewInput,
  type CiAwaitInput,
} from "../merge.js";
import type { LandLock } from "../land-lock.js";
import { doLanding, type LandingPhase, type LandingPostMergeValidation } from "../landing.js";
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
  type WorkerOutcome,
} from "../worker-outcome.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "../hook-config.js";
import { formatStartedMarker } from "../heartbeat.js";
import { cascadeAuditCommentFor, parseReqLabels, planCloseCascade, type DependentIssue } from "../boot-sweep.js";
import { deriveIssueType } from "../outcome-record.js";
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
  type ExternalOriginState,
} from "../trust-gate.js";
import { getConfig } from "../config.js";
import type { AfkModelTier, ConfigValues } from "../config.js";
import { runNotesLoop, notesPath, type NotesLoopConfig } from "../notes-loop.js";
import { renderTrunkSyncNote, syncTrunkIntoBranch } from "../trunk-sync.js";
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
  LABEL_SPEC,
  LABEL_ORIGIN_EXTERNAL,
} from "../triage-labels.js";
import {
  IllegalIssueLifecycleTransitionError,
  validateIssueLifecycleTransition,
  type IssueLifecycleEdge,
} from "../issue-lifecycle.js";
import {
  gateVerdict,
  type GateStageOutcome,
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
import { MECHANICAL_BLOCKER_KINDS, appendAfkGateCorrectionHandoff, appendGoVerifyRetryHandoff, appendTierEscalationHandoff, blockedLabelsIn, editIssueLifecycleLabels, formatNoSourceChangeWarning, hasLikelySourceChanges, parseFeedbackClass, refuseNoSandboxForUntrustedAuthor, resolveGoVerifyRetries, resolveStallConvergenceBudget, resolveStaleBaseDriftCap, resolveUntrustedAuthorSandbox, scoutCapturedDone, scoutReportFrom } from "./recovery.js";
import type { ReseedSpend, ReseedTrigger } from "./reseed-budget.js";
import {
  recordReseedDraw,
  reseedDraw,
  reseedTriggerCause,
  resolveReseedBudget,
  totalReseedSpend,
  withGateSubCap,
} from "./reseed-budget.js";
import {
  EMPTY_CORRECTION_LEDGER,
  attributeGateFailure,
  chargeCorrection,
  correctionBudgetExhausted,
  describeCorrectionLedger,
  type BaseMovement,
  type CorrectionLedger,
  type GateFailureAttribution,
  type StaleBaseDriftNote,
} from "../stale-base-drift.js";
import { abortAfterClaim, claimLost, emitBackpressureReview, emitDone, handoffForManualLanding, handoffForReview, hookContext, isRunnerRecoverableOutcome, landLockBackoff, mergeFailed, ciBlocked, prLandingBlocked, trunkDivergedBlocked, onErrorContext, parseHookEnv, postAttemptContext, recordOutcomeBestEffort, releaseOwnedClaim, runCascadeRebase, runCloseCascade, runnerRecoverable, terminalFailure, writeValidationSidecar, type StageCommon } from "./terminal.js";

function setupFailureExcerpt(log: string | null | undefined): string | undefined {
  const lines = (log ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[heartbeat]"));
  let setupFailure = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (
      /command failed in sandbox/i.test(line) ||
      /(?:sandbox|bootstrap|setup).*(?:error|fail)/i.test(line)
    ) {
      setupFailure = index;
      break;
    }
  }
  if (setupFailure < 0) return undefined;
  return lines.slice(setupFailure, setupFailure + 4).join("\n");
}


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
      { isStale: deps.claimStale, deathFor: deps.recoveredWorkerDeathCause, nowS: deps.nowEpoch() },
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
    // Resolve the promoter from the LANE label the issue was claimed under (#2602):
    // `lane:go` / `lane:scout` issues never carry `ready-for-agent`, so the lane
    // label's own applier is the promoter analog. For /afk, `laneLabel` is
    // `ready-for-agent` — unchanged behaviour.
    provenance = await deps.gh.issueTrust(issue, laneLabel);
  }
  const trustLookup = deps.gh.actorTrustSignals
    ? (login: string) => deps.gh.actorTrustSignals!(login)
    : async () => ({});
  // External-origin gate (issue #2603). An `origin:external` issue is HELD until
  // a maintainer `/approve-external` comment (author resolved through the same
  // write-access trust resolver) is present — independent of the trust posture.
  let externalOrigin: ExternalOriginState | undefined;
  if (labels.includes(LABEL_ORIGIN_EXTERNAL)) {
    const approvalActors = deps.gh.externalApprovalActors
      ? await deps.gh.externalApprovalActors(issue)
      : [];
    let approver: string | undefined;
    for (const actor of approvalActors) {
      const v = await resolveActorTrust(trustPolicy, actor, trustLookup);
      if (v.executable) {
        approver = actor;
        break;
      }
    }
    externalOrigin = { external: true, approved: !!approver, approver };
  }
  const canFailClosed = !!(trustPolicy.failClosed && deps.gh.actorTrustSignals);
  if ((trustPolicy.enabled || canFailClosed || externalOrigin) && (provenance || externalOrigin)) {
    const verdict = await evaluateClaimTrust(trustPolicy, provenance ?? {}, trustLookup, externalOrigin);
    if (!verdict.executable) {
      // An unapproved external-origin HOLD parks the issue as `ready-for-human`
      // (never claimable), rather than merely un-claiming it.
      if (verdict.holdForApproval) {
        await deps.gh.ensureLabel(LABEL_HUMAN);
        await editIssueLifecycleLabels(deps, issue, labels, [LABEL_READY], [LABEL_HUMAN], "preflight-blocked");
        await deps.gh.comment(
          issue,
          `🤖 /afk external-origin gate: ${verdict.reason}. ` +
            `A maintainer with write access must comment \`/approve-external\` to release it.`,
        );
        deps.appendIterLog(`🤖 /afk external-origin gate held #${issue} for approval: ${verdict.reason}`);
        await releaseClaim();
        return {
          outcome: "blocked",
          issue,
          hooksFired,
          preserved: false,
          swept: false,
        };
      }
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
  const prevFailureContext = await deps.lookups.prevFailureContext(issue);
  // Attempt adoption (#2416): inspect open PRs before the worker branch is
  // materialised. A matching PR is authoritative existing work and takes the
  // no-agent validate-and-land path. The issue comment makes every concurrent
  // historical attempt visible to a human instead of silently selecting one.
  const openPullRequests = await deps.lookups.discoverOpenPullRequests?.(issue) ?? [];
  const matchingPullRequests = openPullRequests
    .filter((pr) => pullRequestMatchesAttempt(pr, issue))
    .sort((a, b) => a.number - b.number);
  const adoptedPullRequest = selectAttemptPullRequest(matchingPullRequests, issue);
  if (matchingPullRequests.length > 0) {
    await deps.gh.comment(
      issue,
      `🤖 /afk Attempt PRs for #${issue}: ${matchingPullRequests.map((pr) => `#${pr.number}`).join(", ")}. ` +
        (adoptedPullRequest
          ? `Adopting #${adoptedPullRequest.number} from \`${adoptedPullRequest.headRefName}\` through the no-agent gate.`
          : "No adoptable head was found."),
    );
  }

  // Branch-resume logic (issue #2397): discover a prior pushed branch so re-claim
  // can continue instead of rebuilding from scratch. Explicit restart overrides a
  // branch-only resume, but never silently supersedes an existing open PR.
  const allBranches = await deps.lookups.discoverBranches?.() ?? [];
  const humanGuidanceForResume = buildHumanGuidance(comments);
  const explicitRestart = isExplicitRestartRequested(humanGuidanceForResume);
  const resumableBranch = adoptedPullRequest
    ? { branch: adoptedPullRequest.headRefName }
    : explicitRestart
      ? null
      : discoverResumableBranch(allBranches, issue);
  const failureReason = extractFailureReason(prevFailureContext);
  const resumeIsGateGreen = adoptedPullRequest !== null ||
    (resumableBranch !== null && isGateGreenBranch(failureReason));
  if (adoptedPullRequest) {
    deps.appendIterLog(
      `🤖 /afk #${issue}: adopting open PR #${adoptedPullRequest.number} from \`${adoptedPullRequest.headRefName}\`; agent skipped.`,
    );
  }
  const resumeInstruction =
    resumableBranch !== null
      ? buildResumeInstruction(resumableBranch.branch, resumeIsGateGreen, base)
      : undefined;
  const outputShaping = assignOutputShaping(issue, deps.outputShaping ?? { terseSteering: false });
  const enrichment = deps.lookups.handoffEnrichment
    ? await deps.lookups
        .handoffEnrichment({
          issue,
          title: input.title,
          body: input.body,
          labels,
          specRef: input.specRef,
        })
        .catch(() => undefined)
    : undefined;
  const handoff = buildHandoff({
    issue,
    title: input.title,
    body: input.body,
    runner: input.runner,
    started: startedAt,
    attempt: input.attempt,
    url,
    comments,
    prevFailureContext,
    specRef: input.specRef,
    mergeGateCommands: deps.backpressureCommands ?? [],
    outputShaping,
    resumeFromBranch: resumeInstruction,
    enrichment,
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
  const taskClass = deps.classifyIssue
    ? (await deps
      .classifyIssue(
        buildIssueClassificationMetadata({
          issue,
          title: input.title,
          body: input.body,
          labels,
        }),
      )
      .catch(() => undefined)) ?? "simple"
    : "think";
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
      // The worker branch was never pushed — suppress the live-branch link.
      noBranchLink: true,
    };
    const message = baseResolution.message ?? "could not refresh fleet trunk mirror; remote unreachable or ref missing.";
    // Classify as runner-transient (infrastructure / network failure), not
    // base-stale.  base-stale implies the base ref exists but the local copy is
    // behind; a mirror-refresh failure at boot (origin/when, network down, etc.)
    // is an infra transient that clears on the next attempt.  base-stale is
    // non-recoverable (escalates to human); runner-transient auto-retries up to
    // the bounded cap, which is the right policy here.
    return await terminalFailure(staleCommon, "runner-transient", "runner-transient", {
      notes: message,
      log: message,
    });
  }
  const baseRef = baseResolution.baseRef;
  // Skip branch preparation when resuming from a prior pushed branch: the branch
  // already exists on origin and must not be deleted or reset (issue #2397).
  if (!resumableBranch) {
    await deps.git.prepareFreshWorkerBranch?.({
      branch,
      baseRef,
      force: isMergeConflictRetry(prevFailureContext),
    });
  }
  let activeRunner: Runner = toAgentRunner(input.runner);
  // The ROUND ordinal, not the attempt ordinal ADR 0103 retired: every bump
  // below happens inside ONE Attempt — same Worker, same Worktree, same branch.
  // It is still carried on the legacy `attempt`/`attempt_n` fields because those
  // are the hook and record contracts; the name here says what it counts.
  let roundOrdinal = input.attempt;
  let activeTaskClass: AfkModelTier = taskClass;
  const issueType = deriveIssueType(labels);
  let workerBranch = branch;
  let current: ProcessIssueInput = { ...input, runner: activeRunner, attempt: roundOrdinal };
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
  let currentHandoff = handoff;
  let correctionLedger: CorrectionLedger = EMPTY_CORRECTION_LEDGER;
  let adversarialReviewCorrectionsUsed = 0;
  let pendingAdversarialCorrection:
    | { diff: string; findings: AdversarialReviewFindings; retry: number; cap: number }
    | undefined;
  let pendingAdversarialPark:
    | { findings: AdversarialReviewFindings; cap: number }
    | undefined;
  const scoutTextChunks: string[] = [];
  const agentEventSink: typeof deps.recordAgentEvent =
    input.runMode === "scout"
      ? (event: AgentStreamEvent) => {
          if (event.type === "text") scoutTextChunks.push(event.message);
          deps.recordAgentEvent?.(event);
        }
      : deps.recordAgentEvent;
  const goVerifyRetryCap = resolveGoVerifyRetries(deps);
  const staleBaseDriftCap = resolveStaleBaseDriftCap(deps);
  // Issue #2711 — the gate runs on the branch MERGED WITH the live base, so a
  // base that moved under the attempt can redden a branch that is itself green.
  // Ask git what the base did before charging the failure to anyone. A missing
  // probe, an unresolved base sha, or a throwing lookup all yield `undefined`,
  // which attributes the failure to the branch exactly as before.
  const observeBaseMovement = async (): Promise<BaseMovement | undefined> => {
    const probe = deps.lookups.baseMovement;
    if (!probe || !baseResolution.sha) return undefined;
    try {
      const seen = await probe(baseRef, baseResolution.sha);
      return { startSha: baseResolution.sha, gateSha: seen.head, subjects: seen.subjects };
    } catch {
      return undefined;
    }
  };
  /** Attribute one post-DONE gate failure and, when it is stale-base drift,
   * build the handoff note that tells the agent to merge the base. */
  const attributeGateFailureNow = async (driftEligible: boolean): Promise<{
    attribution: GateFailureAttribution;
    drift?: StaleBaseDriftNote;
  }> => {
    const movement = driftEligible ? await observeBaseMovement() : undefined;
    const attribution = attributeGateFailure({
      movement,
      refundsUsed: correctionLedger.refunded,
      maxRefunds: staleBaseDriftCap,
    });
    if (attribution.cause !== "stale-base-drift" || !movement) return { attribution };
    return { attribution, drift: { base, movement, attribution } };
  };
  const stallConvergenceCap = resolveStallConvergenceBudget(deps);
  const isGoLane = input.laneLabel === LABEL_GO_LANE;
  const reseedLane: "/go" | "/afk" = isGoLane ? "/go" : "/afk";
  // ONE budget for every Re-seed this Attempt may spend (ADR 0129): the lane
  // supplies the ceiling and the review's reservation, the operator's configured
  // counter supplies only the gate's share. A tier escalation therefore draws
  // its own round instead of muting gate correction outright.
  const reseedBudget = withGateSubCap(
    resolveReseedBudget({ laneLabel: input.laneLabel, runMode: input.runMode }),
    isGoLane ? goVerifyRetryCap : stallConvergenceCap,
  );
  let reseedSpend: ReseedSpend = {};
  const gateSubCap = reseedBudget.subCaps.gate;
  /** Whether a Re-seed round was granted. `hook-aborted` is not exhaustion — the
   * budget was drawn and the round IS running; the `pre_attempt` hook refused
   * it, which each caller handles the way it always has. */
  type ReseedOutcome = "granted" | "refused" | "hook-aborted";
  interface ReseedRequest {
    trigger: ReseedTrigger;
    /** The gate stage that blocked, for the two gate-shaped triggers. */
    gate?: "feedback" | "backpressure";
    validation: string;
    /** False for the empty-diff rejection: a branch that carries no diff at all
     * is unambiguously the branch's problem, and no amount of base movement can
     * explain it away. */
    driftEligible?: boolean;
    /** Tier escalation only — which tier failed and which one now runs. */
    tiers?: { from: string; to: string };
  }
  /** The single Re-seed request path. Every caller that re-instructs the
   * implementer IN PLACE — same Worker, same Worktree, same branch — comes
   * through here: it checks the ceiling and the cause's sub-cap or reservation,
   * bumps the round ordinal, appends to the handoff, fires `pre_attempt`, and
   * emits one worker event naming the trigger.
   *
   * A drift-attributed gate round is FREE: it is recorded on the ledger but
   * never drawn from the budget, so an already-spent counter can no longer park
   * a branch whose gate only failed because the base moved beneath it (#2711). */
  const requestReseed = async (req: ReseedRequest): Promise<ReseedOutcome> => {
    const cause = reseedTriggerCause(req.trigger);
    const { attribution, drift } =
      cause === "gate"
        ? await attributeGateFailureNow(req.driftEligible ?? false)
        : { attribution: undefined, drift: undefined };
    const free = drift !== undefined;
    const draw = reseedDraw(reseedBudget, cause, reseedSpend);
    if (!free && !draw.allowed) return "refused";
    if (attribution) correctionLedger = chargeCorrection(correctionLedger, attribution.cause);
    if (!free) reseedSpend = recordReseedDraw(reseedSpend, cause);
    roundOrdinal += 1;
    const gateSpend = reseedSpend.gate ?? 0;
    if (req.trigger === "tier-escalation") {
      currentHandoff = appendTierEscalationHandoff(handoff, {
        from: req.tiers?.from ?? "",
        to: req.tiers?.to ?? "",
        validation: req.validation,
        retry: reseedSpend.tier ?? 0,
        cap: reseedBudget.subCaps.tier,
      });
      deps.appendIterLog(
        `🤖 ${reseedLane}: ${req.tiers?.from ?? ""}-tier feedback failed for #${issue}; ` +
          `re-seeding on the ${req.tiers?.to ?? ""} tier before terminal validation routing.`,
      );
    } else {
      const gate = req.gate ?? "feedback";
      const append = isGoLane ? appendGoVerifyRetryHandoff : appendAfkGateCorrectionHandoff;
      currentHandoff = append(handoff, { gate, validation: req.validation, retry: gateSpend, cap: gateSubCap, drift });
      deps.appendIterLog(
        drift
          ? `🤖 ${reseedLane}: ${gate} machine gate failed after DONE, but ${attribution?.reason}; ` +
            `granting a free stale-base correction (${correctionLedger.refunded}/${staleBaseDriftCap}), ` +
            `budget untouched at ${gateSpend}/${gateSubCap}.`
          : `🤖 ${reseedLane}: ${gate} machine gate failed after DONE; correction retry ${gateSpend}/${gateSubCap}.`,
      );
    }
    deps.recordWorkerEvent?.("worker.reseeded", {
      trigger: req.trigger,
      cause,
      lane: reseedBudget.lane,
      free,
      round: totalReseedSpend(reseedSpend),
      ceiling: reseedBudget.ceiling,
      cause_spent: reseedSpend[cause] ?? 0,
      cause_cap: reseedBudget.subCaps[cause],
    });
    const hookOk = await fireHook(
      "pre_attempt",
      hookContext({ issue, title: input.title, workspace: branch, runner: activeRunner, attempt_n: roundOrdinal }),
    );
    return hookOk ? "granted" : "hook-aborted";
  };
  /** A gate-shaped Re-seed, for the callers that only need "may I continue?".
   * A refused hook parks exactly as an exhausted budget does — the gate path has
   * always folded the two together. */
  const reseedAfterGate = async (
    trigger: "gate-stage" | "no-diff-done",
    gate: "feedback" | "backpressure",
    validation: string,
  ): Promise<boolean> =>
    (await requestReseed({ trigger, gate, validation, driftEligible: trigger === "gate-stage" })) === "granted";
  /** The park-note suffix naming the exhausted correction budget. It reports the
   * CHARGED cycles against the lane's cap and, separately, the stale-base cycles
   * that were absorbed for free — so a reader can tell a branch that really kept
   * failing from a run that spent itself absorbing base drift (#2711). */
  const correctionBudgetNote = (): string => {
    if (correctionLedger.cycles.length === 0) return "";
    if (!correctionBudgetExhausted(correctionLedger, gateSubCap)) return "";
    return ` Post-DONE gate-correction budget exhausted (${describeCorrectionLedger(correctionLedger, gateSubCap)}).`;
  };
  // Gate-green fast path (issue #2397): when a prior branch already cleared the
  // feedback gate, skip the agent entirely on re-claim and re-validate directly.
  let gateGreenSkip = resumeIsGateGreen;
  while (true) {
    const initialTier = resolveSpawnTier(deps, activeRunner, activeTaskClass);
    const routedEffort = initialTier.effort ?? "";
    deps.appendIterLog(
      `🤖 /afk route #${issue}: tier=${activeTaskClass} runner=${activeRunner} model=${initialTier.model} effort=${routedEffort || "default"}.`,
    );
    deps.markState?.({
      "current.runner": activeRunner,
      "current.model_tier": activeTaskClass,
      "current.model": initialTier.model,
      "current.effort": routedEffort,
    });
    deps.recordWorkerEvent?.("worker.routed", {
      runner: activeRunner,
      model_tier: activeTaskClass,
      model: initialTier.model,
      effort: routedEffort,
    });
    let run: RunAgentResult;
    if (gateGreenSkip) {
      // Consume the flag — subsequent loop iterations (e.g. go-verify retries)
      // run the agent normally.
      gateGreenSkip = false;
      const fastBranch = resumableBranch!.branch;
      deps.appendIterLog(
        `🤖 /afk #${issue}: gate-green fast path — re-validating \`${fastBranch}\`, agent skipped.`,
      );
      run = { outcome: "done", branch: fastBranch, commits: [], stdout: "" };
    } else {
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
              attempt_n: roundOrdinal,
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
        trunkSync: true,
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
        // In-attempt trunk sync (#2481): between iterations the attempt worktree
        // is quiet, so merging the moved trunk in costs one small conflict pass
        // instead of the enormous one the landing rebase would otherwise pay.
        syncTrunk: async () => {
          const sync = await syncTrunkIntoBranch(deps.mergeExec, {
            repo: input.attemptDir,
            remote: input.remote,
            base,
          });
          return renderTrunkSyncNote(sync, base);
        },
        now: () => deps.nowEpoch() * 1000,
        tokensSpent: () => {
          const vitals = deps.heartbeatVitals?.();
          return vitals ? (vitals.input_tokens ?? 0) + (vitals.output_tokens ?? 0) : 0;
        },
        log: (message) => deps.appendIterLog(message),
      });
      run = notesOutcome.run;
      if (isRunnerRecoverableOutcome(run.outcome)) {
        if (!deps.fallbackRunner) {
          return await runnerRecoverable(deps, input, branch, base, hooksFired, activeRunner, run.outcome, false);
        }
        await fireHook("post_attempt", postAttemptContext({ ...input, attempt: roundOrdinal }, branch, "fail", run.outcome));
        const other: Runner = activeRunner === "claude" ? "codex" : "claude";
        activeRunner = other;
        roundOrdinal += 1;
        if (
          !(await fireHook(
            "pre_attempt",
            hookContext({ issue, title: input.title, workspace: branch, runner: activeRunner, attempt_n: roundOrdinal }),
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
          await fireHook("post_attempt", postAttemptContext({ ...input, attempt: roundOrdinal }, branch, "fail", run.outcome));
          return await runnerRecoverable(deps, input, branch, base, hooksFired, activeRunner, run.outcome, true);
        }
      }
    }
    workerBranch = run.branch || branch;
    current = { ...input, runner: activeRunner, attempt: roundOrdinal };
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
    // ADR 0103: uncommitted worktree state is DISPOSABLE. The engine never
    // salvage-commits dirty paths on exit and never assembles an exit receipt —
    // work is saved by the continuous-push hook as the agent commits, and the
    // terminal Envelope plus those pushed commits are the only forensics.
    let salvaged = false;
    if (run.outcome === "no-sentinel") {
      const branchHasWork =
        input.runMode !== "scout" &&
        (await deps.lookups.changedFiles(workerBranch, baseRef)).length > 0 &&
        (!deps.lookups.branchPresent || (await deps.lookups.branchPresent(workerBranch)));
      if (!branchHasWork) {
        await fireHook("on_attempt_error", onErrorContext(current, workerBranch, "no-sentinel", current.attempt));
        const attemptLog = await deps.fs
          .readText?.(`${input.attemptDir}/afk.log`)
          .catch(() => null);
        const diagnostic =
          setupFailureExcerpt(attemptLog) ??
          (run.stdout ? run.stdout.split("\n").slice(-1)[0] || undefined : undefined) ??
          "(no captured stdout)";
        return await terminalFailure(common, "no-sentinel", "no-sentinel", {
          notes: "_(no Notes appended; inner agent exited without a sentinel and the branch carries no work)_",
          log: diagnostic,
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
      if (run.outcome === "host-config") {
        return await terminalFailure(common, "host-config", "host-config", {
          notes: run.stdout,
          log: run.stdout,
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
      markProcessSafetyStep("post-agent:branch-present-failed");
      deps.appendIterLog(
        `🤖 /afk: worker branch \`${workerBranch}\` absent on host — sandcastle commits did not reach the host; escalating.`,
      );
      return await mergeFailed(common, "worker branch absent — sandcastle commits did not reach the host");
    }
    const postWorkerFormatCommands = deps.postWorkerFormatCommands ?? [];
    if (deps.postWorkerFormat && postWorkerFormatCommands.length > 0) {
      markProcessSafetyStep("post-agent:post-attempt-format");
      const pfmt = await runPostWorkerFormat(deps.postWorkerFormat, {
        worktree: workerBranch,
        commands: postWorkerFormatCommands,
        now: deps.nowEpoch,
      });
      for (const line of pfmt.log) deps.appendIterLog(`🤖 /afk: ${line}`);
      if (!pfmt.ok) {
        return await abortAfterClaim(deps, input, branch, base, hooksFired, "post_attempt_format");
      }
    }
    deps.markPhase?.("validating");
    markProcessSafetyStep("post-agent:feedback-start");

    const changedFiles = await deps.lookups.changedFiles(workerBranch, baseRef);
    if (changedFiles.length === 0) {
      const validationText =
        "DONE rejected: attempt branch has no diff against the merge-base; no work changed, so the completion claim was not accepted.";
      deps.appendIterLog(`🤖 /afk: ${validationText}`);
      if (await reseedAfterGate("no-diff-done", "feedback", validationText)) continue;
      const convergenceNote = correctionBudgetNote();
      return await terminalFailure(common, "feedback-failed", "feedback", {
        notes: `Inner agent emitted DONE, but the attempt branch has no diff against the merge-base. The worker branch was not merged.${convergenceNote}`,
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
    markProcessSafetyStep("post-agent:feedback-done");
    gateStages.push({ stage: "feedback", ok: feedback.ok });
    if (!feedback.ok) {
      await fireHook(
        "on_baseline_probe",
        hookContext({
          issue,
          title: input.title,
          workspace: branch,
          ok: feedback.ok,
          inconclusive: feedback.baselineInconclusive,
        }),
      );
    }
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
      const scopeHeader = feedback.validationScope
        ? `${formatValidationScope(feedback.validationScope)}\n`
        : "";
      const validationText = `${scopeHeader}${feedback.sidecar.join("\n")}`;
      // A repeated failure buys a HIGHER tier rather than another round at the
      // tier that just failed (ADR 0129). It draws the `tier` sub-cap, so gate
      // correction keeps its own share — the mute this replaced cost a Ticket
      // its whole gate budget for one tier bump.
      if (!isInfra && activeTaskClass === "simple") {
        const escalation = await requestReseed({
          trigger: "tier-escalation",
          validation: validationText,
          tiers: { from: "simple", to: "complex" },
        });
        if (escalation === "hook-aborted") {
          return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
        }
        if (escalation === "granted") {
          activeTaskClass = "complex";
          continue;
        }
      }
      const outcome: ProcessOutcome = isInfra ? "feedback-failed-infra" : "feedback-failed";
      let notes: string;
      if (isInfra) {
        notes = `Feedback validation failed for an INFRA reason (worktree/submodule/pnpm install/OOM) on branch \`${workerBranch}\` — the recovery policy will retry up to its cap.`;
      } else if (salvaged) {
        notes = "Salvaged a no-sentinel branch (it carried work), but feedback validation failed — the branch was not merged.";
      } else {
        notes = "Feedback validation failed after the inner agent emitted DONE. The worker branch was not merged.";
      }
      if (!isInfra && (await reseedAfterGate("gate-stage", "feedback", validationText))) {
        continue;
      }
      if (!isInfra) notes += correctionBudgetNote();
      return await terminalFailure(common, outcome, "feedback", {
        notes,
        validation: validationText,
      }, { validationSummary: feedback.sidecar.join("\n") });
    }
    const backpressureCommands = deps.backpressureCommands ?? [];
    let backpressureSidecar: string[] = [];
    if (deps.backpressure && backpressureCommands.length > 0) {
      markProcessSafetyStep("post-agent:backpressure-start");
      const backpressure = await runBackpressure(deps.backpressure, {
        worktree: workerBranch,
        commands: backpressureCommands,
        now: deps.nowEpoch,
      });
      backpressureSidecar = backpressure.sidecar;
      markProcessSafetyStep("post-agent:backpressure-done");
      common.backpressureChecks = backpressure.checks;
      gateStages.push({ stage: "backpressure", ok: backpressure.ok });
      if (gateVerdict(gateStages).failedStage === "backpressure") {
        await writeValidationSidecar(deps, input.attemptDir, [...feedback.sidecar, ...backpressure.sidecar]);
        let bpNotes = "Backpressure validation failed after the feedback gate passed. The worker branch was not merged.";
        const validationText = backpressure.sidecar.join("\n");
        if (await reseedAfterGate("gate-stage", "backpressure", validationText)) {
          continue;
        }
        bpNotes += correctionBudgetNote();
        return await terminalFailure(common, "feedback-failed", "feedback", {
          notes: bpNotes,
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

  markProcessSafetyStep("post-agent:landing-start");
  const locked = await deps.lookups.isLocked();
  const openPr = deps.worktreeLaunchesPr !== false;
  if (labels.includes(LABEL_LANDING_MANUAL)) {
    return await handoffForManualLanding(common, base, validationSidecar);
  }
  if (openPr && deps.reviewGate && shouldRequestReview(activeTaskClass, deps.reviewGate)) {
    return await handoffForReview(common, activeTaskClass, validationSidecar);
  }
  const markLandingPhase = (phase: LandingPhase, detail: Record<string, unknown> = {}): void => {
    const startedAt = deps.nowIso();
    deps.markState?.({
      "current.activity": "landing",
      "current.phase": phase,
      "current.started_at": startedAt,
    });
    deps.markPhase?.(phase);
    deps.appendIterLog(
      `🤖 /afk landing heartbeat: phase=${phase}` +
        (typeof detail.step === "string" ? ` step=${detail.step}` : "") +
        (typeof detail.status === "string" ? ` status=${detail.status}` : ""),
    );
    deps.recordWorkerEvent?.("worker.landing_heartbeat", {
      phase,
      ...detail,
    });
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
      // An incoherent (runner, model, effort) pin is corrected, never spawned:
      // log every substitution so the operator sees which knob was overridden.
      for (const notice of reviewer.notices ?? []) deps.appendIterLog(notice);
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
      // An advisory pass has exactly three legal verdicts — pass, correct, park.
      // Infrastructure failure of the reviewer itself is NONE of them: the
      // attempt is already machine-validated here, so a crashed/non-zero
      // reviewer CLI degrades to "pass with a logged warning" and the landing
      // proceeds. Killing the run instead stranded three pushed branches and
      // took every claude fleet worker down at landing (#2352).
      const reason = error instanceof Error ? error.message : String(error);
      deps.appendIterLog(`[adversarial-review] advisory pass failed, degraded to pass: ${reason}`);
      deps.recordWorkerEvent?.("worker.review_degraded", {
        issue: input.issue,
        pr,
        decision: "pass",
        reason,
      });
    }
  };
  markLandingPhase("gate");
  let landing = await doLanding(
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
      landingWait: deps.landingWait,
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
      requirePostMergeValidation: true,
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
  const finishSuccessfulLanding = async (
    completed: Extract<typeof landing, { ok: true }>,
    releaseAtEnd: boolean,
  ): Promise<ProcessIssueResult> => {
    const mergeSha = completed.mergeSha ?? (await deps.git.headShortSha());
    const durationS = deps.nowEpoch() - startedEpoch;
    if (completed.postMergeValidation) {
      validationSidecar = [...validationSidecar, postMergeValidationSidecarLine(completed.postMergeValidation)];
      deps.recordWorkerEvent?.("worker.post_merge_validation", {
        path: completed.postMergeValidation.path,
        reason: completed.postMergeValidation.reason,
        pr_number: completed.postMergeValidation.prNumber,
        check_count: completed.postMergeValidation.path === "satisfied-by-ci"
          ? completed.postMergeValidation.checkCount
          : undefined,
      });
    }
    markLandingPhase("cascade");
    deps.recordWorkerEvent?.("worker.landed", { merge_sha: mergeSha, base });
    await writeValidationSidecar(deps, input.attemptDir, validationSidecar);
    const posted = await emitDone(common, mergeSha, durationS, validationSidecar, lastValidationScope, noSourceDiffWarning);
    await recordOutcomeBestEffort(common, "done", { durationS });
    markLandingPhase("close", { step: "close-issue", status: "start" });
    await deps.gh.close(issue);
    markLandingPhase("close", { step: "labels", status: "start" });
    await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
    markLandingPhase("close", { step: "delete-remote", status: "start" });
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
    if (releaseAtEnd) await deps.claimLock.release(issue);
    markTerminalState(deps, "done");
    await runCloseCascade(deps, issue);
    if (completed.mergeSha) {
      await runCascadeRebase(deps, input, issue, completed.mergeSha, labels);
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
      preserved: true,
      swept: true,
    };
  };
  if (landing.ok && landing.deferred) {
    const deferred = landing.deferred;
    if (!deps.landingTailObserver) {
      landing = await deferred.run();
    } else {
      const completion = deps.landingTailObserver({ ...deferred, issue });
      void completion
        .then(async (completed) => {
          if (completed.ok) {
            await finishSuccessfulLanding(completed, false);
            return;
          }
          if (completed.reason === "ci-failed" || completed.reason === "ci-pending") {
            await ciBlocked(common, completed.reason, completed.prNumber);
            return;
          }
          if (completed.reason === "pr-conflict") {
            await prLandingBlocked(
              common,
              "merge-conflict",
              completed.prNumber,
              completed.message ?? "the observer found merge conflicts while finishing the open PR",
            );
            return;
          }
          await prLandingBlocked(
            common,
            "ci-failed",
            completed.prNumber,
            completed.reason === "pr-merge-failed"
              ? "the observer's merge was rejected by GitHub"
              : `the observer could not finish the landing tail (${completed.reason})`,
          );
        })
        .catch((error) => {
          deps.appendIterLog(
            `🤖 /afk landing-tail observer for #${issue} stopped before close: ${error instanceof Error ? error.message : String(error)}`,
          );
          deps.recordWorkerEvent?.("worker.blocked", {
            outcome: "ci-pending",
            reason: "landing-tail-observer-stopped",
            issue,
          });
        });
      await releaseClaim();
      deps.recordWorkerEvent?.("worker.landing_handed_off", {
        issue,
        pr_number: deferred.prNumber,
        wait: deps.landingWait ?? "merge",
      });
      return {
        outcome: "done",
        issue,
        branch: workerBranch,
        base,
        locked,
        hooksFired,
        preserved: true,
        swept: false,
      };
    }
  }
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
      roundOrdinal += 1;
      currentHandoff = appendAdversarialReviewCorrectionHandoff(handoff, correction);
      deps.appendIterLog(
        `🤖 /afk: adversarial review found blocking issue(s); correction retry ${correction.retry}/${correction.cap}.`,
      );
      if (
        !(await fireHook(
          "pre_attempt",
          hookContext({ issue, title: input.title, workspace: branch, runner: activeRunner, attempt_n: roundOrdinal }),
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
    if (landing.reason === "ci-failed" || landing.reason === "ci-pending") {
      return await ciBlocked(common, landing.reason, landing.prNumber);
    }
    if (landing.reason === "land-lock-timeout") {
      return await landLockBackoff(common);
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
        // #2481: the stale-branch guard parks here with its own reason, so the
        // note names the real refusal instead of a conflict that never happened.
        landing.message ?? `the open PR has merge conflicts and could not be landed`,
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
    return await mergeFailed(
      common,
      [landing.reason, landing.message].filter(Boolean).join(" — "),
      landing.locked,
    );
  }
  return await finishSuccessfulLanding(landing, true);
  }
}

function postMergeValidationSidecarLine(validation: LandingPostMergeValidation): string {
  return formatValidationLine(buildValidationRecord({
    name: `post-merge:${validation.path}`,
    status: "passed",
    summary: validation.reason,
  }));
}
