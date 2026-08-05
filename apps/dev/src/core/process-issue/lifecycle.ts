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
  decideBranchAdoption,
  discoverResumableBranch,
  extractFailureReason,
  formatAdoptionNotice,
  isExplicitRestartRequested,
  isGateGreenBranch,
  pullRequestMatchesAttempt,
  selectAttemptPullRequest,
} from "../branch-resume.js";
import { assignOutputShaping, type OutputShapingConfig } from "../output-shaping.js";
import { evaluateGoalPredicate } from "../goal-predicate.js";
import { laneRunModeRefusal } from "../lane-run-mode.js";
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
  isInfraValidationFailure,
  type ClassifiableCheck,
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
  detectBranchReversion,
  formatBranchReversionRecord,
  type BranchReversionFinding,
  type BranchReversionGeometry,
} from "../branch-reversion.js";
import {
  aggregateAdversarialReviewFindings,
  decideAdversarialReview,
  renderAdversarialReviewBlockerSummary,
  renderAdversarialReviewComment,
  resolveAdversarialReviewer,
  type AdversarialReviewDecision,
  type AdversarialReviewFinding,
  type AdversarialReviewFindings,
} from "../adversarial-review.js";
import type { ProcessIssueDeps, ProcessIssueInput, ProcessIssueResult, WorkerBaseResolution, ProcessOutcome } from "./types.js";
import { baseResolutionStatePatch, formatBaseResolution, isMergeConflictRetry, markTerminalState, recoveryOrdinalFor, remoteTrackingBaseRef, resolveSpawnTier } from "./types.js";
import { MECHANICAL_BLOCKER_KINDS, blockedLabelsIn, editIssueLifecycleLabels, formatNoSourceChangeWarning, hasLikelySourceChanges, parseFeedbackClass, refuseNoSandboxForUntrustedAuthor, resolveGoVerifyRetries, resolveReseedGateBudget, resolveStaleBaseDriftCap, resolveUntrustedAuthorSandbox, scoutCapturedDone, scoutReportFrom } from "./recovery.js";
import type { ReseedSpend, ReseedTrigger } from "./reseed-budget.js";
import {
  recordReseedDraw,
  reseedDraw,
  reseedTriggerCause,
  resolveReseedBudget,
  totalReseedSpend,
  withGateSubCap,
} from "./reseed-budget.js";
import type { ReseedTrail, ReseedTrailRound } from "./reseed-trail.js";
import { createReseedTrail } from "./reseed-trail.js";
import type { ReseedOutstanding, ReseedSectionTag } from "./reseed-handoff.js";
import {
  EMPTY_RESEED_OUTSTANDING,
  composeReseedHandoff,
  gateReseedDirectives,
  noteReseedSignature,
  reviewReseedDirectives,
  tierEscalationDirectives,
  withGateOutstanding,
  withReviewOutstanding,
  withoutGateOutstanding,
  withoutReviewOutstanding,
} from "./reseed-handoff.js";
import { decideTierEscalation } from "./tier-escalation.js";
import { failureSignature, parseValidationFailureSignature } from "../failure-signature.js";
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

/** Recorded when the forge refused the merge and the PR state did not explain it
 * (#2807). It says the cause is unknown rather than inventing a probable one. */
const MERGE_REJECTION_UNEXPLAINED =
  "the open PR merge was rejected by GitHub and the PR state did not explain the refusal";
/** The `next:` step for a rejected merge. It points at the recorded reason
 * instead of asserting a failing required check that may well be green (#2807). */
