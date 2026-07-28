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
import { parkOrHuman, transitionLabels, type StateTransition } from "../state-transition.js";
import {
  envelopeStatusFor,
  type WorkerOutcome,
} from "../worker-outcome.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "../hook-config.js";
import { formatStartedMarker } from "../heartbeat.js";
import { cascadeAuditCommentFor, parseReqLabels, planCloseCascade, type DependentIssue } from "../boot-sweep.js";
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
import {
  STALE_BASE_DRIFT_CORRECTIONS_ENV,
  resolveStaleBaseDriftCorrections,
  staleBaseDriftBlock,
  type StaleBaseDriftNote,
} from "../stale-base-drift.js";
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
import { formatSandboxImageBuildCommand } from "../execution/sandbox-image.js";
import type {
  ContainerSandboxMode,
  ProcessIssueDeps,
  ProcessIssueInput,
  ProcessIssueResult,
  ProcessOutcome,
} from "./types.js";
export function blockedLabelsIn(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith("blocked:"));
}
function stripScoutDoneSignal(text: string): string {
  const escaped = DONE_SIGNAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\s*${escaped}\\s*$`), "").trim();
}
export function scoutReportFrom(chunks: readonly string[], stdout: string | undefined): string {
  const captured = chunks.join("").trim() || (stdout ?? "").trim();
  const report = stripScoutDoneSignal(captured);
  return report || "_Scout completed without output. Check the attempt log for details._";
}
export function scoutCapturedDone(run: RunAgentResult, chunks: readonly string[]): boolean {
  if (run.completionSignal === DONE_SIGNAL) return true;
  const captured = chunks.join("").trim() || (run.stdout ?? "").trim();
  return captured.length > 0 && stripScoutDoneSignal(captured) !== captured;
}
export const MECHANICAL_BLOCKER_KINDS = new Set(["stalled", "crashed", "merge-conflict"]);
/**
 * The STATE TRANSITION a lifecycle edge's `add` set expresses, or null when the
 * edge is not a state-role move at all (#2663). `claim` adds only `running` —
 * a PROJECTION of an active claim, not a state role — so it keeps the raw edit;
 * everything else lands on exactly one role and goes through the planner.
 */
export function lifecycleTransitionFor(add: readonly string[]): StateTransition | null {
  if (add.includes(LABEL_READY)) return { kind: "queue" };
  if (add.includes(LABEL_HUMAN)) return parkOrHuman(add.find((l) => l.startsWith("blocked:")) ?? null);
  return null;
}

/**
 * Apply a lifecycle label edit through the ADR 0122 transition API (#2663).
 * The planner is fed the labels the CALL SITE declares present — its own
 * remove set — so the emitted delta is exactly the historical one, with the
 * one-state-role invariant now proven before the tracker call instead of
 * trusted. A refusal performs NO edit: the request itself is malformed.
 */
async function applyLifecycleLabelEdit(
  deps: ProcessIssueDeps,
  issue: number,
  remove: string[],
  add: string[],
): Promise<boolean> {
  const transition = lifecycleTransitionFor(add);
  // Claim machinery (ready → running) is not a state transition — the planner
  // would (correctly) refuse a target that leaves zero state roles.
  if (transition === null) return deps.gh.editLabels(issue, remove, add);
  const typed = add.find((l) => l.startsWith("blocked:"));
  if (typed !== undefined) await deps.gh.ensureLabel(typed);
  const result = await transitionLabels(
    (r, a) => deps.gh.editLabels(issue, r, a),
    remove,
    transition,
  );
  if (result.applied) return result.ok;
  deps.appendIterLog(
    `warn: lifecycle transition for #${issue} refused by the state planner (${result.reason}); labels left untouched.`,
  );
  return false;
}

