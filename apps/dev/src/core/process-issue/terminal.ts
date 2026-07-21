import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "../base-resolver.js";
import {
  deleteRemote,
  pushAttempt,
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
import { allowlistExternalWidened, ALLOWLIST_PATH } from "../shared-gate.js";
import type { ProcessIssueDeps, ProcessIssueInput, ProcessIssueResult, ProcessOutcome, WorkerBaseResolution } from "./types.js";
import { formatBaseResolution, markTerminalState, recoveryOrdinalFor } from "./types.js";
import { editLabelsTagged, routeRecovery } from "./recovery.js";
export async function writeValidationSidecar(
  deps: ProcessIssueDeps,
  attemptDir: string,
  lines: string[],
): Promise<void> {
  if (!deps.fs.writeValidationSidecar) return;
  if (lines.length === 0) return;
  try {
    await deps.fs.writeValidationSidecar(`${attemptDir}/validation.jsonl`, lines);
  } catch {
  }
}
export async function recordAttemptBestEffort(
  c: StageCommon,
  outcome: ProcessOutcome,
  fields: { durationS?: number; mergeSha?: string; notes?: string; validationSummary?: string } = {},
): Promise<void> {
  const { deps, input } = c;
  const payload = buildAttemptRecordPayload({
    repo: input.repo,
    issue: input.issue,
    attempt: input.attempt,
    outcome,
    issueType: c.issueType,
    modelTier: c.modelTier,
    title: input.title,
    body: input.body,
    workerId: input.workerId,
    branch: c.branch,
    durationS: fields.durationS,
    diffstat: undefined,
    mergeSha: fields.mergeSha,
    notes: fields.notes,
    validationSummary: fields.validationSummary,
  });
  if (deps.recordAttempt) {
    try {
      await deps.recordAttempt(payload);
    } catch (err) {
      deps.appendIterLog(
        `🤖 /afk memory attempt-record for #${input.issue} failed (best-effort; ignored): ${String(err)}`,
      );
    }
  }
  if (!deps.recordOutcomeEvent) return;
  try {
    const event: OutcomeEvent = {
      schemaVersion: 1,
      id: `afk:${input.repo}:${input.issue}:${input.attempt}`,
      emitter: "afk",
      occurredAt: deps.nowIso(),
      taskClass: c.modelTier,
      chosenOption: {
        kind: "runner",
        runner: input.runner,
        model: c.model,
        effort: c.effort,
      },
      outcome: payload.outcome,
      cost: { signal: "unknown" },
      context: {
        repository: input.repo,
        issueNumber: input.issue,
        attemptNumber: input.attempt,
        issueType: payload.issueType,
        workerId: input.workerId,
        branch: c.branch,
        durationMs: payload.durationMs,
        status: payload.status,
      },
    };
    void deps.recordOutcomeEvent(event).catch((err) => {
      deps.appendIterLog(
        `🤖 /afk brain outcome-event for #${input.issue} failed (best-effort; ignored): ${String(err)}`,
      );
    });
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk brain outcome-event for #${input.issue} failed (best-effort; ignored): ${String(err)}`,
    );
  }
}
export interface StageCommon {
  deps: ProcessIssueDeps;
  input: ProcessIssueInput;
  branch: string;
  base: string;
  slug: string;
  hooksFired: HookName[];
  startedEpoch: number;
  issueType: string;
  modelTier: AfkModelTier;
  model?: string;
  effort?: AgentEffort;
  resolvedBase?: WorkerBaseResolution;
  backpressureChecks?: readonly BackpressureCheck[];
}
export async function emitBackpressureReview(
  c: StageCommon,
  prNumber: number | undefined,
): Promise<void> {
  const { deps } = c;
  if (prNumber === undefined || !deps.postBackpressureReview) return;
  const body = renderBackpressureReviewBody(c.backpressureChecks ?? []);
  if (body === null) return;
  try {
    await deps.postBackpressureReview(prNumber, body);
  } catch {
  }
}
export async function emitFailure(
  c: StageCommon,
  status: AttemptStatus,
  diffLabel: string,
  sections: SectionBodies,
): Promise<boolean> {
  const { deps, input } = c;
  const durationS = deps.nowEpoch() - c.startedEpoch;
  const result = await emitEnvelope(deps.envelope, {
    status,
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: c.branch,
    attempt: input.attempt,
    diff: diffLabel,
    repo: input.repo,
    repoDir: input.repoDir,
    worktreeRel: input.attemptDir,
    diffstat: "",
    sections: { ...sections, ...(c.resolvedBase ? { base: formatBaseResolution(c.resolvedBase) } : {}) },
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner },
  });
  return result.posted;
}
export function oneLine(value: string | undefined, fallback: string): string {
  const line = (value ?? "")
    .split("\n")
    .map((part) => part.replace(/^[-*]\s*(?:\[[^\]]+\]\s*)?/, "").replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  return line ?? fallback;
}
export function blockerForFailure(outcome: ProcessOutcome, sections: SectionBodies): CurrentBlocker | null {
  switch (outcome) {
    case "blocked":
      return {
        status: "blocked",
        kind: "spec",
        summary: oneLine(sections.notes, "Inner agent emitted BLOCKED."),
        next: "Review the blocker envelope and add human guidance.",
      };
    case "feedback-failed":
      return {
        status: "blocked",
        kind: "validation",
        summary: oneLine(sections.validation ?? sections.log, "Validation failed after implementation."),
        next: "Decide whether to fix forward, change scope, or adjust the acceptance criteria.",
      };
    case "no-sentinel":
      return {
        status: "blocked",
        kind: "runner",
        summary: oneLine(sections.log, "Inner agent exited without an AFK completion sentinel."),
        next: "Review the attempt log and decide whether to retry or revise the issue brief.",
      };
    case "stalled":
      return {
        status: "blocked",
        kind: "stalled",
        summary: oneLine(sections.log, "Inner agent made no progress (no new commit) within the attempt wall-clock."),
        next: "Review the work already pushed (branch/PR) and decide whether to continue, re-scope, or stop.",
      };
    case "budget-exceeded":
      return {
        status: "blocked",
        kind: "budget",
        summary: oneLine(sections.log, "Attempt aborted — per-attempt resource budget exceeded (#908)."),
        next: "Review the salvaged partial work (branch/PR) and decide whether to continue with a larger budget, re-scope, or stop.",
      };
    case "merge-conflict":
      return {
        status: "blocked",
        kind: "merge-conflict",
        summary: oneLine(sections.log, "Worker branch could not be merged cleanly."),
        next: "Resolve the merge conflict or add guidance for the next agent attempt.",
      };
    case "ci-failed":
      return {
        status: "blocked",
        kind: "ci",
        summary: oneLine(sections.log, "A required status check failed on the completed, mergeable PR."),
        next: "Fix the failing required check on the open PR, then merge it (no full agent re-run needed).",
      };
    case "ci-pending":
      return {
        status: "blocked",
        kind: "ci",
        summary: oneLine(sections.log, "Required status checks were still pending on the completed, mergeable PR."),
        next: "Wait for the required checks to go green, then merge the open PR (no full agent re-run needed).",
      };
    case "trunk-diverged":
      return {
        status: "blocked",
        kind: "trunk-diverged",
        summary: oneLine(sections.log, "Local trunk diverged from origin; landing aborted (ADR 0083)."),
        next: "Reconcile the primary checkout's local trunk with origin (no reset/stash/force-push), then requeue.",
      };
    case "sensitive-path":
      return {
        status: "blocked",
        kind: "sensitive-path",
        summary: oneLine(sections.log, "Diff touches a sensitive path (CI workflow, lifecycle script, git hook, or .red/ config)."),
        next: "Review the sensitive change, then requeue if it is safe to land.",
      };
    case "base-stale":
      return {
        status: "blocked",
        kind: "base-stale",
        summary: oneLine(sections.log, "Remote base was unreachable and the local base is stale."),
        next: "Refresh the local base from origin, or restore remote access, then requeue.",
      };
    case "infra":
      return {
        status: "blocked",
        kind: "infra",
        summary: oneLine(sections.log, "Landing infrastructure precondition failed."),
        next: "Fix the landing infrastructure failure, then requeue.",
      };
    case "manual-landing":
      return {
        status: "blocked",
        kind: "manual-landing",
        summary: oneLine(sections.log, "Manual-landing hold: the full pipeline ran and the PR is open, awaiting a human merge."),
        next: "Merge the open PR to land the work (it auto-closes this issue); no full agent re-run is needed.",
      };
    default:
      return null;
  }
}
export const ACTIONABLE_BLOCKER_KINDS = new Set([
  "spec",
  "validation",
  "merge-conflict",
  "ci",
  "stalled",
  "decision",
  "trunk-diverged",
  "sensitive-path",
  "infra",
]);
export function shouldPreserveCurrentBlocker(existing: CurrentBlocker | null, next: CurrentBlocker): boolean {
  if (!existing) return false;
  if (next.kind !== "runner") return false;
  return ACTIONABLE_BLOCKER_KINDS.has(existing.kind);
}
export async function writeCurrentBlockerBestEffort(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  blocker: CurrentBlocker | null,
): Promise<void> {
  if (!blocker || !deps.gh.editBody) return;
  try {
    const existing = parseCurrentBlocker(input.body);
    const next = shouldPreserveCurrentBlocker(existing, blocker) ? existing! : blocker;
    const { body, changed } = applyCurrentBlockerEdit(input.body, next);
    if (!changed) return; // byte-exact no-op: body already reflects the desired blocker state
    await deps.gh.editBody(input.issue, body);
  } catch {
  }
}
export async function crossTerminalBarrier(deps: ProcessIssueDeps, branch: string): Promise<TerminalReceipt> {
  if (deps.terminalExitBarrier) {
    try {
      return await deps.terminalExitBarrier(branch);
    } catch {
    }
  }
  return { branch, head: "", pushedAt: new Date().toISOString(), salvaged: false, salvagedFiles: 0, pushed: false };
}
export function preservedTerminal(
  receipt: TerminalReceipt,
  fields: {
    outcome: ProcessOutcome;
    issue: number;
    branch: string;
    base: string;
    hooksFired: HookName[];
    envelopePosted?: boolean;
    locked?: boolean;
  },
): ProcessIssueResult {
  return {
    ...fields,
    exitReceipt: receipt,
    preserved: true,
    swept: false,
  };
}
export async function terminalFailure(
  c: StageCommon,
  outcome: ProcessOutcome,
  sectionKey: string,
  sections: SectionBodies,
  record: { notes?: string; validationSummary?: string } = {},
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  markTerminalState(deps, outcome);
  const decision = await routeRecovery(deps, input.issue, outcome, recoveryOrdinalFor(input));
  if (decision === "escalate") {
    await writeCurrentBlockerBestEffort(deps, input, blockerForFailure(outcome, sections));
  }
  const posted = await emitFailure(c, envelopeStatusFor(outcome), sectionKey, sections);
  await recordAttemptBestEffort(c, outcome, {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: record.notes,
    validationSummary: record.validationSummary,
  });
  const receipt = await crossTerminalBarrier(deps, c.branch);
  if (receipt.salvagedFiles > 0) {
    deps.appendIterLog(
      `🤖 /afk: exit barrier salvaged ${receipt.salvagedFiles} uncommitted file(s) onto \`${c.branch}\` and pushed to origin (${outcome} terminal; receipt head ${receipt.head || "?"}).`,
    );
  }
  await releaseOwnedClaim(deps, input);
  return preservedTerminal(receipt, {
    outcome,
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
  });
}
export async function emitDone(
  c: StageCommon,
  mergeSha: string,
  durationS: number,
  validationSidecar: string[],
  validationScope?: ValidationScope,
  validationNotice?: string,
): Promise<boolean> {
  const { deps, input } = c;
  const scopeHeader = validationScope ? `${formatValidationScope(validationScope)}\n` : "";
  const validationBody = [validationNotice, `${scopeHeader}${validationSidecar.join("\n")}`]
    .filter((part) => part && part.trim().length > 0)
    .join("\n");
  const result = await emitEnvelope(deps.envelope, {
    status: "done",
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: c.branch,
    attempt: input.attempt,
    mergeSha,
    diff: "merged",
    sections: {
      validation: validationBody,
      ...(c.resolvedBase ? { base: formatBaseResolution(c.resolvedBase) } : {}),
    },
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner, merge_sha: mergeSha },
  });
  return result.posted;
}
export async function mergeFailed(c: StageCommon, _reason: string, locked = false): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  deps.recordWorkerEvent?.("worker.blocked", { outcome: "merge-conflict", reason: _reason });
  const decision = await routeRecovery(deps, input.issue, "merge-conflict", recoveryOrdinalFor(input));
  if (decision === "escalate") {
    await writeCurrentBlockerBestEffort(
      deps,
      input,
      blockerForFailure("merge-conflict", { log: _reason || "(no merge log captured)" }),
    );
  }
  const posted = await emitFailure(c, envelopeStatusFor("merge-conflict"), "merge-conflict", {
    log: "(no merge log captured)",
  });
  await recordAttemptBestEffort(c, "merge-conflict", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: _reason,
  });
  const receipt = await crossTerminalBarrier(deps, c.branch);
  await releaseOwnedClaim(deps, input);
  return preservedTerminal(receipt, {
    outcome: "merge-conflict",
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    locked,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
  });
}
export async function ciBlocked(
  c: StageCommon,
  outcome: "ci-failed" | "ci-pending",
  prNumber?: number,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const prRef = prNumber !== undefined ? `PR #${prNumber}` : "the open PR";
  const reason =
    outcome === "ci-failed"
      ? `a required status check FAILED on ${prRef}`
      : `required status checks were still pending on ${prRef} past the CI-wait timeout`;
  await routeRecovery(deps, input.issue, outcome, recoveryOrdinalFor(input));
  await writeCurrentBlockerBestEffort(deps, input, blockerForFailure(outcome, { log: reason }));
  const posted = await emitFailure(c, envelopeStatusFor(outcome), "ci", {
    log:
      `Inner agent completed (DONE, committed) and ${prRef} is MERGEABLE, but ${reason}. ` +
      `The work is NOT lost — drive the open PR to merge once CI is green (no agent re-run needed).`,
  });
  await deps.gh.comment(
    input.issue,
    `🤖 /afk: ${reason}. The implementation is complete and committed on ${prRef} (MERGEABLE — not a merge conflict). ` +
      `Holding for a human / CI-aware finisher to land the existing PR; the inner agent was NOT re-run (#812).`,
  );
  await recordAttemptBestEffort(c, outcome, {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: reason,
  });
  await releaseOwnedClaim(deps, input);
  return {
    outcome,
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
    preserved: true,
    swept: false,
  };
}
export async function prLandingBlocked(
  c: StageCommon,
  outcome: "ci-failed" | "merge-conflict",
  prNumber: number | undefined,
  reason: string,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const prRef = prNumber !== undefined ? `PR #${prNumber}` : "the open PR";
  await routeRecovery(deps, input.issue, outcome, recoveryOrdinalFor(input), { forceDecision: "escalate" });
  await writeCurrentBlockerBestEffort(deps, input, blockerForFailure(outcome, { log: `${prRef}: ${reason}` }));
  const section = outcome === "merge-conflict" ? "merge-conflict" : "ci";
  const posted = await emitFailure(c, envelopeStatusFor(outcome), section, {
    log:
      `Inner agent completed (DONE, committed) and ${prRef} exists, but ${reason}. ` +
      `The work is NOT lost — finish and land the existing PR instead of re-running the agent.`,
  });
  await deps.gh.comment(
    input.issue,
    `🤖 /afk: ${reason} on ${prRef}. Holding for a human / PR finisher to land the existing PR; ` +
      `the inner agent was NOT re-run.`,
  );
  await recordAttemptBestEffort(c, outcome, {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: `${prRef}: ${reason}`,
  });
  await releaseOwnedClaim(deps, input);
  return {
    outcome,
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
    preserved: true,
    swept: false,
  };
}
export async function trunkDivergedBlocked(
  c: StageCommon,
  trunk: string,
  localSha: string,
  originSha: string,
  locked: boolean,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const detail =
    `Landing aborted (ADR 0083): the primary checkout's local \`${trunk}\` (${localSha || "unknown"}) has diverged ` +
    `from \`origin/${trunk}\` (${originSha || "unknown"}) — it carries commits origin does not. The landing will NOT ` +
    `reset, stash, auto-commit, or force-push to repair this; a human must reconcile the local repository state, then ` +
    `requeue the issue. The attempt branch is intact — no work was lost.`;
  await routeRecovery(deps, input.issue, "trunk-diverged", recoveryOrdinalFor(input));
  await writeCurrentBlockerBestEffort(deps, input, blockerForFailure("trunk-diverged", { log: detail }));
  const posted = await emitFailure(c, envelopeStatusFor("trunk-diverged"), "trunk-diverged", { log: detail });
  await deps.gh.comment(input.issue, `🤖 /afk: ${detail}`);
  await recordAttemptBestEffort(c, "trunk-diverged", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: detail,
  });
  await releaseOwnedClaim(deps, input);
  return {
    outcome: "trunk-diverged",
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    locked,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
    preserved: true,
    swept: false,
  };
}
export async function sensitivePathGuarded(
  c: StageCommon,
  hits: Array<{ path: string; reason: string }>,
  locked: boolean,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const hitList = hits.map((h) => `\`${h.path}\` (${h.reason})`).join(", ");
  const detail =
    `Landing blocked: the diff touches sensitive path(s) that require human review before auto-landing — ` +
    `${hitList}. The attempt branch is intact. Requeue after reviewing the change.`;
  await routeRecovery(deps, input.issue, "sensitive-path", recoveryOrdinalFor(input));
  await writeCurrentBlockerBestEffort(deps, input, blockerForFailure("sensitive-path", { log: detail }));
  const posted = await emitFailure(c, envelopeStatusFor("sensitive-path"), "sensitive-path", { log: detail });
  await deps.gh.comment(input.issue, `🤖 /afk: ${detail}`);
  await recordAttemptBestEffort(c, "sensitive-path", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: detail,
  });
  await releaseOwnedClaim(deps, input);
  return {
    outcome: "sensitive-path",
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    locked,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
    preserved: true,
    swept: false,
  };
}
export async function handoffForReview(
  c: StageCommon,
  taskClass: AfkModelTier,
  validationSidecar: string[],
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const reviewLabel = deps.reviewGateLabel ?? LABEL_READY_FOR_REVIEW;
  await pushAttempt(deps.remoteGit, input.repoDir, c.branch, c.branch);
  const opened = await openReviewPr(deps.mergeExec, {
    repo: input.repo,
    branch: c.branch,
    target: c.base,
    n: input.issue,
    title: input.title,
    reviewLabel,
  });
  if (!opened.ok) {
    return await mergeFailed(c, "review-pr-open-failed");
  }
  await emitBackpressureReview(c, opened.prNumber);
  await editLabelsTagged(deps, input.issue, [LABEL_RUNNING], [LABEL_HUMAN], "review-requested");
  await deps.gh.comment(
    input.issue,
    `🤖 /afk: non-mechanical change (\`${taskClass}\`) — opened PR #${opened.prNumber} and applied \`${reviewLabel}\` for a fresh-agent review before merge. Holding the fast-merge per the review gate (ADR 0064 §10).`,
  );
  await recordAttemptBestEffort(c, "review-requested", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    validationSummary: validationSidecar.join("\n"),
    notes: `review-requested: PR #${opened.prNumber} labelled ${reviewLabel}`,
  });
  await releaseOwnedClaim(deps, input);
  return {
    outcome: "review-requested",
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    locked: false,
    hooksFired: c.hooksFired,
    preserved: true,
    swept: false,
  };
}
export async function handoffForManualLanding(
  c: StageCommon,
  base: string,
  validationSidecar: string[],
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  await pushAttempt(deps.remoteGit, input.repoDir, c.branch, c.branch);
  const opened = await openManualLandingPr(deps.mergeExec, {
    repo: input.repo,
    branch: c.branch,
    target: base,
    n: input.issue,
    title: input.title,
  });
  if (!opened.ok) {
    return await mergeFailed(c, "manual-landing-pr-open-failed");
  }
  await emitBackpressureReview(c, opened.prNumber);
  const prRef = opened.prNumber !== undefined ? `PR #${opened.prNumber}` : "the open PR";
  const prUrl = opened.prNumber !== undefined ? `https://github.com/${input.repo}/pull/${opened.prNumber}` : undefined;
  const reason =
    `manual landing (\`landing:manual\`): the full pipeline ran and ${prRef}` +
    ` is open, but the merge is HELD for a human's final merge click`;
  await editLabelsTagged(deps, input.issue, [LABEL_RUNNING], [LABEL_HUMAN], "manual-landing");
  const envelopeLines = [
    `Inner agent completed (DONE, committed) and ${prRef} is open (${prUrl ?? "PR URL unavailable"}).`,
    `Held for MANUAL LANDING (\`landing:manual\`, #1049): a human drives the final merge click; the inner agent was NOT re-run.`,
    `The issue auto-closes on PR merge via \`Closes #${input.issue}\`.`,
  ];
  const posted = await emitFailure(c, envelopeStatusFor("manual-landing"), "manual-landing", {
    notes: envelopeLines.join("\n"),
    validation: validationSidecar.length > 0 ? validationSidecar.join("\n") : undefined,
  });
  await writeCurrentBlockerBestEffort(c.deps, input, blockerForFailure("manual-landing", { log: reason }));
  await deps.gh.comment(
    input.issue,
    `🤖 /afk: ${reason}. ${prUrl ? `${prUrl} — ` : ""}the implementation is complete and committed. ` +
      `Holding for a human to land the existing PR (merge it to auto-close this issue); the inner agent was NOT re-run (#1049).`,
  );
  await recordAttemptBestEffort(c, "manual-landing", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    validationSummary: validationSidecar.join("\n"),
    notes: `manual-landing: ${prRef} held for human merge`,
  });
  await releaseOwnedClaim(deps, input);
  return {
    outcome: "manual-landing",
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
    preserved: true,
    swept: false,
  };
}
export async function runCloseCascade(deps: ProcessIssueDeps, closedIssue: number): Promise<void> {
  try {
    const dependentsRaw = await deps.gh.listByLabel(`req:${closedIssue}`);
    if (dependentsRaw.length === 0) return;
    const closedCache = new Map<number, boolean>([[closedIssue, true]]);
    const resolveClosed = async (n: number): Promise<boolean> => {
      const cached = closedCache.get(n);
      if (cached !== undefined) return cached;
      const closed = await deps.gh.issueClosed(n);
      closedCache.set(n, closed);
      return closed;
    };
    const dependents: DependentIssue[] = [];
    for (const dep of dependentsRaw) {
      const reqIds = parseReqLabels(dep.labels);
      const reqs: { n: number; closed: boolean }[] = [];
      for (const n of reqIds) reqs.push({ n, closed: await resolveClosed(n) });
      dependents.push({ number: dep.number, reqs });
    }
    const plans = planCloseCascade(closedIssue, dependents);
    for (const p of plans) {
      await deps.gh.editLabels(p.number, [LABEL_DEPENDENCY, ...p.reqLabels], [LABEL_READY]);
      const reqs = p.refs.map((ref) => Number(ref.slice(1))).filter((n) => Number.isFinite(n));
      await deps.gh.comment(p.number, await cascadeAuditCommentFor(reqs, deps.gh.issueReference));
    }
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk close-cascade for #${closedIssue} failed (best-effort; boot sweep will retry): ${String(err)}`,
    );
  }
}
const SPEC_LABEL_RE = /^spec:([0-9]+)$/;
const AFK_BRANCH_RE = /^afk\/([A-Za-z0-9._-]+)\/([0-9]+)-/;

