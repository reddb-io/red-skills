import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "../base-resolver.js";
import {
  deleteRemote,
  pushAttempt,
  type GitExec,
} from "../remote-branch.js";
import { buildHandoff, exitProtocolFor, type HandoffComment } from "../handoff.js";
import { assignOutputShaping, type OutputShapingConfig } from "../output-shaping.js";
import { dirname, join } from "node:path";
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
import { runPostWorkerFormat, type PostWorkerFormatExec } from "../post-worker-format.js";
import {
  openReviewPr,
  openManualLandingPr,
  type Exec as MergeExec,
  type ConflictResolver,
  type WaitForReviewInput,
  type CiAwaitInput,
} from "../merge.js";
import { integrateBaseBeforePr, type PrePrIntegrationResult } from "../pre-pr-integration.js";
import type { LandLock } from "../land-lock.js";
import { doLanding } from "../landing.js";
import { reconcile, type ReconcileInput } from "../reconcile.js";
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
import {
  EMPTY_FAILURE_SIGNATURE,
  failureSignature,
  validationFailureMarker,
} from "../failure-signature.js";
import { cascadeAuditCommentFor, parseReqLabels, planCloseCascade, promotionLaneNote, type DependentIssue } from "../boot-sweep.js";
import { isRefused, parkOrHuman, planTransition, transitionLabels } from "../state-transition.js";
import { deriveOutcomeRecord } from "../outcome-record.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import { acquireClaim, renderClaimComment, type ClaimGh, type ClaimReconcileOptions, type ClaimDecision } from "../claim.js";
import { applyCurrentBlockerEdit, makeBlocker, parseCurrentBlocker, type CurrentBlocker } from "../blocker-state.js";
import { detectParkLoop, type ParkLoopVerdict } from "../park-loop.js";
import {
  parseTrustPolicy,
  evaluateClaimTrust,
  resolveActorTrust,
  describeTrustPosture,
  type TrustProvenance,
  type RepoVisibility,
  type ActorTrustSignals,
} from "../trust-gate.js";
import { getConfig, readHitlTypeLabels } from "../config.js";
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
  LABEL_SPEC,
} from "../triage-labels.js";
import {
  IllegalIssueLifecycleTransitionError,
  validateIssueLifecycleTransition,
  type IssueLifecycleEdge,
} from "../issue-lifecycle.js";
import type { ProcessIssueDeps, ProcessIssueInput, ProcessIssueResult, ProcessOutcome, WorkerBaseResolution } from "./types.js";
import { formatBaseResolution, markTerminalState, recoveryOrdinalFor } from "./types.js";
import { recordIssueHeal } from "@reddb-io/red-castle/engine";
import { editIssueLifecycleLabels, routeRecovery } from "./recovery.js";
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
export async function recordOutcomeBestEffort(
  c: StageCommon,
  outcome: ProcessOutcome,
  fields: { durationS?: number } = {},
): Promise<void> {
  const { deps, input } = c;
  if (!deps.recordOutcomeEvent) return;
  try {
    const durationS = fields.durationS;
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
      outcome: deriveOutcomeRecord(outcome),
      cost: { signal: "unknown" },
      context: {
        repository: input.repo,
        issueNumber: input.issue,
        attemptNumber: input.attempt,
        issueType: c.issueType,
        workerId: input.workerId,
        branch: c.branch,
        durationMs:
          durationS !== undefined && Number.isFinite(durationS) && durationS >= 0
            ? Math.round(durationS * 1000)
            : undefined,
        status: String(outcome),
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
  /** When true, emitFailure suppresses the `live branch:` link in the envelope
   * diff section — used for pre-push boot failures where the worker branch was
   * never pushed to origin. */
  noBranchLink?: boolean;
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
    repo: c.noBranchLink ? "" : input.repo,
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
      return makeBlocker({
        kind: "spec",
        summary: oneLine(sections.notes, "Inner agent emitted BLOCKED."),
        next: "Review the blocker envelope and add human guidance.",
      });
    case "feedback-failed":
      return makeBlocker({
        kind: "validation",
        summary: oneLine(sections.validation ?? sections.log, "Validation failed after implementation."),
        next: "Decide whether to fix forward, change scope, or adjust the acceptance criteria.",
      });
    case "no-sentinel":
      return makeBlocker({
        kind: "runner",
        summary: oneLine(sections.log, "Inner agent exited without an AFK completion sentinel."),
        next: "Review the attempt log and decide whether to retry or revise the issue brief.",
      });
    case "host-config":
      return makeBlocker({
        kind: "host-config",
        summary: oneLine(sections.log ?? sections.notes, "Required runner host configuration is unavailable."),
        next: "Install or restore the required shell/workspace on the host, then requeue this issue.",
      });
    case "stalled":
      return makeBlocker({
        kind: "stalled",
        summary: oneLine(sections.log, "Inner agent made no progress (no new commit) within the attempt wall-clock."),
        next: "Review the work already pushed (branch/PR) and decide whether to continue, re-scope, or stop.",
      });
    case "budget-exceeded":
      return makeBlocker({
        kind: "budget",
        summary: oneLine(sections.log, "Attempt aborted — per-attempt resource budget exceeded (#908)."),
        next: "Review the salvaged partial work (branch/PR) and decide whether to continue with a larger budget, re-scope, or stop.",
      });
    case "merge-conflict":
      return makeBlocker({
        kind: "merge-conflict",
        summary: oneLine(sections.log, "Worker branch could not be merged cleanly."),
        next: "Resolve the merge conflict or add guidance for the next agent attempt.",
      });
    case "ci-failed":
      return makeBlocker({
        kind: "ci",
        summary: oneLine(sections.log, "A required status check failed on the completed, mergeable PR."),
        next: "Fix the failing required check on the open PR, then merge it (no full agent re-run needed).",
      });
    case "ci-pending":
      return makeBlocker({
        kind: "ci",
        summary: oneLine(sections.log, "Required status checks were still pending on the completed, mergeable PR."),
        next: "Wait for the required checks to go green, then merge the open PR (no full agent re-run needed).",
      });
    case "trunk-diverged":
      return makeBlocker({
        kind: "trunk-diverged",
        summary: oneLine(sections.log, "Local trunk diverged from origin; landing aborted (ADR 0083)."),
        next: "Reconcile the primary checkout's local trunk with origin (no reset/stash/force-push), then requeue.",
      });
    case "base-stale":
      return makeBlocker({
        kind: "base-stale",
        summary: oneLine(sections.log, "Remote base was unreachable and the local base is stale."),
        next: "Refresh the local base from origin, or restore remote access, then requeue.",
      });
    case "infra":
      return makeBlocker({
        kind: "infra",
        summary: oneLine(sections.log, "Landing infrastructure precondition failed."),
        next: "Fix the landing infrastructure failure, then requeue.",
      });
    case "manual-landing":
      return makeBlocker({
        kind: "manual-landing",
        summary: oneLine(sections.log, "Manual-landing hold: the full pipeline ran and the PR is open, awaiting a human merge."),
        next: "Merge the open PR to land the work (it auto-closes this issue); no full agent re-run is needed.",
      });
    default:
      return null;
  }
}
export const ACTIONABLE_BLOCKER_KINDS = new Set([
  "spec",
  "validation",
  "merge-conflict",
  "push-failed",
  // #3377 — the divergence half of the old one-size push park. Actionable for
  // the same reason `push-failed` is: it names a cause a later `runner` blocker
  // must not overwrite.
  "push-rejected",
  "ci",
  "stalled",
  "decision",
  "trunk-diverged",
  "infra",
  "host-config",
]);
/**
 * The re-park loop verdict for the blocker this terminal is about to write
 * (#3377), read off the issue body's previous park. A terminal with no blocker
 * to write cannot be a repeat of one.
 */
export function parkLoopFor(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  proposed: CurrentBlocker | null,
): ParkLoopVerdict {
  if (!proposed) return { loop: false, note: null };
  return detectParkLoop({
    previous: parseCurrentBlocker(input.body),
    next: proposed,
    nowEpoch: deps.nowEpoch(),
  });
}

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
    const preserved = shouldPreserveCurrentBlocker(existing, blocker) ? existing! : blocker;
    // Every park this Worker WRITES carries the moment it wrote it (#3377). The
    // stamp is what lets the next Worker's detector tell an issue nobody got to
    // from an issue being reborn every few minutes. A preserved earlier blocker
    // keeps its own stamp — it is not a new park.
    const next =
      preserved === blocker && blocker.parkedAtEpoch === undefined
        ? { ...blocker, parkedAtEpoch: deps.nowEpoch() }
        : preserved;
    const { body, changed } = applyCurrentBlockerEdit(input.body, next);
    if (!changed) return; // byte-exact no-op: body already reflects the desired blocker state
    await deps.gh.editBody(input.issue, body);
  } catch {
  }
}
/**
 * Shape a terminal result that PRESERVES the worker branch (never swept). ADR
 * 0103: the terminal carries no exit receipt — whatever the agent committed is
 * already on origin via the continuous-push hook, and the Envelope is the
 * forensic record.
 */