export async function editIssueLifecycleLabels(
  deps: ProcessIssueDeps,
  issue: number,
  fromLabels: readonly string[],
  remove: string[],
  add: string[],
  edge: IssueLifecycleEdge,
): Promise<boolean> {
  try {
    validateIssueLifecycleTransition({ edge, fromLabels, removeLabels: remove, addLabels: add });
    return await applyLifecycleLabelEdit(deps, issue, remove, add);
  } catch (err) {
    if (!(err instanceof IllegalIssueLifecycleTransitionError)) throw err;
    const shed = blockedLabelsIn([...fromLabels]).filter((l) => !add.includes(l));
    const reconciledRemove = [...new Set([...remove, ...shed])];
    try {
      validateIssueLifecycleTransition({ edge, fromLabels, removeLabels: reconciledRemove, addLabels: add });
    } catch (reErr) {
      const reason = reErr instanceof Error ? reErr.message : String(reErr);
      deps.appendIterLog(
        `warn: lifecycle transition "${edge}" for #${issue} still malformed after reconcile (${reason}); applying best-effort park.`,
      );
    }
    return await applyLifecycleLabelEdit(deps, issue, reconciledRemove, add);
  }
}
export async function routeRecovery(
  deps: ProcessIssueDeps,
  issue: number,
  reason: WorkerOutcome,
  attemptN: number,
  opts: { forceDecision?: "retry" | "escalate" } = {},
): Promise<"retry" | "escalate"> {
  const disp = dispose(reason, attemptN, deps.recoveryEnv ?? {}, { stalledRecoverable: false });
  let decision = opts.forceDecision ?? disp.decision;
  if (!opts.forceDecision) {
    const recResult = await fireRecoveryHook(
      deps,
      "on_recovery_decision",
      JSON.stringify({ issue: { number: issue, title: "" }, decision, reason, attempt_n: attemptN }),
    );
    const override = parseRecoveryDecision(recResult.context);
    if (override !== null) decision = override;
  }
  if (decision === "escalate") {
    if (disp.typedLabel !== null) await deps.gh.ensureLabel(disp.typedLabel);
    const addLabels = disp.typedLabel !== null ? [LABEL_HUMAN, disp.typedLabel] : [LABEL_HUMAN];
    await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], addLabels, "human-blocked");
    if (decision === disp.decision && disp.escalationComment !== null) {
      await deps.gh.comment(issue, disp.escalationComment);
    }
    await fireRecoveryHook(
      deps,
      "on_blocked",
      JSON.stringify({
        issue: { number: issue, title: "" },
        blocked_label: disp.typedLabel ?? "",
        reason,
        attempt_n: attemptN,
      }),
    );
    if (deps.gh.renderDecisionCard) {
      try {
        await deps.gh.renderDecisionCard(issue);
      } catch {
      }
    }
  } else {
    await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], [LABEL_READY], "retry");
  }
  return decision;
}
export async function fireRecoveryHook(
  deps: ProcessIssueDeps,
  name: HookName,
  context: string,
): Promise<{ context: string; aborted: boolean }> {
  try {
    const resolved = resolveHooks(deps.hooks.config, deps.hooks.resolveOptions);
    return await dispatchHooks(name, resolved[name], context, deps.hooks.exec, {
      env: deps.hooks.env ?? {},
      log: (line) => deps.appendIterLog(line),
    });
  } catch {
    return { context, aborted: false };
  }
}
export function parseRecoveryDecision(contextJson: string): "retry" | "escalate" | null {
  try {
    const parsed: unknown = JSON.parse(contextJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const decision = (parsed as Record<string, unknown>).decision;
    return decision === "retry" || decision === "escalate" ? decision : null;
  } catch {
    return null;
  }
}
export function parseFeedbackClass(contextJson: string): "infra" | "semantic" | null {
  try {
    const parsed: unknown = JSON.parse(contextJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const cls = (parsed as Record<string, unknown>).class;
    return cls === "infra" || cls === "semantic" ? cls : null;
  } catch {
    return null;
  }
}
export function resolveGoVerifyRetries(deps: ProcessIssueDeps): number {
  const raw = deps.recoveryEnv?.RED_GO_VERIFY_RETRIES;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  if (deps.goVerifyRetries !== undefined && Number.isInteger(deps.goVerifyRetries) && deps.goVerifyRetries >= 0) {
    return deps.goVerifyRetries;
  }
  return DEFAULT_GO_VERIFY_RETRIES;
}
/** How many FREE (budget-exempt) stale-base correction cycles this attempt
 * chain may spend (#2711). Lane-agnostic: a base that moved under the run is
 * not the branch's fault in `/go` or in `/afk`. */
export function resolveStaleBaseDriftCap(deps: ProcessIssueDeps): number {
  return resolveStaleBaseDriftCorrections(deps.recoveryEnv?.[STALE_BASE_DRIFT_CORRECTIONS_ENV]);
}
export const DEFAULT_STALL_CONVERGENCE_BUDGET = 0;
export function resolveStallConvergenceBudget(deps: ProcessIssueDeps): number {
  const raw = deps.recoveryEnv?.RED_AFK_STALL_CONVERGENCE_BUDGET;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  if (
    deps.stallConvergenceBudget !== undefined &&
    Number.isInteger(deps.stallConvergenceBudget) &&
    deps.stallConvergenceBudget >= 0
  ) {
    return deps.stallConvergenceBudget;
  }
  return DEFAULT_STALL_CONVERGENCE_BUDGET;
}
/** One post-DONE gate correction as the handoff builders see it. `drift` is
 * present only when the cycle was attributed to stale-base drift (#2711), in
 * which case it was FREE and the agent must merge the base rather than hunt for
 * a defect in work that already validated. */
export interface GateCorrectionHandoffOpts {
  gate: "feedback" | "backpressure";
  validation: string;
  retry: number;
  cap: number;
  drift?: StaleBaseDriftNote;
}

/** The correction preamble — either the historical bounded-retry line, or the
 * drift line that says plainly the budget was not touched. */
function correctionPreamble(opts: GateCorrectionHandoffOpts): string[] {
  if (opts.drift) {
    return [
      `The ${opts.gate} machine gate failed after DONE, but the BASE moved under this run — this correction is FREE.`,
      "Merge the base, regenerate anything the base's move invalidated, commit, then emit the required terminal sentinel.",
    ];
  }
  return [
    `The ${opts.gate} machine gate failed after DONE. This is bounded correction retry ${opts.retry}/${opts.cap}.`,
    "Fix the failure on the existing branch, run the relevant gate, commit only the needed changes, then emit the required terminal sentinel.",
  ];
}

export function appendAfkGateCorrectionHandoff(
  handoff: string,
  opts: GateCorrectionHandoffOpts,
): string {
  return [
    handoff.replace(/\n+$/, ""),
    "",
    "<afk-gate-correction>",
    ...correctionPreamble(opts),
    ...(opts.drift ? ["", ...staleBaseDriftBlock(opts.drift)] : []),
    "",
    "<validation-tail>",
    tailLines(opts.validation, 80),
    "</validation-tail>",
    "</afk-gate-correction>",
    "",
  ].join("\n");
}
export function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}
export function appendGoVerifyRetryHandoff(
  handoff: string,
  opts: GateCorrectionHandoffOpts,
): string {
  return [
    handoff.replace(/\n+$/, ""),
    "",
    "<go-machine-gate-retry>",
    ...correctionPreamble(opts),
    ...(opts.drift ? ["", ...staleBaseDriftBlock(opts.drift)] : []),
    "",
    "<validation-tail>",
    tailLines(opts.validation, 80),
    "</validation-tail>",
    "</go-machine-gate-retry>",
    "",
  ].join("\n");
}
/** One tier-escalation Re-seed as the handoff builder sees it (ADR 0129). The
 * round buys a HIGHER model tier rather than another attempt at the tier that
 * just failed, so the block says which tier is now running and why. */
export interface TierEscalationHandoffOpts {
  from: string;
  to: string;
  validation: string;
  retry: number;
  cap: number;
}

export function appendTierEscalationHandoff(
  handoff: string,
  opts: TierEscalationHandoffOpts,
): string {
  return [
    handoff.replace(/\n+$/, ""),
    "",
    "<tier-escalation>",
    `The feedback machine gate failed on the \`${opts.from}\` tier. This Re-seed re-instructs you on the ` +
      `\`${opts.to}\` tier (${opts.retry}/${opts.cap}) rather than spending another round at the tier that just failed.`,
    "Fix the failure on the existing branch, run the relevant gate, commit only the needed changes, then emit the required terminal sentinel.",
    "",
    "<validation-tail>",
    tailLines(opts.validation, 80),
    "</validation-tail>",
    "</tier-escalation>",
    "",
  ].join("\n");
}
export const NON_SOURCE_EXTENSIONS = new Set([
  ".adoc",
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".md",
  ".mdx",
  ".pdf",
  ".png",
  ".rst",
  ".svg",
  ".txt",
  ".webp",
]);
export function pathExtension(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  const idx = leaf.lastIndexOf(".");
  return idx > 0 ? leaf.slice(idx).toLowerCase() : "";
}
export function hasLikelySourceChanges(paths: readonly string[]): boolean {
  return paths.some((path) => !NON_SOURCE_EXTENSIONS.has(pathExtension(path)));
}
export function formatNoSourceChangeWarning(paths: readonly string[]): string {
  const sample = paths.slice(0, 8).map((path) => `\`${path}\``).join(", ");
  const suffix = paths.length > 8 ? `, and ${paths.length - 8} more` : "";
  return `DONE diff warning: attempt changed no source files; changed files: ${sample}${suffix}.`;
}
export interface UntrustedSandboxDecision {
  sandboxMode: SandboxMode;
  authorTrusted: boolean;
  refused: boolean;
  reason?: string;
}
export async function resolveUntrustedAuthorSandbox(
  deps: ProcessIssueDeps,
  trustPolicy: ReturnType<typeof parseTrustPolicy>,
  provenance: TrustProvenance | undefined,
): Promise<UntrustedSandboxDecision> {
  const configured = deps.sandboxMode ?? "none";
  if (!provenance?.authorSourceTrust) {
    return { sandboxMode: configured, authorTrusted: true, refused: false };
  }
  let authorTrusted = provenance.authorSourceTrust === "trusted";
  if (!authorTrusted && deps.gh.actorTrustSignals) {
    const verdict = await resolveActorTrust(trustPolicy, provenance.author, (actor) => deps.gh.actorTrustSignals!(actor));
    authorTrusted = verdict.executable && verdict.basis !== "permissive-default";
  }
  if (authorTrusted) return { sandboxMode: configured, authorTrusted: true, refused: false };
  const candidates: ContainerSandboxMode[] =
    configured === "docker" ? ["docker", "podman"] : configured === "podman" ? ["podman", "docker"] : ["docker", "podman"];
  const who = provenance.author ? `'${provenance.author}'` : "(unknown)";
  // Issue #2340: a present backend whose IMAGE is missing used to crash the
  // attempt a minute in ("Image '…' not found locally"), which reads as
  // no-sentinel and burns the retry budget. Probe the image here, prefer a
  // backend that already has it, and remember the first backend that was
  // present-but-imageless so the refusal can name the exact build command.
  let imagelessMode: ContainerSandboxMode | undefined;
  for (const mode of candidates) {
    if (deps.sandboxAvailable && !(await deps.sandboxAvailable(mode))) continue;
    if (deps.sandboxImageAvailable && deps.sandboxImage) {
      if (!(await deps.sandboxImageAvailable(mode, deps.sandboxImage))) {
        imagelessMode ??= mode;
        continue;
      }
    }
    return { sandboxMode: mode, authorTrusted: false, refused: false };
  }
  if (imagelessMode && deps.sandboxImage) {
    return {
      sandboxMode: configured,
      authorTrusted: false,
      refused: true,
      reason:
        `untrusted issue author ${who} requires container isolation, but the sandbox image ` +
        `'${deps.sandboxImage}' is missing for ${imagelessMode} — build it first with: ` +
        formatSandboxImageBuildCommand(imagelessMode, deps.sandboxImage),
    };
  }
  return {
    sandboxMode: configured,
    authorTrusted: false,
    refused: true,
    reason:
      `untrusted issue author ${who} requires container isolation, ` +
      "but no docker/podman sandbox backend is available",
  };
}
export async function refuseNoSandboxForUntrustedAuthor(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  hooksFired: HookName[],
  reason: string,
): Promise<ProcessIssueResult> {
  await editIssueLifecycleLabels(deps, input.issue, [LABEL_READY], [LABEL_READY], [LABEL_HUMAN], "preflight-blocked");
  await deps.gh.comment(
    input.issue,
    `🤖 /afk preflight stopped: ${reason}. Autonomous execution refused; maintainer intervention required.`,
  );
  if (deps.gh.renderDecisionCard) {
    try {
      await deps.gh.renderDecisionCard(input.issue);
    } catch {
    }
  }
  await releaseOwnedClaim(deps, input);
  return {
    outcome: "blocked",
    issue: input.issue,
    hooksFired,
    preserved: false,
    swept: false,
  };
}
async function releaseOwnedClaim(deps: ProcessIssueDeps, input: ProcessIssueInput): Promise<void> {
  if (deps.claimGh) {
    await deps.claimGh.concede(
      input.issue,
      renderClaimComment({ worker: input.claimant ?? input.workerId, runner: input.runner }, "concede", "released"),
    );
  }
  await deps.claimLock.release(input.issue);
}
