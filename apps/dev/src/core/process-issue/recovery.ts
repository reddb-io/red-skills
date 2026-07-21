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
export async function editLabelsTagged(
  deps: ProcessIssueDeps,
  issue: number,
  remove: string[],
  add: string[],
  reason: AttemptOutcome,
): Promise<boolean> {
  const typed = blockedLabelFor(reason);
  if (typed === null) return deps.gh.editLabels(issue, remove, add);
  await deps.gh.ensureLabel(typed);
  return deps.gh.editLabels(issue, remove, [...add, typed]);
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
    return await deps.gh.editLabels(issue, remove, add);
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
    return await deps.gh.editLabels(issue, reconciledRemove, add);
  }
}
export async function routeRecovery(
  deps: ProcessIssueDeps,
  issue: number,
  reason: AttemptOutcome,
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
export function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}
export function appendGoVerifyRetryHandoff(
  handoff: string,
  opts: { gate: "feedback" | "backpressure"; validation: string; retry: number; cap: number },
): string {
  return [
    handoff.replace(/\n+$/, ""),
    "",
    "<go-machine-gate-retry>",
    `The ${opts.gate} machine gate failed after DONE. This is bounded correction retry ${opts.retry}/${opts.cap}.`,
    "Fix the failure on the existing branch, run the relevant gate, commit only the needed changes, then emit the required terminal sentinel.",
    "",
    "<validation-tail>",
    tailLines(opts.validation, 80),
    "</validation-tail>",
    "</go-machine-gate-retry>",
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