const MERGE_REJECTION_NEXT =
  "Read the recorded rejection reason above, clear it on the open PR, then merge it (no full agent re-run needed).";

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
  /** Withdraw from the issue, naming the cause. Every exit routes through here
   * so no withdrawal is anonymous: the sweep deletes this worker's workspace on
   * a claim-lost, so the account has to reach the durable lane (#3156). */
  const withdraw = (reason: string, decision?: ClaimDecision): Promise<ProcessIssueResult> =>
    claimLost(issue, hooksFired, deps, decision, reason, {
      workerId: input.workerId,
      runner: input.runner,
    });
  if (!(await deps.claimLock.acquire(issue))) {
    return withdraw("the host-local claim lock is already held by another worker on this machine");
  }
  const laneLabel = input.laneLabel ?? LABEL_READY;
  const labels = await deps.gh.viewLabels(issue);
  if (!labels.includes(laneLabel)) {
    await deps.claimLock.release(issue);
    return withdraw(`the issue no longer carries its lane label \`${laneLabel}\``);
  }
  // The lane label implies the run mode, enforced HERE — at the claim, the one
  // path every entrance shares (#3026). A `lane:scout` issue picked up without
  // `run_mode=scout` would run the full mutating pipeline against a read-only
  // investigation, so the worker refuses before it owns anything.
  const laneModeRefusal = laneRunModeRefusal(labels, input.runMode);
  if (laneModeRefusal) {
    await deps.claimLock.release(issue);
    return withdraw(laneModeRefusal);
  }
  if (deps.claimGh) {
    // **A Worker that cannot WRITE its claim declines the issue** (#3095, ADR
    // 0132 Amendment 2). Claiming is three layers — the local `mkdir` lock, this
    // GitHub marker, the stale-lock boot sweep — and a marker that never lands
    // leaves only the host-local lock: safe on one machine, and two Workers on
    // one branch the moment a second host drains the same backlog. Proceeding on
    // the lock alone is the one outcome that must not happen, so the failure is
    // a stated decline here rather than an exception that also strands the lock
    // it acquired a moment ago.
    let decision: ClaimDecision;
    try {
      decision = await acquireClaim(
        deps.claimGh,
        { worker: input.claimant ?? input.workerId, runner: input.runner },
        issue,
        { isStale: deps.claimStale, deathFor: deps.recoveredWorkerDeathCause, nowS: deps.nowEpoch() },
      );
    } catch (err) {
      await deps.claimLock.release(issue);
      const reason = err instanceof Error ? err.message : String(err);
      return withdraw(
        `the claim could not be written, so this issue is declined rather than worked on a host-local lock: ${reason}`,
      );
    }
    if (decision.verdict === "lost") {
      await deps.claimLock.release(issue);
      return withdraw("another worker holds the claim", decision);
    }
    ownsCommentClaim = true;
    setActiveClaimFinalizer(async () => {
      if (!ownsCommentClaim) return;
      ownsCommentClaim = false;
      await releaseOwnedClaim(deps, input);
    });
  } else if (labels.includes(LABEL_RUNNING)) {
    await deps.claimLock.release(issue);
    return withdraw("the `running` label is already present on the issue");
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
    const verdict = await evaluateClaimTrust(
      trustPolicy,
      provenance ?? {},
      trustLookup,
      externalOrigin,
      issue,
    );
    if (!verdict.executable) {
      // An unapproved external-origin HOLD parks the issue as `ready-for-human`
      // (never claimable), rather than merely un-claiming it.
      if (verdict.holdForApproval) {
        await deps.gh.ensureLabel(LABEL_HUMAN);
        await editIssueLifecycleLabels(deps, issue, labels, [LABEL_READY], [LABEL_HUMAN], "preflight-blocked");
        await deps.gh.comment(
          issue,
          `🤖 /afk external-origin gate: ${verdict.reason}`,
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
      return withdraw(
        `the trust gate refused the issue [${describeTrustPosture(trustPolicy)}]: ${verdict.reason ?? "no rationale reported"}`,
      );
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
    return withdraw("the `running` label could not be projected onto the issue");
  }
  deps.recordWorkerEvent?.("worker.claimed", { title: input.title });
  const slug = slugifyRef(input.title);
  const branch = buildRefFromSlug("afk", input.workerId, issue, slug);
  if (branch === null) {
    await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], [LABEL_READY], "retry");
    await releaseClaim();
    return withdraw(`no valid branch name could be built from the issue title ${JSON.stringify(input.title)}`);
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
  const candidateBranch = discoverResumableBranch(allBranches, issue);
  // Issue #2865 — ask git what the branch HOLDS before deciding its fate. The
  // ref name is not evidence: worktree creation pushes `afk/<issue>-<slug>`
  // before the agent writes a line, so a dead Worker's nine committed slices and
  // an empty placeholder read identically by name. Whatever this Worker declines
  // to adopt, `prepareFreshWorkerBranch` deletes from origin.
  const candidateCommitsAhead = candidateBranch
    ? await deps.lookups.branchCommitsAhead?.(candidateBranch.branch, base).catch(() => undefined)
    : undefined;
  const adoption = decideBranchAdoption({
    candidate: candidateBranch,
    commitsAhead: candidateCommitsAhead,
    explicitRestart,
    hasOpenPullRequest: matchingPullRequests.length > 0,
  });
  // Committed work is never invisible: a refusal states its reason on the issue,
  // and a branch carrying commits that no pull request mentions is named rather
  // than silently orphaned.
  const adoptionNotice = formatAdoptionNotice(adoption, issue);
  if (adoptionNotice) {
    await deps.gh.comment(issue, adoptionNotice);
    deps.appendIterLog(adoptionNotice);
  }
  const resumableBranch = adoptedPullRequest
    ? { branch: adoptedPullRequest.headRefName }
    : adoption.kind === "adopt"
      ? candidateBranch
      : null;
  const failureReason = extractFailureReason(prevFailureContext);
  const carriedValidationSignature = parseValidationFailureSignature(failureReason);
  const usesDeclaredValidationMoments = deps.validationMoments !== undefined;
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
    mergeGateCommands: usesDeclaredValidationMoments
      ? (deps.validationMoments?.post_done ?? [])
      : [
          ...(deps.feedbackCommands ?? []),
          ...(deps.backpressureCommands ?? []),
        ],
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
  // below happens inside ONE Worker — same Worker, same Worktree, same branch.
  // It is still carried on the legacy `attempt`/`attempt_n` fields because those
  // are the hook contract; the name here says what it counts.
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
  const branchReversionRecords = new Map<"base-merge" | "landing", string>();
  const completeValidationSidecar = (): string[] => [
    ...branchReversionRecords.values(),
    ...validationSidecar,
  ];
  let postDoneCorrectionCommands: readonly string[] | undefined;
  let lastValidationScope: ValidationScope | undefined = undefined;
  let landingFeedbackScopes: string[] = ["."];
  let noSourceDiffWarning: string | undefined;
  let currentHandoff = handoff;
  let correctionLedger: CorrectionLedger = EMPTY_CORRECTION_LEDGER;
  const validationBaseRef = usesDeclaredValidationMoments
    ? (baseResolution.sha || baseRef)
    : baseRef;
  const skippedMomentResult = (
    moment: "post_done" | "landing",
    validationScope?: ValidationScope,
  ): RunFeedbackResult => {
    const record = buildValidationRecord({
      name: `validation:${moment}`,
      status: "skipped",
      summary: "undeclared",
    });
    deps.appendIterLog(`🤖 /afk validation moment ${moment} skipped: undeclared.`);
    return {
      ok: true,
      checks: [],
      sidecar: [formatValidationLine(record)],
      baselineInconclusive: [],
      quarantined: [],
      ...(validationScope === undefined ? {} : { validationScope }),
    };
  };
  const runDeclaredMoment = async (
    moment: "post_done" | "landing",
    commands: readonly string[] | undefined,
    scopes: readonly string[],
    validationScope?: ValidationScope,
  ): Promise<RunFeedbackResult> => {
    if (commands === undefined) return skippedMomentResult(moment, validationScope);
    deps.appendIterLog(
      `🤖 /afk validation moment ${moment} running ${commands.length} declared command${commands.length === 1 ? "" : "s"}.`,
    );
    const result = await runFeedback(deps.pnpm, {
      worktree: workerBranch,
      worktreeKind: "branch",
      scopes,
      layout: deps.layout,
      now: deps.nowEpoch,
      validationScope,
      resourceBudget: deps.validationResourceBudget,
      commands,
      commandExec: deps.backpressure,
    });
    deps.appendIterLog(
      `🤖 /afk validation moment ${moment} ${result.ok ? "passed" : "failed"}.`,
    );
    return result;
  };
  // Two consecutive identical suspect-infra readings on the gate-only rerun
  // saw the same branch and the same environment. That is deterministic setup
  // failure, not a flake worth another free cycle or outer recovery attempt.
  let previousSuspectInfraSignature: string | undefined;
  let deterministicInfraSignature: string | undefined;

  const evaluateBranchReversion = (
    stage: "base-merge" | "landing",
    geometry: BranchReversionGeometry,
  ): BranchReversionFinding => {
    const finding = detectBranchReversion(
      geometry.diff,
      geometry.forkPoint,
      geometry.afterForkBasePatch,
      input.body,
      remoteTrackingBaseRef(input.remote, base),
    );
    const record = formatBranchReversionRecord(finding, stage);
    branchReversionRecords.set(stage, record);
    return finding;
  };
  const parkBranchReversion = async (
    finding: BranchReversionFinding,
  ): Promise<ProcessIssueResult> => {
    const intentSidecar = completeValidationSidecar();
    await writeValidationSidecar(deps, input.attemptDir, intentSidecar);
    const files = finding.repair?.files.join(", ") || "the recorded files";
    const repair = finding.repair?.command ?? "human intent resolution required";
    const notes =
      `Intent finding: the branch would erase after-fork base work or silently shrink test source ` +
      `(${files}). The branch was parked without an automatic fix. Repair: ${repair}`;
    deps.appendIterLog(`🤖 /afk: ${notes}`);
    return await terminalFailure(
      common,
      "feedback-failed",
      "validation",
      { notes, validation: intentSidecar.join("\n") },
      { validationSummary: intentSidecar.join("\n") },
    );
  };
  // A stale-base attribution buys another GATE run, not another implementer
  // run: the branch did not change, only the merge result did (#3231).
  let gateRevalidationSkip = false;
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
  const attributeGateFailureNow = async (driftEligible: boolean, suspectInfra: boolean): Promise<{
    attribution: GateFailureAttribution;
    drift?: StaleBaseDriftNote;
  }> => {
    const movement = driftEligible && !suspectInfra ? await observeBaseMovement() : undefined;
    const attribution = attributeGateFailure({
      movement,
      suspectInfra,
      refundsUsed: correctionLedger.refunded,
      maxRefunds: staleBaseDriftCap,
    });
    if (attribution.cause !== "stale-base-drift" || !movement) return { attribution };
    return { attribution, drift: { base, movement, attribution } };
  };
  const afkGateCap = resolveReseedGateBudget(deps);
  const isGoLane = input.laneLabel === LABEL_GO_LANE;
  const reseedLane: "/go" | "/afk" = isGoLane ? "/go" : "/afk";
  /**
   * Is the fold's review stage ACTIVATED for this Worker? Decided ONCE, from
   * everything that can switch it off — the operator's `enabled` flag, a missing
   * reviewer/publisher port, a `/go` direct-PR dispatch, or no worktree-diff
   * reader — because a disabled stage has to be a no-op on EVERY surface it
   * touches, not just at its own call site (#2985). It gates two things: whether
   * `runReviewStage` runs at all, and whether the Re-seed budget reserves the
   * round it would have drawn.
   */
  const reviewStageActivated =
    deps.adversarialReview?.enabled === true &&
    deps.extractAdversarialReview !== undefined &&
    deps.postAdversarialReview !== undefined &&
    deps.lookups.worktreeDiff !== undefined &&
    // /go direct-PR skips review; /go no-mistakes and /afk run it.
    (!isGoLane || isPrePrPipelineActive(input.runMode, input.laneLabel));
  // ONE budget for every Re-seed this Worker may spend (ADR 0129): the lane
  // supplies the ceiling and the review's reservation, the operator's configured
  // counter supplies only the gate's share. A tier escalation therefore draws
  // its own round instead of muting gate correction outright.
  const reseedBudget = withGateSubCap(
    resolveReseedBudget({
      laneLabel: input.laneLabel,
      runMode: input.runMode,
      reviewEnabled: reviewStageActivated,
    }),
    isGoLane ? goVerifyRetryCap : afkGateCap,
  );
  let reseedSpend: ReseedSpend = {};
  const gateSubCap = reseedBudget.subCaps.gate;
  // What is outstanding RIGHT NOW (ADR 0129 decision 7, #2728). It survives
  // across rounds so a gate round that follows a blocking review carries BOTH;
  // the composition itself always starts from the ORIGINAL handoff, which is
  // what keeps the prompt flat while the state inside it accumulates.
  let reseedOutstanding: ReseedOutstanding = EMPTY_RESEED_OUTSTANDING;
  /** Rounds re-seeded so far. Distinct from `roundOrdinal`, which also counts
   * the recovery re-runs a crashed agent buys — those are not Re-seed rounds and
   * must not read as budget spent. */
  let reseedRound = 0;
  /** Compose the re-seeded prompt from the original handoff plus the current
   * outstanding state, and report the round in one history line. */
  const composeReseed = (tag: ReseedSectionTag, directives: readonly string[], tier?: string): string =>
    composeReseedHandoff(handoff, {
      tag,
      directives,
      history: {
        round: reseedRound,
        ceiling: reseedBudget.ceiling,
        tier: tier || activeTaskClass,
        repeats: reseedOutstanding.repeats,
      },
      outstanding: reseedOutstanding,
    });
  /** Whether a Re-seed round was granted. `hook-aborted` is not exhaustion — the
   * budget was drawn and the round IS running; the `pre_attempt` hook refused
   * it, which each caller handles the way it always has. */
  type ReseedOutcome = "granted" | "refused" | "hook-aborted";
  interface ReseedRequest {
    trigger: ReseedTrigger;
    /** The gate stage that blocked, for the two gate-shaped triggers. */
    gate?: "feedback" | "backpressure";
    /** The gate tail. Absent on a review round, which carries findings instead. */
    validation?: string;
    /** The raw `red.afk.validation.v1` sidecar lines behind `validation`, for
     * the failure signature that yields the history line's repeat count. */
    sidecar?: readonly string[];
    /** False for the empty-diff rejection: a branch that carries no diff at all
     * is unambiguously the branch's problem, and no amount of base movement can
     * explain it away. */
    driftEligible?: boolean;
    /** True when the gate record already says the command failed too quickly to
     * have started, so the cause belongs to the shared free-cycle pool. */
    suspectInfra?: boolean;
    /** Tier escalation only — which tier failed and which one now runs. */
    tiers?: { from: string; to: string };
    /** Review only — the blocking findings and the diff they were raised
     * against, which become the review half of the outstanding state. */
    review?: { summary: string; findings: readonly AdversarialReviewFinding[]; diff: string };
    /** The round's failure signature, when the caller already derived it to
     * decide something (the tier escalation does). Absent, it is derived here
     * from `sidecar` — one key either way. */
    signature?: string;
  }
  /** The failure signature of the round that just failed: the gate's sidecar
   * plus whatever the review still has outstanding, which is exactly what the
   * history line's repeat count and the tier escalation both key off. */
  const roundSignature = (sidecar: readonly string[] | undefined): string =>
    failureSignature({ sidecar, findings: reseedOutstanding.review?.findings ?? [] });
  /** The trail's two derived surfaces (#2731), built on the FIRST Re-seed and
   * not before: a Worker that never re-seeds opens no pull request and posts
   * no comment, which is the whole point of minting the draft lazily. The build
   * is deferred to first use so it pins the branch the agent actually ran on. */
  let trail: ReseedTrail | undefined;
  const publishReseedTrail = async (round: ReseedTrailRound): Promise<void> => {
    trail ??= createReseedTrail(
      {
        gh: deps.reseedTrailGh,
        mergeExec: deps.mergeExec,
        remoteGit: deps.remoteGit,
        appendIterLog: deps.appendIterLog,
        recordWorkerEvent: deps.recordWorkerEvent,
      },
      {
        issue,
        repo: input.repo,
        repoDir: input.repoDir,
        branch: workerBranch,
        base,
        title: input.title,
        lane: reseedLane,
        ceiling: reseedBudget.ceiling,
      },
    );
    // Best-effort by contract: the Worker's branch and iteration log already
    // hold the round, so a forge that refuses a projection must never fail the
    // Re-seed itself.
    try {
      await trail.publish(round);
    } catch {
      // observability only.
    }
  };
  /** The ONE exit an exhausted Re-seed budget takes (#2732), whatever cause
   * exhausted it: seal both projections on the same `blocked:validation` state
   * and the same evidence, and leave the draft OPEN — a validation park is
   * precisely when a human needs the diff. A Worker that never re-seeded has
   * no trail and therefore nothing to seal: it parks as it always did. */
  const parkReseedTrail = async (evidence: string): Promise<void> => {
    if (!trail) return;
    try {
      await trail.park({ evidence });
    } catch {
      // observability only.
    }
  };
  /** The single Re-seed request path. Every caller that re-instructs the
   * implementer IN PLACE — same Worker, same Worktree, same branch — comes
   * through here: it checks the ceiling and the cause's sub-cap or reservation,
   * bumps the round ordinal, appends to the handoff, fires `pre_attempt`, and
   * emits one worker event naming the trigger.
   *
   * A drift-attributed failure exits before the Re-seed mechanics: it records a
   * free ledger cycle and requests gate-only re-validation, because no
   * implementer work changed (#3231). */
  const requestReseed = async (req: ReseedRequest): Promise<ReseedOutcome> => {
    const cause = reseedTriggerCause(req.trigger);
    const { attribution, drift } =
      cause === "gate"
        ? await attributeGateFailureNow(req.driftEligible ?? false, req.suspectInfra ?? false)
        : { attribution: undefined, drift: undefined };
    const signature = req.signature ?? roundSignature(req.sidecar);
    if (attribution?.cause === "suspect-infra") {
      if (previousSuspectInfraSignature === signature) {
        deterministicInfraSignature = signature;
        const gate = req.gate ?? "feedback";
        const note =
          `🤖 ${reseedLane}: ${gate} machine gate repeated deterministic suspect-infra ` +
          `signature=${signature} on the unchanged branch/environment; parking immediately ` +
          `without another free correction or recovery retry.`;
        deps.appendIterLog(note);
        deps.recordWorkerEvent?.("worker.gate_revalidation_refused", {
          trigger: req.trigger,
          cause: "deterministic-suspect-infra",
          signature,
          lane: reseedBudget.lane,
        });
        return "refused";
      }
      previousSuspectInfraSignature = signature;
    } else {
      previousSuspectInfraSignature = undefined;
    }
    if (attribution && attribution.cause !== "branch-fault") {
      correctionLedger = chargeCorrection(correctionLedger, attribution.cause);
      gateRevalidationSkip = true;
      const gate = req.gate ?? "feedback";
      const releaseBumps = attribution.releaseBumps.length > 0
        ? ` Release bump: ${attribution.releaseBumps.join("; ")}.`
        : "";
      const freeCause = attribution.cause === "stale-base-drift" ? "stale-base" : attribution.cause;
      const note =
        `🤖 ${reseedLane}: ${gate} machine gate failed after DONE, but ${attribution.reason}; ` +
        `granting a free ${freeCause} correction (${correctionLedger.refunded}/${staleBaseDriftCap}), ` +
        `re-running validation without re-seeding; budget untouched at ` +
        `${reseedSpend.gate ?? 0}/${gateSubCap}.${releaseBumps}`;
      deps.appendIterLog(note);
      deps.recordWorkerEvent?.("worker.gate_revalidation_requested", {
        trigger: req.trigger,
        cause: attribution.cause,
        lane: reseedBudget.lane,
        free: true,
        cycle: correctionLedger.refunded,
        cap: staleBaseDriftCap,
      });
      return "granted";
    }
    const draw = reseedDraw(reseedBudget, cause, reseedSpend);
    if (!draw.allowed) return "refused";
    if (attribution) correctionLedger = chargeCorrection(correctionLedger, attribution.cause);
    reseedSpend = recordReseedDraw(reseedSpend, cause);
    roundOrdinal += 1;
    reseedRound += 1;
    const gate = req.gate ?? "feedback";
    // The gate tail is outstanding state, not a round in a narrative: the newest
    // reading REPLACES the previous one, while anything the review left
    // outstanding rides along untouched. A review round updates the OTHER half
    // by the same rule, so a still-red gate keeps its tail beside the findings.
    reseedOutstanding = noteReseedSignature(
      req.review
        ? withReviewOutstanding(reseedOutstanding, req.review)
        : withGateOutstanding(reseedOutstanding, { gate, validation: req.validation ?? "", drift }),
      signature,
    );
    const gateSpend = reseedSpend.gate ?? 0;
    /** The round's one-line account. It reaches the iteration log AND the trail's
     * two projections, so the surfaces cannot disagree about what the round was
     * asked to fix. */
    let note: string;
    if (req.trigger === "review-finding") {
      const reviewSpend = reseedSpend.review ?? 0;
      currentHandoff = composeReseed(
        "adversarial-review-correction",
        reviewReseedDirectives({ retry: reviewSpend, cap: reseedBudget.subCaps.review }),
      );
      note =
        `🤖 ${reseedLane}: adversarial review found blocking issue(s); ` +
        `correction retry ${reviewSpend}/${reseedBudget.subCaps.review}.`;
    } else if (req.trigger === "tier-escalation") {
      currentHandoff = composeReseed(
        "tier-escalation",
        tierEscalationDirectives({
          from: req.tiers?.from ?? "",
          to: req.tiers?.to ?? "",
          retry: reseedSpend.tier ?? 0,
          cap: reseedBudget.subCaps.tier,
        }),
        req.tiers?.to,
      );
      note =
        `🤖 ${reseedLane}: ${req.tiers?.from ?? ""}-tier feedback failed for #${issue}; ` +
        `re-seeding on the ${req.tiers?.to ?? ""} tier before terminal validation routing.`;
    } else {
      currentHandoff = composeReseed(
        isGoLane ? "go-machine-gate-retry" : "afk-gate-correction",
        gateReseedDirectives({ gate, retry: gateSpend, cap: gateSubCap }),
      );
      note = `🤖 ${reseedLane}: ${gate} machine gate failed after DONE; correction retry ${gateSpend}/${gateSubCap}.`;
    }
    deps.appendIterLog(note);
    await publishReseedTrail({ round: reseedRound, trigger: req.trigger, cause, note });
    deps.recordWorkerEvent?.("worker.reseeded", {
      trigger: req.trigger,
      cause,
      lane: reseedBudget.lane,
      free: false,
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
    sidecar?: readonly string[],
    suspectInfra: boolean = false,
  ): Promise<boolean> =>
    (await requestReseed({
      trigger,
      gate,
      validation,
      sidecar,
      driftEligible: trigger === "gate-stage" && !usesDeclaredValidationMoments,
      suspectInfra,
    })) ===
    "granted";
  /** The park-note suffix naming the exhausted correction budget. It reports the
   * CHARGED cycles against the lane's cap and, separately, the stale-base cycles
   * that were absorbed for free — so a reader can tell a branch that really kept
   * failing from a run that spent itself absorbing base drift (#2711). */
  const correctionBudgetNote = (): string => {
    if (correctionLedger.cycles.length === 0) return "";
    if (!correctionBudgetExhausted(correctionLedger, gateSubCap)) return "";
    return ` Post-DONE gate-correction budget exhausted (${describeCorrectionLedger(correctionLedger, gateSubCap)}).`;
  };
  /**
   * Classify a FAILED gate stage as INFRA or SEMANTIC, for EITHER stage (#2964).
   *
   * The guard used to live inline in the feedback branch alone, so a backpressure
   * command that never executed — the feedback worktree failed to materialise and
   * the executor short-circuited to exit 1 with `durationMs: 0` — was charged as
   * a semantic failure and re-instructed three times against a gate that had run
   * nothing. Both stages emit the same `red.afk.validation.v1` records, so both
   * get the same classifier and the same `on_feedback_classify` hook. Hooks may
   * downgrade semantic failures to infra, but environment evidence is
   * authoritative: a hook cannot turn an unrunnable round into branch blame.
   *
   * A hook override is HONOURED and NAMED: the returned `note` states what the
   * classifier said and what the hook made it, so a reclassification is visible
   * in the record instead of silently rewriting the routing.
   */
  const classifyGateFailure = async (
    stage: "feedback" | "backpressure",
    checks: readonly ClassifiableCheck[],
  ): Promise<{ isInfra: boolean; note: string }> => {
    const classified = isInfraValidationFailure(checks);
    const classResult = await fireHookCtx(
      "on_feedback_classify",
      hookContext({
        issue,
        title: input.title,
        workspace: branch,
        class: classified ? "infra" : "semantic",
      }),
    );
    const override = parseFeedbackClass(classResult.context);
    if (override === null) return { isInfra: classified, note: "" };
    if (classified && override === "semantic") {
      return {
        isInfra: true,
        note:
          `🤖 ${stage} environment failure remained \`infra\`; the ` +
          `\`on_feedback_classify\` hook requested \`semantic\`, but environment verdicts cannot be overridden.`,
      };
    }
    const isInfra = override === "infra";
    const note =
      `🤖 classification override: the \`on_feedback_classify\` hook set the ${stage} ` +
      `failure to \`${override}\` (the classifier read it as ` +
      `\`${classified ? "infra" : "semantic"}\`).`;
    return { isInfra, note };
  };
  /** What the review stage decided, in the fold's own vocabulary plus what the
   * lifecycle must do next. */
  interface ReviewStageResult {
    outcome: GateStageOutcome;
    next: "proceed" | "reseeded" | "park" | "hook-aborted";
    /** The park's blocker summary, present only on `park`. */
    validation?: string;
  }
  /** A stage that could not run. It is SKIPPED, never failed: `gateVerdict`
   * ignores a skipped stage, so infrastructure trouble in the reviewer degrades
   * the gate instead of destroying machine-validated work (#2352). */
  const skippedReviewStage: ReviewStageResult = {
    outcome: { stage: "review", ok: true, skipped: true },
    next: "proceed",
  };
  /**
   * The gate fold's THIRD stage (ADR 0129, #2730). It reads the WORKTREE diff
   * against the merge base — the branch as it actually stands, before any pull
   * request exists — and reduces to one question: does anything here block?
   *
   * A blocking finding asks for a Re-seed through the single request path, which
   * draws the RESERVED review round. Reserving it is the whole point: under the
   * landing-path review this replaced, three gate corrections could burn the
   * budget and the review's own round would never fire.
   */
  const runReviewStage = async (): Promise<ReviewStageResult> => {
    // ONE predicate, resolved at Worker start (see `reviewStageActivated`): a
    // deactivated stage returns the SKIPPED outcome without reading a diff,
    // spawning a reviewer, or awaiting anything.
    if (!reviewStageActivated) return skippedReviewStage;
    const config = deps.adversarialReview!;
    const readWorktreeDiff = deps.lookups.worktreeDiff!;
    const extractReview = deps.extractAdversarialReview!;
    const postReview = deps.postAdversarialReview!;
    let findings: AdversarialReviewFindings;
    let decision: AdversarialReviewDecision;
    let diff: string;
    try {
      diff = await readWorktreeDiff(workerBranch, baseRef);
      const context = {
        issueNumber: input.issue,
        issueTitle: input.title,
        issueBody: input.body,
        diff,
        base: baseRef,
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
          await extractReview({
            context,
            runner: reviewer.runner,
            model: reviewer.model,
            effort: reviewer.effort,
            maxIterations: config.maxIterations,
          }),
        );
      }
      findings = aggregateAdversarialReviewFindings(reviews, config.quorum);
      decision = decideAdversarialReview(findings);
      await postReview({
        issue: input.issue,
        findings,
        body: renderAdversarialReviewComment(findings, decision),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.appendIterLog(`[adversarial-review] review stage skipped: ${reason}`);
      deps.recordWorkerEvent?.("worker.review_degraded", {
        issue: input.issue,
        decision: "skipped",
        reason,
      });
      return skippedReviewStage;
    }
    if (decision === "not-blocking") {
      // A clean review clears the review half of the outstanding state: the
      // findings a previous round carried are fixed, and re-instructing on them
      // would send the implementer after work that is already done (#2728).
      reseedOutstanding = withoutReviewOutstanding(reseedOutstanding);
      return { outcome: { stage: "review", ok: true }, next: "proceed" };
    }
    const blocking = findings.findings.filter((finding) => finding.blocking);
    const reseed = await requestReseed({
      trigger: "review-finding",
      review: { summary: findings.summary, findings: blocking, diff },
      signature: failureSignature({ findings: blocking }),
    });
    if (reseed === "granted") return { outcome: { stage: "review", ok: false }, next: "reseeded" };
    if (reseed === "hook-aborted") return { outcome: { stage: "review", ok: false }, next: "hook-aborted" };
    // Exhausted parks — uniformly, with no cap-dependent branch that could land
    // code carrying a known blocking finding.
    const validation = renderAdversarialReviewBlockerSummary(findings, reseedBudget.subCaps.review);
    deps.appendIterLog(`🤖 ${reseedLane}: ${validation} Parked to ready-for-human.`);
    return { outcome: { stage: "review", ok: false }, next: "park", validation };
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
    let skippedAgentForGateOnly = false;
    if (gateGreenSkip || gateRevalidationSkip) {
      const fastBranch = gateGreenSkip ? resumableBranch!.branch : workerBranch;
      if (gateGreenSkip) {
        gateGreenSkip = false;
        deps.appendIterLog(
          `🤖 /afk #${issue}: gate-green fast path — re-validating \`${fastBranch}\`, agent skipped.`,
        );
      } else {
        gateRevalidationSkip = false;
        skippedAgentForGateOnly = true;
        deps.appendIterLog(
          `🤖 ${reseedLane} #${issue}: stale-base fast path — re-validating \`${fastBranch}\`, agent skipped.`,
        );
      }
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
      if (!skippedAgentForGateOnly) {
        await fireHook("post_attempt", postAttemptContext(current, workerBranch, pwStatus, run.outcome));
      }
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
    if (!skippedAgentForGateOnly && deps.postWorkerFormat && postWorkerFormatCommands.length > 0) {
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

    const changedFiles = await deps.lookups.changedFiles(workerBranch, validationBaseRef);
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
    let rootPackageJson: { before: string; after: string } | undefined;
    if (changedFiles.some((file) => file === "package.json" || file === "./package.json")) {
      rootPackageJson = await deps.lookups
        .changedFileContents?.(workerBranch, validationBaseRef, "package.json")
        .catch(() => undefined);
    }
    const validationScope = computeValidationScope(
      changedFiles,
      deps.layout,
      deps.graph ?? { packages: [] },
      rootPackageJson ? { rootPackageJson } : undefined,
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
    if (deps.requireBranchReversionSafety && !deps.baseMergeReversionGeometry) {
      const reason = "branch reversion safety is required but the feedback base-merge geometry port is absent";
      deps.appendIterLog(`🤖 /afk: ${reason}`);
      return await terminalFailure(common, "infra", "infra", { log: reason }, { notes: reason });
    }
    let feedback: RunFeedbackResult;
    if (usesDeclaredValidationMoments) {
      const fullDeclaration = deps.validationMoments?.post_done;
      feedback = await runDeclaredMoment(
        "post_done",
        postDoneCorrectionCommands ?? fullDeclaration,
        feedbackScopes,
        validationScope,
      );
      if (postDoneCorrectionCommands !== undefined && feedback.ok) {
        deps.appendIterLog(
          "🤖 /afk validation moment post_done correction subset passed; folding back to the full declaration.",
        );
        postDoneCorrectionCommands = undefined;
        feedback = await runDeclaredMoment("post_done", fullDeclaration, feedbackScopes, validationScope);
      }
      if (!feedback.ok && fullDeclaration !== undefined) {
        const failedCommands = feedback.checks.flatMap((check) =>
          check.status === "failed" && check.record.command ? [check.record.command] : []
        );
        postDoneCorrectionCommands = failedCommands.length > 0 ? failedCommands : fullDeclaration;
      }
    } else {
      feedback = await runFeedback(deps.pnpm, {
        worktree: workerBranch,
        // A branch NAME, not a directory (#3041): `deps.pnpm` materialises it and
        // reports back the absolute checkout it ran in. Declaring the kind keeps
        // the gate from ever reading the branch token as a missing directory.
        worktreeKind: "branch",
        scopes: feedbackScopes,
        layout: deps.layout,
        now: deps.nowEpoch,
        baselineWorktree: base,
        validationScope,
        resourceBudget: deps.validationResourceBudget,
        ...(deps.feedbackCommands === undefined
          ? {}
          : { commands: deps.feedbackCommands, commandExec: deps.backpressure }),
      });
    }
    markProcessSafetyStep("post-agent:feedback-done");
    const baseMergeGeometry = deps.baseMergeReversionGeometry?.(workerBranch);
    if (baseMergeGeometry) {
      const finding = evaluateBranchReversion("base-merge", baseMergeGeometry);
      if (finding.blocked) return await parkBranchReversion(finding);
    }
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
      const classification = await classifyGateFailure("feedback", feedback.checks);
      const isInfra = classification.isInfra;
      const scopeHeader = feedback.validationScope
        ? `${formatValidationScope(feedback.validationScope)}\n`
        : "";
      const overrideFooter = classification.note === "" ? "" : `\n${classification.note}`;
      const validationText = `${scopeHeader}${feedback.sidecar.join("\n")}${overrideFooter}`;
      // A REPEATED failure buys a HIGHER tier rather than another round at the
      // tier that just failed (ADR 0129 decision 6, #2729). The trigger is the
      // repeat, not the failure: a round that failed a different way is progress
      // and is re-instructed at the tier that produced it. It draws the `tier`
      // sub-cap, so gate correction keeps its own share — the mute this replaced
      // cost a Ticket its whole gate budget for one tier bump.
      const roundKey = roundSignature(feedback.sidecar);
      const escalationDecision = isInfra
        ? ({ escalate: false, refusal: "no-repeat" } as const)
        : decideTierEscalation({
            tier: activeTaskClass,
            previousSignature: reseedOutstanding.signature,
            signature: roundKey,
            budget: reseedBudget,
            spend: reseedSpend,
          });
      if (escalationDecision.escalate) {
        const escalation = await requestReseed({
          trigger: "tier-escalation",
          validation: validationText,
          sidecar: feedback.sidecar,
          signature: roundKey,
          tiers: { from: escalationDecision.from, to: escalationDecision.to },
        });
        if (escalation === "hook-aborted") {
          return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
        }
        if (escalation === "granted") {
          activeTaskClass = escalationDecision.to;
          continue;
        }
      }
      const repeatedOuterInfra = isInfra && carriedValidationSignature === roundKey;
      const outcome: ProcessOutcome = isInfra && !repeatedOuterInfra
        ? "feedback-failed-infra"
        : "feedback-failed";
      let notes: string;
      if (repeatedOuterInfra) {
        notes =
          `Feedback validation repeated deterministic INFRA signature ${roundKey} on the ` +
          `unchanged gate environment — parked immediately without spending another recovery retry.`;
        deps.appendIterLog(`🤖 /afk: deterministic validation infra signature=${roundKey} repeated across Workers; parking immediately.`);
      } else if (isInfra) {
        notes =
          "Feedback validation could not judge the work because the gate environment failed " +
          "(worktree/submodule/dependency install/OOM) — the environment recovery policy will retry up to its cap.";
      } else if (salvaged) {
        notes = "Salvaged a no-sentinel branch (it carried work), but feedback validation failed — the branch was not merged.";
      } else {
        notes = "Feedback validation failed after the inner agent emitted DONE. The worker branch was not merged.";
      }
      if (classification.note !== "") notes += ` ${classification.note}`;
      const suspectInfra = feedback.checks.some(
        (check) => check.status === "failed" && check.record.suspectInfra === true,
      );
      if (!isInfra && (await reseedAfterGate("gate-stage", "feedback", validationText, feedback.sidecar, suspectInfra))) {
        continue;
      }
      if (deterministicInfraSignature) {
        notes +=
          ` Deterministic suspect-infra signature ${deterministicInfraSignature} repeated ` +
          `on the unchanged gate environment; parked immediately without recovery retry.`;
      }
      if (!isInfra) {
        notes += correctionBudgetNote();
        await parkReseedTrail(validationText);
      }
      return await terminalFailure(common, outcome, "feedback", {
        notes,
        validation: validationText,
      }, { validationSummary: feedback.sidecar.join("\n") });
    }
    const backpressureCommands = usesDeclaredValidationMoments ? [] : (deps.backpressureCommands ?? []);
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
        // The backpressure stage is classified exactly like the feedback stage
        // (#2964). It has to be: `bash scripts/gate.sh` failing at `durationMs:
        // 0` because the feedback worktree never materialised is an environment
        // failure, and charging it as semantic re-instructed six green branches
        // three times each against a gate that never executed.
        const bpClass = await classifyGateFailure("backpressure", backpressure.checks);
        const bpInfra = bpClass.isInfra;
        const bpSignature = failureSignature({ sidecar: backpressure.sidecar });
        const repeatedOuterInfra = bpInfra && carriedValidationSignature === bpSignature;
        let bpNotes = repeatedOuterInfra
          ? `Backpressure validation repeated deterministic INFRA signature ${bpSignature} on the unchanged gate environment — parked immediately without spending another recovery retry.`
          : bpInfra
          ? "Backpressure validation could not judge the work because the gate environment failed " +
            "(worktree/submodule/dependency install/OOM) — the environment recovery policy will retry up to its cap."
          : "Backpressure validation failed after the feedback gate passed. The worker branch was not merged.";
        if (repeatedOuterInfra) {
          deps.appendIterLog(`🤖 /afk: deterministic backpressure infra signature=${bpSignature} repeated across Workers; parking immediately.`);
        }
        if (bpClass.note !== "") bpNotes += ` ${bpClass.note}`;
        const overrideFooter = bpClass.note === "" ? "" : `\n${bpClass.note}`;
        const validationText = `${backpressure.sidecar.join("\n")}${overrideFooter}`;
        const suspectInfra = backpressure.checks.some(
          (check) => check.status === "failed" && check.record.suspectInfra === true,
        );
        if (!bpInfra && (
          await reseedAfterGate("gate-stage", "backpressure", validationText, backpressure.sidecar, suspectInfra)
        )) {
          continue;
        }
        if (deterministicInfraSignature) {
          bpNotes +=
            ` Deterministic suspect-infra signature ${deterministicInfraSignature} repeated ` +
            `on the unchanged gate environment; parked immediately without recovery retry.`;
        }
        if (!bpInfra) {
          bpNotes += correctionBudgetNote();
          await parkReseedTrail(validationText);
        }
        return await terminalFailure(common, bpInfra && !repeatedOuterInfra ? "feedback-failed-infra" : "feedback-failed", "feedback", {
          notes: bpNotes,
          validation: validationText,
        }, { validationSummary: validationText });
      }
    }
    validationSidecar = [...feedback.sidecar, ...backpressureSidecar];
    lastValidationScope = feedback.validationScope;
    // The fold's third stage runs only once the earlier ones are green: the loop
    // reaches here exactly when nothing before it blocked, which is what keeps
    // the most expensive stage off a branch the cheap stages already rejected.
    const review = await runReviewStage();
    gateStages.push(review.outcome);
    if (review.next === "reseeded") continue;
    if (review.next === "hook-aborted") {
      return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
    }
    if (review.next === "park") {
      const validation = review.validation ?? "Blocking review findings remain.";
      await writeValidationSidecar(deps, input.attemptDir, [...completeValidationSidecar(), validation]);
      await parkReseedTrail(validation);
      return await terminalFailure(
        common,
        "feedback-failed",
        "feedback",
        {
          notes: "Blocking review findings remained after the Re-seed budget's reserved review round. The worker branch was not merged.",
          validation,
        },
        { validationSummary: validation },
      );
    }
    // ONE verdict for the whole gate (ADR 0119): the stages accumulated above
    // fold into a single `ok` instead of three independent booleans a reader has
    // to reassemble. A backpressure stage that never ran is simply absent from
    // the fold, and an absent stage cannot block.
    const gateOk = gateVerdict(gateStages).ok;
    // A stage that passed is no longer OUTSTANDING (#2728). Dropping its tail
    // here is what keeps the re-seeded prompt a statement of current state
    // rather than an archive: only what is still red rides into the next round.
    if (gateOk) reseedOutstanding = withoutGateOutstanding(reseedOutstanding);
    deps.recordWorkerEvent?.("worker.validated", {
      feedback_records: feedback.sidecar.length,
      backpressure_records: backpressureSidecar.length,
      scope: feedback.validationScope?.type ?? "",
      gate_ok: gateOk,
    });

  markProcessSafetyStep("post-agent:landing-start");
  if (usesDeclaredValidationMoments) {
    const landingValidation = await runDeclaredMoment(
      "landing",
      deps.validationMoments?.landing,
      landingFeedbackScopes,
      lastValidationScope,
    );
    validationSidecar = [...validationSidecar, ...landingValidation.sidecar];
    if (!landingValidation.ok) {
      const completeSidecar = completeValidationSidecar();
      await writeValidationSidecar(deps, input.attemptDir, completeSidecar);
      const validationText = completeSidecar.join("\n");
      return await terminalFailure(
        common,
        "feedback-failed",
        "feedback",
        {
          notes: "The declared landing validation moment failed before push or pull-request creation.",
          validation: validationText,
        },
        { validationSummary: validationText },
      );
    }
  }
  const locked = await deps.lookups.isLocked();
  const openPr = deps.worktreeLaunchesPr !== false;
  if (labels.includes(LABEL_LANDING_MANUAL)) {
    return await handoffForManualLanding(common, base, completeValidationSidecar());
  }
  if (openPr && deps.reviewGate && shouldRequestReview(activeTaskClass, deps.reviewGate)) {
    return await handoffForReview(common, activeTaskClass, completeValidationSidecar());
  }
  const baselineProbe = deps.lookups.branchReversionBaseline;
  const integratedDiffProbe = deps.lookups.branchReversionDiffAt;
  if (deps.requireBranchReversionSafety && (!baselineProbe || !integratedDiffProbe)) {
    const reason = "branch reversion safety is required but the Landing geometry ports are absent";
    deps.appendIterLog(`🤖 /afk: ${reason}`);
    return await terminalFailure(common, "infra", "infra", { log: reason }, { notes: reason });
  }
  let landingBaseline: Omit<BranchReversionGeometry, "diff"> | undefined;
  if (baselineProbe && integratedDiffProbe) {
    try {
      landingBaseline = await baselineProbe(workerBranch, input.remote, base);
    } catch (err) {
      const reason =
        "branch reversion safety could not capture the fresh Landing baseline: " +
        (err instanceof Error ? err.message : String(err));
      deps.appendIterLog(`🤖 /afk: ${reason}`);
      return await terminalFailure(common, "infra", "infra", { log: reason }, { notes: reason });
    }
  }
  let landingIntentFinding: BranchReversionFinding | undefined;
  let landingIntentError: string | undefined;
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
      mergeQueueWait: deps.mergeQueueWait,
      landingWait: deps.landingWait,
      makeLandingWorktree: deps.makeLandingWorktree,
      removeLandingWorktree: deps.removeLandingWorktree,
      makeRebaseWorktree: deps.makeRebaseWorktree,
      removeRebaseWorktree: deps.removeRebaseWorktree,
      landLock: deps.landLock,
      ...(landingBaseline && integratedDiffProbe
        ? {
            intentGate: async (integratedTreeDir: string) => {
              try {
                const diff = await integratedDiffProbe(integratedTreeDir, landingBaseline.baseRef);
                landingIntentFinding = evaluateBranchReversion("landing", {
                  ...landingBaseline,
                  diff,
                });
                return { ok: !landingIntentFinding.blocked };
              } catch (err) {
                landingIntentError =
                  "branch reversion safety could not inspect the integrated Landing tree: " +
                  (err instanceof Error ? err.message : String(err));
                return { ok: false };
              }
            },
          }
        : {}),
      // Backpressure evidence only. Review left this callback for the gate fold
      // (#2730): it now runs before the PR exists, on the worktree diff.
      onPrResolved: async (pr) => {
        await emitBackpressureReview(common, pr);
      },
      ...(usesDeclaredValidationMoments
        ? {}
        : {
            postMergeGate: async (mergedTreeDir: string) => {
              const mergedFeedback = await runFeedback(deps.pnpm, {
                worktree: mergedTreeDir,
                // The landing worktree is a DIRECTORY the caller just provisioned
                // (#3041). Declaring it means a vanished one refuses the gate as an
                // infrastructure error instead of composing commands against a path
                // that resolves nowhere and calling the result the branch's verdict.
                worktreeKind: "checkout",
                ...(deps.dirExists === undefined ? {} : { dirExists: deps.dirExists }),
                scopes: landingFeedbackScopes,
                layout: deps.layout,
                now: deps.nowEpoch,
                baselineWorktree: base,
                validationScope: lastValidationScope,
                resourceBudget: deps.validationResourceBudget,
                ...(deps.feedbackCommands === undefined
                  ? {}
                  : { commands: deps.feedbackCommands, commandExec: deps.backpressure }),
              });
              if (!mergedFeedback.ok) {
                validationSidecar = [...mergedFeedback.sidecar];
                await writeValidationSidecar(deps, input.attemptDir, completeValidationSidecar());
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
                  await writeValidationSidecar(deps, input.attemptDir, completeValidationSidecar());
                }
                return { ok: mergedBackpressure.ok };
              }
              validationSidecar = [...mergedFeedback.sidecar];
              return { ok: true };
            },
            requirePostMergeValidation: true,
          }),
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
      ...(landingBaseline ? { intentBaseRef: landingBaseline.baseRef } : {}),
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
    const finalValidationSidecar = completeValidationSidecar();
    await writeValidationSidecar(deps, input.attemptDir, finalValidationSidecar);
    const posted = await emitDone(common, mergeSha, durationS, finalValidationSidecar, lastValidationScope, noSourceDiffWarning);
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
              ? completed.message ?? MERGE_REJECTION_UNEXPLAINED
              : `the observer could not finish the landing tail (${completed.reason})`,
            completed.reason === "pr-merge-failed" ? MERGE_REJECTION_NEXT : undefined,
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
    if (landing.reason === "intent-finding") {
      if (landingIntentError) {
        deps.appendIterLog(`🤖 /afk: ${landingIntentError}`);
        return await terminalFailure(
          common,
          "infra",
          "infra",
          { log: landingIntentError },
          { notes: landingIntentError },
        );
      }
      if (landingIntentFinding) return await parkBranchReversion(landingIntentFinding);
      const reason = "Landing intent barrier refused without a structured reversion finding";
      return await terminalFailure(common, "infra", "infra", { log: reason }, { notes: reason });
    }
    if (landing.reason === "pr-resolved-abort") {
      // No pre-merge observer aborts any more — review left this path for the
      // gate fold (#2730). A surviving abort is an unexplained landing refusal.
      return await mergeFailed(common, "a pre-merge observer aborted the landing", landing.locked);
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
      // #2807: the landing already re-read the PR and repaired the one cause it
      // owns (an out-of-date branch). What survives to here is a refusal the PR
      // itself explained, so the note carries that observed reason verbatim —
      // never a probable one, and never a `next:` naming a check that is green.
      return await prLandingBlocked(
        common,
        "ci-failed",
        landing.prNumber,
        landing.message ?? MERGE_REJECTION_UNEXPLAINED,
        MERGE_REJECTION_NEXT,
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
        completeValidationSidecar().join("\n") ||
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