export function preservedTerminal(fields: {
  outcome: ProcessOutcome;
  issue: number;
  branch: string;
  base: string;
  hooksFired: HookName[];
  envelopePosted?: boolean;
  locked?: boolean;
}): ProcessIssueResult {
  return {
    ...fields,
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
  // #3377 — compare this park to the last one BEFORE asking the recovery policy.
  // The policy counts requeue ordinals, which a fresh Worker resets; an issue
  // whose every Worker reproduces one blocker therefore never reaches a cap. An
  // identical signature inside the window closes the automatic route instead.
  const proposedBlocker = blockerForFailure(outcome, sections);
  const loop = parkLoopFor(deps, input, proposedBlocker);
  if (loop.loop && loop.note) {
    deps.appendIterLog(`🤖 /afk #${input.issue}: ${loop.note}`);
    deps.recordWorkerEvent?.("worker.park_loop_detected", {
      issue: input.issue,
      kind: proposedBlocker?.kind ?? "",
      elapsed_s: loop.elapsedS ?? 0,
    });
  }
  const decision = await routeRecovery(
    deps,
    input.issue,
    outcome,
    recoveryOrdinalFor(input),
    loop.loop ? { forceDecision: "escalate" } : {},
  );
  if (decision === "escalate") {
    await writeCurrentBlockerBestEffort(
      deps,
      input,
      loop.loop && loop.note && proposedBlocker
        ? { ...proposedBlocker, loopNote: loop.note, parkedAtEpoch: deps.nowEpoch() }
        : proposedBlocker,
    );
  }
  const posted = await emitFailure(c, envelopeStatusFor(outcome), sectionKey, sections);
  if (record.validationSummary) {
    const signature = failureSignature({ sidecar: record.validationSummary.split("\n") });
    if (signature !== EMPTY_FAILURE_SIGNATURE) {
      // emitFailure wrote the envelope summary marker first. Replace only the
      // reason (writeMarkers leaves envelope.ref untouched) with the compact
      // outcome+signature fact the next Worker can compare deterministically.
      await deps.envelope.writeMarkers({
        failureReason: `${validationFailureMarker(outcome, signature)}\n`,
      });
    }
  }
  await recordOutcomeBestEffort(c, outcome, {
    durationS: deps.nowEpoch() - c.startedEpoch,
  });
  await releaseOwnedClaim(deps, input);
  return preservedTerminal({
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
/**
 * Make work that already reached the remote VISIBLE on the tracker (#2811).
 * A park leaves a labelled issue and an envelope; a branch carrying commits
 * with no pull request leaves nothing anyone browsing the tracker can see, and
 * 624 committed lines were found only by hand-inspecting `git ls-remote` while
 * three workers re-did them. The PR is the visibility surface, so open it —
 * `openManualLandingPr` reuses an existing one, making this idempotent.
 *
 * Best-effort by construction: the park is the caller's outcome and a forge
 * that refuses the PR must not change it. Returns the PR number when the work
 * is now visible.
 */
export async function ensureRemoteWorkVisible(c: StageCommon): Promise<number | undefined> {
  const { deps, input } = c;
  if (!c.branch || c.noBranchLink) return undefined;
  try {
    const ahead = await deps.mergeExec([
      "git",
      "-C",
      input.repoDir,
      "rev-list",
      "--count",
      `origin/${c.base}..origin/${c.branch}`,
    ]);
    // No commits on the remote branch → nothing to make visible. An unreadable
    // count is treated as "nothing", never as a reason to mint an empty PR.
    if (ahead.code !== 0 || !(Number(ahead.stdout.trim() || "0") > 0)) return undefined;
    const opened = await openManualLandingPr(deps.mergeExec, {
      repo: input.repo,
      branch: c.branch,
      target: c.base,
      n: input.issue,
      title: input.title,
    });
    return opened.ok ? opened.prNumber : undefined;
  } catch {
    return undefined;
  }
}

export async function mergeFailed(
  c: StageCommon,
  _reason: string,
  locked = false,
  opts: { ensureVisible?: boolean } = {},
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  deps.recordWorkerEvent?.("worker.blocked", { outcome: "merge-conflict", reason: _reason });
  // Never park committed, pushed work out of sight (#2811). Skipped only where
  // the caller already tried and failed to open the PR itself.
  const visiblePr = opts.ensureVisible === false ? undefined : await ensureRemoteWorkVisible(c);
  const reason =
    visiblePr !== undefined
      ? `${_reason || "(no merge log captured)"} — the worker branch carries commits on origin; PR #${visiblePr} is open on it`
      : _reason;
  // Durable retry accounting (#2576): the worker-local attempt ordinal resets
  // to 1 on every replacement worker (ADR 0103 flat workspaces), so the
  // RED_AFK_RETRY_MERGE cap alone never trips across reclaims — the 2026-07-23
  // incidents looped 100+ identical land-failed cycles. The ADR 0122 heal
  // ledger supplies the per-issue consecutive count that survives replacement.
  let ordinal = recoveryOrdinalFor(input);
  if (deps.healLedger) {
    try {
      const heal = await recordIssueHeal(deps.healLedger, input.issue, deps.nowEpoch() * 1000);
      ordinal = Math.max(ordinal, heal.history.length);
    } catch {
      // best-effort: a ledger fault falls back to worker-local accounting.
    }
  }
  const decision = await routeRecovery(deps, input.issue, "merge-conflict", ordinal);
  if (decision === "escalate") {
    await writeCurrentBlockerBestEffort(
      deps,
      input,
      blockerForFailure("merge-conflict", { log: reason || "(no merge log captured)" }),
    );
  }
  const posted = await emitFailure(c, envelopeStatusFor("merge-conflict"), "merge-conflict", {
    log: reason || "(no merge log captured)",
  });
  await recordOutcomeBestEffort(c, "merge-conflict", {
    durationS: deps.nowEpoch() - c.startedEpoch,
  });
  await releaseOwnedClaim(deps, input);
  return preservedTerminal({
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
  await recordOutcomeBestEffort(c, outcome, {
    durationS: deps.nowEpoch() - c.startedEpoch,
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
  /** Replaces the outcome's default `next:` step. A merge REJECTION routes
   * through the `ci-failed` outcome without a verified failing check, so it must
   * not inherit "fix the failing required check" (#2807). */
  nextStep?: string,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const prRef = prNumber !== undefined ? `PR #${prNumber}` : "the open PR";
  await routeRecovery(deps, input.issue, outcome, recoveryOrdinalFor(input), { forceDecision: "escalate" });
  const blocker = blockerForFailure(outcome, { log: `${prRef}: ${reason}` });
  await writeCurrentBlockerBestEffort(
    deps,
    input,
    blocker && nextStep ? { ...blocker, next: nextStep } : blocker,
  );
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
  await recordOutcomeBestEffort(c, outcome, {
    durationS: deps.nowEpoch() - c.startedEpoch,
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
  await recordOutcomeBestEffort(c, "trunk-diverged", {
    durationS: deps.nowEpoch() - c.startedEpoch,
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
/**
 * Park a terminal handoff through the ADR 0122 transition API (#2663). The
 * `editLabelsTagged` wrapper this replaces wrote the (remove, add) pair by
 * hand; the planner derives it from the labels this site KNOWS are present —
 * `running`, the projection every terminal sheds — and proves the
 * one-state-role invariant BEFORE the tracker call. The delta is unchanged:
 * remove [running], add [ready-for-human] plus the typed `blocked:*` reason
 * when the outcome has one (a handoff like `review-requested` /
 * `manual-landing` has none, so it parks on the plain human gate).
 */
async function parkTerminalHandoff(
  deps: ProcessIssueDeps,
  issue: number,
  outcome: WorkerOutcome,
): Promise<void> {
  const typed = blockedLabelFor(outcome);
  if (typed !== null) await deps.gh.ensureLabel(typed);
  const result = await transitionLabels(
    (remove, add) => deps.gh.editLabels(issue, remove, add),
    [LABEL_RUNNING],
    parkOrHuman(typed),
  );
  if (!result.applied) {
    deps.appendIterLog(`🤖 terminal park for #${issue} refused by the state planner: ${result.reason}`);
  }
}
/**
 * Give the branch the current base BEFORE its PR is opened (#2936).
 *
 * The PR used to be born on whatever base the Worker saw at boot, so a base that
 * moved during the run first showed up at landing time — with the Worker dead
 * and a human holding a `dirty` PR. The integration runs in an ISOLATED worktree
 * provisioned from the freshly-fetched `origin/<branch>` (never the primary
 * checkout, never the local ref), immediately after the branch is pushed.
 *
 * Absent worktree ports, or a worktree that fails to materialise, SKIP: this is
 * an earlier barrier, not a replacement for the landing's `preMergeRebase`, so a
 * provisioning fault must not turn a completed run into a refusal.
 */
async function integrateBaseBeforeOpeningPr(c: StageCommon, base: string): Promise<PrePrIntegrationResult> {
  const { deps, input } = c;
  const make = deps.makeRebaseWorktree;
  if (!make) return { ok: true, action: "skipped" };
  const dir = await make(c.branch);
  if (dir === null) return { ok: true, action: "skipped" };
  try {
    return await integrateBaseBeforePr(deps.mergeExec, {
      repo: dir,
      remote: input.remote,
      base,
      branch: c.branch,
    });
  } finally {
    await deps.removeRebaseWorktree?.(dir);
  }
}

/**
 * Park a pre-PR integration refusal, or let the PR open anyway.
 *
 * Only a `conflict` is a statement about the branch, so only a conflict spends
 * `blocked:merge-conflict` — with the conflicting paths named, while a retry can
 * still resolve them. A failed fetch or a failed push is landing infrastructure
 * on a branch that never conflicted: it is logged and the PR opens, because the
 * landing barrier still stands behind it.
 */
async function parkPrePrIntegrationRefusal(
  c: StageCommon,
  integrated: PrePrIntegrationResult,
): Promise<ProcessIssueResult | undefined> {
  if (integrated.ok) return undefined;
  const detail = integrated.message ?? "the base could not be integrated before the pull request was opened";
  if (integrated.reason !== "conflict") {
    c.deps.appendIterLog(`🤖 pre-PR base integration for #${c.input.issue} did not run to completion: ${detail}`);
    return undefined;
  }
  return await mergeFailed(
    c,
    `${detail} — reported BEFORE the pull request was opened, while the branch can still be corrected (#2936)`,
  );
}

export async function handoffForReview(
  c: StageCommon,
  taskClass: AfkModelTier,
  validationSidecar: string[],
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const reviewLabel = deps.reviewGateLabel ?? LABEL_READY_FOR_REVIEW;
  await pushAttempt(deps.remoteGit, input.repoDir, c.branch, c.branch);
  const parked = await parkPrePrIntegrationRefusal(c, await integrateBaseBeforeOpeningPr(c, c.base));
  if (parked) return parked;
  const opened = await openReviewPr(deps.mergeExec, {
    repo: input.repo,
    branch: c.branch,
    target: c.base,
    n: input.issue,
    title: input.title,
    reviewLabel,
  });
  if (!opened.ok) {
    return await mergeFailed(c, "review-pr-open-failed", false, { ensureVisible: false });
  }
  await emitBackpressureReview(c, opened.prNumber);
  await parkTerminalHandoff(deps, input.issue, "review-requested");
  await deps.gh.comment(
    input.issue,
    `🤖 /afk: non-mechanical change (\`${taskClass}\`) — opened PR #${opened.prNumber} and applied \`${reviewLabel}\` for a fresh-agent review before merge. Holding the fast-merge per the review gate (ADR 0064 §10).`,
  );
  await recordOutcomeBestEffort(c, "review-requested", {
    durationS: deps.nowEpoch() - c.startedEpoch,
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
  const parked = await parkPrePrIntegrationRefusal(c, await integrateBaseBeforeOpeningPr(c, base));
  if (parked) return parked;
  const opened = await openManualLandingPr(deps.mergeExec, {
    repo: input.repo,
    branch: c.branch,
    target: base,
    n: input.issue,
    title: input.title,
  });
  if (!opened.ok) {
    return await mergeFailed(c, "manual-landing-pr-open-failed", false, { ensureVisible: false });
  }
  await emitBackpressureReview(c, opened.prNumber);
  const prRef = opened.prNumber !== undefined ? `PR #${opened.prNumber}` : "the open PR";
  const prUrl = opened.prNumber !== undefined ? `https://github.com/${input.repo}/pull/${opened.prNumber}` : undefined;
  const reason =
    `manual landing (\`landing:manual\`): the full pipeline ran and ${prRef}` +
    ` is open, but the merge is HELD for a human's final merge click`;
  await parkTerminalHandoff(deps, input.issue, "manual-landing");
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
  await recordOutcomeBestEffort(c, "manual-landing", {
    durationS: deps.nowEpoch() - c.startedEpoch,
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
    const labelsByNumber = new Map(dependentsRaw.map((dep) => [dep.number, dep.labels]));
    for (const dep of dependents) dep.labels = labelsByNumber.get(dep.number);
    // A dependent carrying a type this repo declares HUMAN-ONLY parks for its
    // human instead of joining the autonomous queue (#2966).
    const hitlTypes = readHitlTypeLabels(deps.hooks.config);
    const plans = planCloseCascade(closedIssue, dependents, hitlTypes);
    for (const p of plans) {
      // Promote through the ADR 0122 transition API (#2528): one atomic edit
      // that consumes every req:* edge and provably leaves exactly one state
      // role, so a cascade can never stack ready-for-agent onto a park.
      const current = labelsByNumber.get(p.number);
      const plan = current ? planTransition(current, { kind: "promote" }, hitlTypes) : undefined;
      if (plan && !isRefused(plan)) {
        await deps.gh.editLabels(p.number, [...plan.remove], [...plan.add]);
      } else {
        if (plan && isRefused(plan)) {
          deps.appendIterLog(`🤖 close-cascade promote refused for #${p.number}: ${plan.reason}`);
          continue;
        }
        await deps.gh.editLabels(
          p.number,
          [LABEL_DEPENDENCY, ...p.reqLabels],
          [p.lane === "human" ? LABEL_HUMAN : LABEL_READY],
        );
      }
      const reqs = p.refs.map((ref) => Number(ref.slice(1))).filter((n) => Number.isFinite(n));
      await deps.gh.comment(
        p.number,
        (await cascadeAuditCommentFor(reqs, deps.gh.issueReference)) +
          promotionLaneNote(p.lane, p.hitlTypes, hitlTypes),
      );
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
/** Everything known about why this worker walked away from the issue. The
 * console line, the iteration log line and the durable history record are all
 * rendered from ONE account, so no surface can carry less than the others. */
export interface ClaimLostAccount {
  /** The bare cause — what an operator asks first. Never empty. */
  reason: string;
  /** The cause plus the arbitration qualifiers (`holder`, `claim_id`, `age_s`)
   * that were known, as one line. */
  detail: string;
}

export function claimLostAccount(
  nowEpoch: () => number,
  decision?: ClaimDecision,
  fallbackReason?: string,
): ClaimLostAccount {
  const reason = decision?.reason ?? fallbackReason ?? "issue no longer claimable";
  const parts: string[] = [];
  if (decision?.winner) parts.push(`holder=${decision.winner}`);
  if (decision?.winnerClaimId !== undefined) parts.push(`claim_id=${decision.winnerClaimId}`);
  if (decision?.winnerCreatedAt) {
    const createdMs = Date.parse(decision.winnerCreatedAt);
    if (!Number.isNaN(createdMs)) parts.push(`age_s=${Math.max(0, nowEpoch() - Math.floor(createdMs / 1000))}`);
  }
  parts.push(`reason=${reason}`);
  return { reason, detail: parts.join(" ") };
}

/**
 * The abandoned ending — and the ONE outcome whose whole diagnostic value is its
 * `reason` (#3156).
 *
 * **The account goes to a lane the sweep does not delete.** `claim-lost` returns
 * `preserved: false`, so the per-worker workspace — and the iteration log inside
 * it — is removed the moment this returns (`sweepDiscardsWorkspace`). Writing the
 * only explanation there is how eight consecutive claim-lost deaths retained zero
 * causes. The iteration log still gets the line for a live tail; the durable
 * `.red/state/castle/history.toonl` record is what an operator reads afterwards,
 * and the `reason` rides back on the result for the console.
 */
export async function claimLost(
  issue: number,
  hooksFired: HookName[],
  deps?: Pick<ProcessIssueDeps, "appendIterLog" | "nowEpoch" | "historyPath" | "historyClock">,
  decision?: ClaimDecision,
  fallbackReason?: string,
  who?: { workerId?: string; runner?: Runner },
): Promise<ProcessIssueResult> {
  const account = claimLostAccount(deps?.nowEpoch ?? (() => 0), decision, fallbackReason);
  if (deps) {
    deps.appendIterLog(`🤖 /afk claim-lost #${issue} ${account.detail}`);
    if (deps.historyPath && deps.historyClock) {
      const { historyAppend } = await import("../history.js");
      // Best-effort: a ledger that cannot be written must never turn an orderly
      // withdrawal into a throw. The console still carries the reason.
      await historyAppend(deps.historyPath, deps.historyClock, "claim-lost", {
        ...(who?.workerId ? { worker: who.workerId } : {}),
        issue,
        ...(who?.runner ? { runner: who.runner } : {}),
        reason: account.detail,
      }).catch(() => {});
    }
  }
  return {
    outcome: "claim-lost",
    issue,
    hooksFired,
    preserved: false,
    swept: false,
    reason: account.reason,
  };
}
export async function releaseOwnedClaim(deps: ProcessIssueDeps, input: ProcessIssueInput): Promise<void> {
  if (deps.claimGh) {
    await deps.claimGh.concede(
      input.issue,
      renderClaimComment({ worker: input.claimant ?? input.workerId, runner: input.runner }, "concede", "released"),
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
  await releaseOwnedClaim(deps, input);
  return preservedTerminal({
    outcome: "hook-aborted",
    issue: input.issue,
    branch,
    base,
    hooksFired,
  });
}
/** Land-lock wait timeout (#2596): back off to ready-for-agent instead of
 * parking to ready-for-human + blocked:infra. The branch name is carried in the
 * comment so the next attempt can adopt it without re-running the full agent. */
export async function landLockBackoff(c: StageCommon): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  await editIssueLifecycleLabels(deps, input.issue, [LABEL_RUNNING], [LABEL_RUNNING], [LABEL_READY], "retry");
  await deps.gh.comment(
    input.issue,
    `🤖 /afk: land-lock wait timeout — backed off to \`ready-for-agent\` (branch: \`${c.branch}\`). The next attempt can adopt this branch.`,
  );
  await releaseOwnedClaim(deps, input);
  return preservedTerminal({
    outcome: "infra",
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    hooksFired: c.hooksFired,
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
    iter_log: join(dirname(input.attemptDir), "worker.log.toonl"),
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