/** What the cascade did to one sibling branch after a DONE landing. */
export type CascadeRebaseStatus = "rebased" | "skipped-active" | "failed";

/**
 * Render the cascade outcome for ONE sibling. PURE — no IO.
 *
 * The sibling's branch was moved (or deliberately not moved) by a landing that
 * happened on ANOTHER issue, so the sibling's own issue is where that fact has
 * to show up (ADR 0118): the worker log belongs to the landing worker and is
 * unreachable from the sibling. Each line names the branch, the landed issue,
 * and the exact merge SHA the branch was rebased onto, so the next worker to
 * pick the sibling up can tell a moved base from a stale one.
 */
export function cascadeRebaseComment(input: {
  status: CascadeRebaseStatus;
  branch: string;
  landedIssue: number;
  mergeSha: string;
  workerId?: string;
  warn?: string;
}): string {
  const head = `🤖 /afk cascade-rebase (landing of #${input.landedIssue}):`;
  if (input.status === "skipped-active") {
    return (
      `${head} \`${input.branch}\` was NOT rebased onto \`${input.mergeSha}\` — worker ` +
      `\`${input.workerId ?? "unknown"}\` is still alive on it. It will rebase onto the ` +
      `current base when it lands.`
    );
  }
  if (input.status === "failed") {
    return (
      `${head} \`${input.branch}\` could NOT be rebased onto \`${input.mergeSha}\`` +
      `${input.warn ? `: ${input.warn}` : ""}. The branch still sits on the pre-landing base; ` +
      `expect a rebase or conflict resolution on the next attempt.`
    );
  }
  return `${head} \`${input.branch}\` was rebased onto \`${input.mergeSha}\` and force-pushed.`;
}

