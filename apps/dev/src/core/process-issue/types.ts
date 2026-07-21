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
import type {
  AdversarialReviewConfig,
  AdversarialReviewFindings,
  AdversarialReviewContext,
} from "../adversarial-review.js";
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
export type ContainerSandboxMode = Exclude<SandboxMode, "none">;
export interface ProcessGh {
  viewLabels(issue: number): Promise<string[]>;
  editLabels(issue: number, remove: string[], add: string[]): Promise<boolean>;
  ensureLabel(name: string): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  editBody?(issue: number, body: string): Promise<boolean>;
  close(issue: number): Promise<void>;
  listByLabel(label: string): Promise<{ number: number; labels: string[] }[]>;
  issueClosed(n: number): Promise<boolean>;
  issueReference?(issue: number): Promise<{ number: number; title?: string; url?: string } | undefined>;
  issueTrust?(issue: number): Promise<TrustProvenance>;
  repoVisibility?(): Promise<RepoVisibility | undefined>;
  actorTrustSignals?(actor: string): Promise<ActorTrustSignals>;
  renderDecisionCard?(issue: number): Promise<void>;
}
export interface ProcessClaimLock {
  acquire(issue: number): Promise<boolean>;
  release(issue: number): Promise<void>;
}
export interface ProcessFs {
  ensureAttemptDir(dir: string): Promise<void>;
  writeHandoff(path: string, content: string): Promise<void>;
  writeValidationSidecar?(path: string, lines: string[]): Promise<void>;
  completionSweep(issue: number): Promise<string[]>;
}
export interface ProcessGit {
  headShortSha(): Promise<string>;
  deleteLocalBranch(branch: string): Promise<{ ok: true } | { ok: false; error: string } | void>;
  fetchBase?(base: string): Promise<void>;
  resolveFreshBase?(input: { base: string; remote: string }): Promise<WorkerBaseResolution>;
  prepareFreshWorkerBranch?(input: { branch: string; baseRef: string; force: boolean }): Promise<boolean | void>;
}
export interface WorkerBaseResolution {
  ok: boolean;
  base: string;
  baseRef: string;
  sha: string;
  source: "remote" | "local" | "mirror";
  remoteReachable: boolean;
  localSha?: string;
  localAhead?: number;
  localBehind?: number;
  reason?: "base-stale";
  message?: string;
}
export interface ProcessLookups {
  base: ResolveBaseDeps;
  isLocked(): Promise<boolean>;
  comments(issue: number): Promise<HandoffComment[]>;
  issueUrl(issue: number): Promise<string>;
  priorAttemptContext(issue: number): Promise<string | undefined>;
  changedFiles(branch: string, base: string): Promise<string[]>;
  diffstat(branch: string, base: string): Promise<string>;
  branchPresent?(branch: string): Promise<boolean>;
  branchMerged?(branch: string, base: string): Promise<boolean>;
}
export function remoteTrackingBaseRef(remote: string, base: string): string {
  if (/^[0-9a-f]{7,40}$/i.test(base) || base.startsWith("refs/") || base.startsWith(`${remote}/`)) {
    return base;
  }
  return `${remote}/${base}`;
}
export function baseResolutionStatePatch(resolution: WorkerBaseResolution): Record<string, unknown> {
  return {
    "current.base": resolution.base,
    "current.base_ref": resolution.baseRef,
    "current.base_sha": resolution.sha,
    "current.base_source": resolution.source,
    "current.base_remote_reachable": resolution.remoteReachable,
    ...(resolution.localSha ? { "current.base_local_sha": resolution.localSha } : {}),
    ...(resolution.localAhead !== undefined ? { "current.base_local_ahead": resolution.localAhead } : {}),
    ...(resolution.localBehind !== undefined ? { "current.base_local_behind": resolution.localBehind } : {}),
  };
}
export function formatBaseResolution(resolution: WorkerBaseResolution): string {
  return [
    `base: ${resolution.base}`,
    `ref: ${resolution.baseRef}`,
    `sha: ${resolution.sha || "(unresolved)"}`,
    `source: ${resolution.source}`,
    `remote_reachable: ${String(resolution.remoteReachable)}`,
    resolution.localSha ? `local_sha: ${resolution.localSha}` : undefined,
    resolution.localAhead !== undefined ? `local_ahead: ${resolution.localAhead}` : undefined,
    resolution.localBehind !== undefined ? `local_behind: ${resolution.localBehind}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
export function isMergeConflictRetry(priorAttemptContext: string | undefined): boolean {
  if (!priorAttemptContext) return false;
  const marker = "prev-failure-reason:";
  const idx = priorAttemptContext.indexOf(marker);
  const failureReason = idx === -1 ? priorAttemptContext : priorAttemptContext.slice(idx + marker.length);
  return /\bmerge-conflict\b/.test(failureReason);
}
export interface ProcessHooks {
  config: ConfigValues;
  resolveOptions: ResolveHooksOptions;
  exec: HookExec;
  env?: Record<string, string>;
}
export interface ProcessIssueDeps {
  gh: ProcessGh;
  claimLock: ProcessClaimLock;
  claimGh?: ClaimGh;
  claimStale?: ClaimReconcileOptions["isStale"];
  recoveredWorkerDeathCause?: (recoveredWorker: string) => string | null;
  fs: ProcessFs;
  git: ProcessGit;
  mergeExec: MergeExec;
  remoteGit: GitExec;
  pnpm: PnpmExec;
  validationResourceBudget?: { nodeMaxOldSpaceMb?: number; vitestMaxWorkers?: number };
  layout: PackageLayout;
  graph?: WorkspaceGraph;
  backpressure?: BackpressureExec;
  backpressureCommands?: readonly string[];
  outputShaping?: OutputShapingConfig;
  postBackpressureReview?: (pr: number, body: string) => Promise<void>;
  goVerifyRetries?: number;
  postAttemptFormat?: PostAttemptFormatExec;
  postAttemptFormatCommands?: readonly string[];
  runAgent(input: RunAgentInput): Promise<RunAgentResult>;
  sandboxMode?: SandboxMode;
  sandboxAvailable?(mode: ContainerSandboxMode): Promise<boolean>;
  /** Repo-level container image the isolation path runs (issue #2340), resolved
   * off the repo root so it is stable across issues, workers, and attempts. */
  sandboxImage?: string;
  /** Whether `sandboxImage` already exists for `mode`. When registered, the
   * forced-isolation policy probes it BEFORE claiming an attempt, so a missing
   * image parks with a build command instead of crashing mid-run and burning
   * the retry budget. */
  sandboxImageAvailable?(mode: ContainerSandboxMode, image: string): Promise<boolean>;
  model: string;
  effort?: AgentEffort;
  classifyIssue?(metadata: IssueClassificationMetadata): Promise<AfkModelTier>;
  resolveTier?(runner: Runner, taskClass?: AfkModelTier): {
    model: string;
    effort: AgentEffort;
  };
  hooks: ProcessHooks;
  lookups: ProcessLookups;
  fallbackRunner?: boolean;
  conflictResolver?: ConflictResolver;
  resolveMechanicalConflict?: (repo: string) => Promise<boolean>;
  resolveAgentConflict?: (repo: string) => Promise<boolean>;
  maxAgentConflictResolveAttempts?: number;
  worktreeLaunchesPr?: boolean;
  landLock?: LandLock;
  nativeMergeQueue?: boolean;
  makeLandingWorktree?(base: string): Promise<string | null>;
  removeLandingWorktree?(dir: string): Promise<void>;
  makeRebaseWorktree?(branch: string): Promise<string | null>;
  removeRebaseWorktree?(dir: string): Promise<void>;
  waitForReview?: WaitForReviewInput;
  ciAwait?: CiAwaitInput;
  reviewGate?: ReviewGateConfig;
  reviewGateLabel?: string;
  adversarialReview?: AdversarialReviewConfig;
  extractAdversarialReview?(input: {
    context: AdversarialReviewContext;
    runner: Runner;
    model: string;
    effort?: AgentEffort;
    maxIterations: number;
  }): Promise<AdversarialReviewFindings>;
  postAdversarialReview?(input: {
    pr: number;
    issue: number;
    body: string;
    findings: AdversarialReviewFindings;
  }): Promise<void>;
  envelope: EmitEnvelopeDeps;
  nowEpoch(): number;
  nowIso(): string;
  appendIterLog(line: string): void;
  recordAgentEvent?(event: AgentStreamEvent): void;
  emitHeartbeat?(info: AttemptProgressInfo): void;
  heartbeatVitals?(): Record<string, number> | undefined;
  notesLoop?: NotesLoopConfig;
  writeNotes?(path: string, content: string): void;
  markState?(patch: Record<string, unknown>): void;
  recordWorkerEvent?(kind: `worker.${string}`, payload?: Record<string, unknown>): void;
  markPhase?(phase: string): void;
  historyPath?: string;
  historyClock?: HistoryClock;
  recoveryEnv?: RecoveryEnv;
  recordAttempt?(payload: AttemptRecordPayload): Promise<void>;
  recordOutcomeEvent?(event: OutcomeEvent): Promise<void>;
  salvageUncommitted?(branch: string): Promise<number>;
  exitBarrier?(branch: string): Promise<ExitReceipt>;
  terminalExitBarrier?(branch: string): Promise<TerminalReceipt>;
  cascadeRebase?: CascadeRebasePort;
}
export interface CascadeRebasePort {
  listAFKBranches(repoDir: string, remote: string): Promise<string[]>;
  isWorkerLive(workerId: string): boolean;
  rebaseAndPush(repoDir: string, branch: string, newBase: string): Promise<{ ok: boolean; warn?: string }>;
}
export function resolveSpawnTier(
  deps: ProcessIssueDeps,
  runner: Runner,
  taskClass: AfkModelTier,
): { model: string; effort?: AgentEffort } {
  return deps.resolveTier?.(runner, taskClass) ?? { model: deps.model, effort: deps.effort };
}
export interface ProcessIssueInput {
  issue: number;
  title: string;
  body: string;
  runner: Runner;
  workerId: string;
  claimant?: string;
  tmpDir: string;
  attempt: number;
  recoveryOrdinal?: number;
  attemptDir: string;
  repo: string;
  repoDir: string;
  remote: string;
  baseInput: ResolveBaseInput;
  specRef?: string;
  runMode?: string;
  laneLabel?: string;
}
export type ProcessOutcome = AttemptOutcome;
export interface ProcessIssueResult {
  outcome: ProcessOutcome;
  issue: number;
  branch?: string;
  base?: string;
  locked?: boolean;
  mergeSha?: string;
  cleanupError?: string;
  exitReceipt?: ExitReceipt;
  hooksFired: HookName[];
  envelopePosted?: boolean;
  preserved: boolean;
  swept: boolean;
}
const CLEAN_EXIT_CODE = 0;
const CRASH_EXIT_CODE = 1;
const TIMEOUT_EXIT_CODE = 124;
export function stateExitPatch(outcome: ProcessOutcome): Record<string, unknown> {
  const base: Record<string, unknown> = {
    "current.phase": "terminal",
    "current.outcome": outcome,
  };
  if (outcome === "done") return { ...base, "current.last_exit_code": CLEAN_EXIT_CODE };
  if (outcome === "blocked") return { ...base, "current.last_exit_code": CLEAN_EXIT_CODE };
  if (outcome === "stalled") {
    return {
      ...base,
      "current.last_exit_code": TIMEOUT_EXIT_CODE,
      "current.failure_kind": "timeout",
    };
  }
  if (outcome === "no-sentinel") {
    return {
      ...base,
      "current.last_exit_code": CRASH_EXIT_CODE,
      "current.failure_kind": "crash",
    };
  }
  if (outcome === "signal-killed") {
    return {
      ...base,
      "current.last_exit_code": CRASH_EXIT_CODE,
      "current.failure_kind": "signal-killed",
    };
  }
  return { ...base, "current.last_exit_code": CRASH_EXIT_CODE };
}
export function recoveryOrdinalFor(input: ProcessIssueInput): number {
  return input.recoveryOrdinal && Number.isInteger(input.recoveryOrdinal) && input.recoveryOrdinal > 0
    ? input.recoveryOrdinal
    : input.attempt;
}
export function markTerminalState(deps: ProcessIssueDeps, outcome: ProcessOutcome): void {
  deps.markState?.(stateExitPatch(outcome));
  if (outcome !== "done") {
    deps.recordWorkerEvent?.("worker.blocked", { outcome });
  }
}