export async function runCascadeRebase(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  closedIssue: number,
  trunkTip: string,
  labels: string[],
): Promise<void> {
  if (!deps.cascadeRebase) return;
  if (getConfig(deps.hooks.config, "afk.landing.cascade_rebase") === "false") return;
  try {
    const specNumbers: number[] = [];
    for (const l of labels) {
      const m = SPEC_LABEL_RE.exec(l);
      if (m) specNumbers.push(Number(m[1]));
    }
    if (specNumbers.length === 0) return;
    const siblingNums = new Set<number>();
    for (const spec of specNumbers) {
      const siblings = await deps.gh.listByLabel(`spec:${spec}`);
      for (const s of siblings) {
        if (s.number !== closedIssue) siblingNums.add(s.number);
      }
    }
    if (siblingNums.size === 0) return;
    // Every outcome ALSO lands on the sibling's own issue (ADR 0118). Posting is
    // per-sibling best-effort: a failed comment is logged and the cascade moves
    // on, so one unreachable issue never strands the remaining siblings on a
    // stale base.
    const notifySibling = async (issueNum: number, body: string): Promise<void> => {
      try {
        await deps.gh.comment(issueNum, body);
      } catch (err) {
        deps.appendIterLog(
          `🤖 /afk cascade-rebase: could not comment the outcome on #${issueNum} (best-effort): ${String(err)}`,
        );
      }
    };
    const remoteBranches = await deps.cascadeRebase.listAFKBranches(input.repoDir, input.remote);
    for (const branch of remoteBranches) {
      const m = AFK_BRANCH_RE.exec(branch);
      if (!m) continue;
      const workerId = m[1]!;
      const issueNum = Number(m[2]);
      if (!siblingNums.has(issueNum)) continue;
      if (deps.cascadeRebase.isWorkerLive(workerId)) {
        deps.appendIterLog(
          `🤖 /afk cascade-rebase: skipping ${branch} — worker ${workerId} is alive`,
        );
        await notifySibling(
          issueNum,
          cascadeRebaseComment({
            status: "skipped-active",
            branch,
            landedIssue: closedIssue,
            mergeSha: trunkTip,
            workerId,
          }),
        );
        continue;
      }
      const r = await deps.cascadeRebase.rebaseAndPush(input.repoDir, branch, trunkTip);
      if (r.ok) {
        deps.appendIterLog(`🤖 /afk cascade-rebase: rebased ${branch} onto ${trunkTip}`);
        await notifySibling(
          issueNum,
          cascadeRebaseComment({ status: "rebased", branch, landedIssue: closedIssue, mergeSha: trunkTip }),
        );
      } else {
        deps.appendIterLog(
          `🤖 /afk cascade-rebase warning: ${r.warn ?? `failed to rebase ${branch} onto ${trunkTip}`}`,
        );
        await notifySibling(
          issueNum,
          cascadeRebaseComment({
            status: "failed",
            branch,
            landedIssue: closedIssue,
            mergeSha: trunkTip,
            ...(r.warn ? { warn: r.warn } : {}),
          }),
        );
      }
    }
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk cascade-rebase for #${closedIssue} failed (best-effort): ${String(err)}`,
    );
  }
}
export function claimLost(
  issue: number,
  hooksFired: HookName[],
  deps?: Pick<ProcessIssueDeps, "appendIterLog" | "nowEpoch">,
  decision?: ClaimDecision,
  fallbackReason?: string,
): ProcessIssueResult {
  if (deps) {
    const parts = [`🤖 /afk claim-lost #${issue}`];
    if (decision?.winner) parts.push(`holder=${decision.winner}`);
    if (decision?.winnerClaimId !== undefined) parts.push(`claim_id=${decision.winnerClaimId}`);
    if (decision?.winnerCreatedAt) {
      const createdMs = Date.parse(decision.winnerCreatedAt);
      if (!Number.isNaN(createdMs)) parts.push(`age_s=${Math.max(0, deps.nowEpoch() - Math.floor(createdMs / 1000))}`);
    }
    parts.push(`reason=${decision?.reason ?? fallbackReason ?? "issue no longer claimable"}`);
    deps.appendIterLog(parts.join(" "));
  }
  return { outcome: "claim-lost", issue, hooksFired, preserved: false, swept: false };
}
export async function releaseOwnedClaim(deps: ProcessIssueDeps, input: ProcessIssueInput): Promise<void> {
  if (deps.claimGh) {
    await deps.claimGh.concede(
      input.issue,
      renderClaimComment({ worker: input.claimant ?? input.workerId, runner: input.runner }, "concede"),
    );
  }
  await deps.claimLock.release(input.issue);
}
export async function abortAfterClaim(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  branch: string,
  base: string,
  hooksFired: HookName[],
  _reason: string,
): Promise<ProcessIssueResult> {
  const decision = await routeRecovery(deps, input.issue, "hook-aborted", recoveryOrdinalFor(input));
  if (decision === "retry") {
    await deps.gh.comment(
      input.issue,
      `🤖 /afk aborted before runner invocation (${_reason}). Restored \`${LABEL_READY}\`.`,
    );
  }
  const receipt = await crossTerminalBarrier(deps, branch);
  await releaseOwnedClaim(deps, input);
  return preservedTerminal(receipt, {
    outcome: "hook-aborted",
    issue: input.issue,
    branch,
    base,
    hooksFired,
  });
}
async function exhausted(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  branch: string,
  base: string,
  hooksFired: HookName[],
  runner: Runner,
  both: boolean,
): Promise<ProcessIssueResult> {
  await routeRecovery(deps, input.issue, "exhausted", recoveryOrdinalFor(input));
  await deps.gh.comment(
    input.issue,
    both
      ? `🤖 /afk: both runners exhausted. Iteration preserved at \`${input.attemptDir}\`.`
      : `🤖 /afk: runner \`${runner}\` exhausted; rerun /afk when quota resets, or pass \`--fallback-runner\` to swap to the other runner on exhaustion.`,
  );
  if (deps.historyPath && deps.historyClock) {
    const { historyAppend } = await import("../history.js");
    await historyAppend(deps.historyPath, deps.historyClock, "exhausted", {
      worker: input.workerId,
      issue: input.issue,
      runner,
      reason: both ? "both-runners" : runner,
    });
  }
  await releaseOwnedClaim(deps, input);
  return {
    outcome: "exhausted",
    issue: input.issue,
    branch,
    base,
    hooksFired,
    preserved: true,
    swept: false,
  };
}
export function isRunnerRecoverableOutcome(outcome: AgentOutcome): outcome is "exhausted" | "runner-transient" {
  return outcome === "exhausted" || outcome === "runner-transient";
}
export async function runnerRecoverable(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  branch: string,
  base: string,
  hooksFired: HookName[],
  runner: Runner,
  outcome: "exhausted" | "runner-transient",
  both: boolean,
): Promise<ProcessIssueResult> {
  if (outcome === "exhausted") {
    return exhausted(deps, input, branch, base, hooksFired, runner, both);
  }
  await routeRecovery(deps, input.issue, "runner-transient", recoveryOrdinalFor(input));
  await deps.gh.comment(
    input.issue,
    both
      ? `🤖 /afk: both runner invocations hit a transient runner transport/setup failure. Iteration preserved at \`${input.attemptDir}\`.`
      : `🤖 /afk: runner \`${runner}\` hit a transient transport/setup failure; bounded recovery will retry or page a human when the retry budget is exhausted.`,
  );
  if (deps.historyPath && deps.historyClock) {
    const { historyAppend } = await import("../history.js");
    await historyAppend(deps.historyPath, deps.historyClock, "runner-transient", {
      worker: input.workerId,
      issue: input.issue,
      runner,
      reason: both ? "both-runners" : runner,
    });
  }
  await releaseOwnedClaim(deps, input);
  return {
    outcome: "runner-transient",
    issue: input.issue,
    branch,
    base,
    hooksFired,
    preserved: true,
    swept: false,
  };
}
export function parseHookEnv(context: string): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(context);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const env = (parsed as { env?: unknown }).env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
export function reconcileInputFor(
  input: ProcessIssueInput,
  current: ProcessIssueInput,
  branch: string,
  base: string,
  trunk: string,
  claimLabels: string[],
  runner: Runner,
): ReconcileInput {
  const liveLabels = [
    LABEL_RUNNING,
    ...claimLabels.filter((l) => l !== LABEL_READY && !l.startsWith("blocked:")),
  ];
  return {
    issue: input.issue,
    title: input.title,
    body: input.body,
    labels: liveLabels,
    branch,
    base,
    trunk,
    repo: input.repo,
    repoDir: input.repoDir,
    remote: input.remote,
    workerId: input.workerId,
    attempt: current.attempt,
    attemptDir: input.attemptDir,
    runner,
  };
}
export function hookContext(fields: Record<string, unknown>): string {
  const issue = fields.issue as number | undefined;
  const title = fields.title as string | undefined;
  const out: Record<string, unknown> = {};
  if (issue !== undefined) out.issue = { number: issue, title: title ?? "" };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "issue" || key === "title") continue;
    out[key] = value;
  }
  return JSON.stringify(out);
}
export function postAttemptContext(
  input: ProcessIssueInput,
  workspace: string,
  status: "success" | "fail",
  outcome: string,
): string {
  return JSON.stringify({
    issue: { number: input.issue, title: input.title },
    workspace,
    result: { status, outcome },
    attempt_n: input.attempt,
    iter_log: `${input.attemptDir}/afk.log`,
    state_file: `${input.attemptDir}/afk.state.toon`,
  });
}
export function onErrorContext(input: ProcessIssueInput, workspace: string, errClass: string, attempt: number): string {
  return JSON.stringify({
    issue: { number: input.issue, title: input.title },
    workspace,
    error: { class: errClass, rc: 0 },
    attempt_n: attempt,
  });
}
