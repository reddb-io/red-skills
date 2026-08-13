import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "../base-resolver.js";
import type { BranchRef } from "../branch-cleanup.js";
import type { BranchReversionGeometry } from "../branch-reversion.js";
import type { AttemptPullRequest } from "../branch-resume.js";
import {
  buildRefFromSlug,
  deleteRemote,
  pushAttempt,
  slugifyRef,
  type GitExec,
} from "../remote-branch.js";
import { buildHandoff, exitProtocolFor, type HandoffComment } from "../handoff.js";
import type { HandoffEnrichmentInput } from "../handoff-enrichment.js";
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
  type MergeQueueWaitInput,
} from "../merge.js";
import type { LandLock } from "../land-lock.js";
import {
  doLanding,
  type DeferredLandingTail,
  type LandingResult,
} from "../landing.js";
import type {
  QueueCustodyHandoffResult,
  QueueCustodyIdentity,
} from "../queue-custodian.js";
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
  HOST_CONFIG_EXIT_CODE,
  type WorkerOutcome,
} from "../worker-outcome.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "../hook-config.js";
import { formatStartedMarker } from "../heartbeat.js";
import { cascadeAuditCommentFor, parseReqLabels, planCloseCascade, type DependentIssue } from "../boot-sweep.js";
import { PREV_FAILURE_REASON_MARKER } from "../prev-failure.js";
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
import type { AfkModelTier, ConfigValues, ResolvedTaskRoute, ValidationMoments } from "../config.js";
import { runNotesLoop, notesPath, type NotesLoopConfig } from "../notes-loop.js";
import {
  buildIssueClassificationMetadata,
  shouldRequestReview,
  type IssueClassificationMetadata,
  type ReviewGateConfig,
} from "../issue-classifier.js";
import type { ReseedTrailGh } from "./reseed-trail.js";
import type { AttemptStatus } from "../envelope.js";
import type { Runner } from "../../types/runner.js";
import { runnerSupportsStructuredOutput, toAgentRunner } from "../runner-spec.js";
import type { HistoryClock } from "../history.js";
import type { MechanicalRegenerator } from "../generated-surfaces.js";
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
  LABEL_SPEC,
} from "../triage-labels.js";
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
  issueTrust?(issue: number, promoterLabel?: string): Promise<TrustProvenance>;
  repoVisibility?(): Promise<RepoVisibility | undefined>;
  actorTrustSignals?(actor: string): Promise<ActorTrustSignals>;
  /** Logins of comment authors who posted an `/approve-external` marker on the
   * issue (issue #2603). Trust of each login is resolved by the caller through
   * `resolveActorTrust`; this read is unauthenticated of trust — it only finds
   * the markers. Absent → the external-origin gate treats the issue as unapproved. */
  externalApprovalActors?(issue: number): Promise<string[]>;
  renderDecisionCard?(issue: number): Promise<void>;
}
export interface ProcessClaimLock {
  acquire(issue: number): Promise<boolean>;
  release(issue: number): Promise<void>;
}
export interface ProcessFs {
  ensureAttemptDir(dir: string): Promise<void>;
  writeHandoff(path: string, content: string): Promise<void>;
  readText?(path: string): Promise<string | null>;
  writeValidationSidecar?(path: string, lines: string[]): Promise<void>;
  completionSweep(issue: number): Promise<string[]>;
}
export interface ProcessGit {
  headShortSha(): Promise<string>;
  deleteLocalBranch(branch: string): Promise<{ ok: true } | { ok: false; error: string } | void>;
  prepareFreshWorkerBranch?(input: { branch: string; baseRef: string; force: boolean }): Promise<boolean | void>;
}
export interface WorkerBaseResolution {
  ok: boolean;
  base: string;
  baseRef: string;
  sha: string;
  source: "remote" | "local" | "mirror" | "grant";
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
  prevFailureContext(issue: number): Promise<string | undefined>;
  /** Best-effort owning-glossary and path-local exemplar supplement (#2402). */
  handoffEnrichment?(input: HandoffEnrichmentInput & { issue: number }): Promise<string | undefined>;
  changedFiles(branch: string, base: string): Promise<string[]>;
  /**
   * File contents at the merge-base and branch endpoints of `base...branch`.
   * Optional narrowing evidence: absence must retain path-based validation.
   */
  changedFileContents?(
    branch: string,
    base: string,
    file: string,
  ): Promise<{ before: string; after: string } | undefined>;
  diffstat(branch: string, base: string): Promise<string>;
  /**
   * The WORKTREE diff of `branch` against the merge base (#2730) — what the gate
   * fold's review stage reads, because that stage runs before any pull request
   * exists. Optional: absent, the review stage is SKIPPED rather than handed an
   * empty diff, since a reviewer that reads nothing reports nothing and would
   * pass a Ticket it never saw.
   */
  worktreeDiff?(branch: string, base: string): Promise<string>;
  /** Capture fork→fresh-base geometry before Landing integrates the branch. */
  branchReversionBaseline?(
    branch: string,
    remote: string,
    base: string,
  ): Promise<Omit<BranchReversionGeometry, "diff">>;
  /** Read fresh-base→HEAD geometry inside the integrated Landing worktree. */
  branchReversionDiffAt?(repo: string, baseRef: string): Promise<string>;
  /**
   * What the base ref did while this attempt ran (issue #2711): its head sha
   * NOW plus the subjects of the commits it gained since `sinceSha`. The gate
   * runs on the branch merged with the live base, so a base that moved under
   * the run can redden a branch that is itself green — this probe is the
   * evidence that lets the engine attribute such a failure to stale-base drift
   * instead of charging it to the correction budget. Optional: absent, every
   * gate failure stays `branch-fault`, exactly as before.
   */
  baseMovement?(baseRef: string, sinceSha: string): Promise<{
    head: string;
    subjects: string[];
    files?: string[];
  }>;
  /** Daemon-stamped base movement for this live Worker, read without fetching. */
  workerBaseMovement?(workerId: string): Promise<{
    startSha: string;
    gateSha: string;
    commitsAhead: number;
    subjects: readonly string[];
  } | undefined>;
  branchPresent?(branch: string): Promise<boolean>;
  branchMerged?(branch: string, base: string): Promise<boolean>;
  /** Discover all remote afk/* branches (issue #2397). Used to detect a prior
   * pushed attempt so re-claim can resume instead of rebuilding from scratch. */
  discoverBranches?(): Promise<BranchRef[]>;
  /**
   * How many commits a discovered branch carries ahead of `base` (#2865) — the
   * evidence that separates a dead Worker's finished work from the empty ref
   * worktree creation pushes. Optional, and `undefined` means "could not tell":
   * an unread branch is adopted rather than reset, because the branch a Worker
   * declines to adopt is the branch it deletes.
   */
  branchCommitsAhead?(branch: string, base: string): Promise<number | undefined>;
  /** List open PRs that may already carry this issue's work. The lifecycle
   * applies its own body/head match before adopting one. */
  discoverOpenPullRequests?(issue: number): Promise<AttemptPullRequest[]>;
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
export function isMergeConflictRetry(prevFailureContext: string | undefined): boolean {
  if (!prevFailureContext) return false;
  const idx = prevFailureContext.indexOf(PREV_FAILURE_REASON_MARKER);
  const failureReason =
    idx === -1 ? prevFailureContext : prevFailureContext.slice(idx + PREV_FAILURE_REASON_MARKER.length);
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
  /** Geometry captured around feedback's successful stale-base correction. */
  baseMergeReversionGeometry?(branch: string): BranchReversionGeometry | undefined;
  /** Production wiring fails closed when either geometric safety barrier is absent. */
  requireBranchReversionSafety?: boolean;
  validationResourceBudget?: { nodeMaxOldSpaceMb?: number; vitestMaxWorkers?: number; turboConcurrency?: number };
  /** Resolved declaration schedule; lifecycle consumption lands in the dependent slice. */
  validationMoments?: ValidationMoments;
  /** Mechanical stale-base cure selected by Verdict for generated-only drift. */
  mechanicalRegenerate?: MechanicalRegenerator;
  /**
   * Directory probe the gate uses to PROVE a declared validation worktree
   * exists (#3041). Wired to the real filesystem in production; absent in a
   * fixture, which is why an unprobed gate resolves its target but never
   * refuses — a gate that cannot look at the disk claims nothing about it.
   */
  dirExists?: (dir: string) => boolean;
  layout: PackageLayout;
  graph?: WorkspaceGraph;
  backpressure?: BackpressureExec;
  /** Declared replacement for feedback script discovery; `undefined` preserves discovery. */
  feedbackCommands?: readonly string[];
  backpressureCommands?: readonly string[];
  outputShaping?: OutputShapingConfig;
  postBackpressureReview?: (pr: number, body: string) => Promise<void>;
  goVerifyRetries?: number;
  /** The `/afk` lane's gate share of the Re-seed budget (ADR 0129), from
   * `dev.reseed.afk.gate_budget`. */
  reseedGateBudget?: number;
  postWorkerFormat?: PostWorkerFormatExec;
  postWorkerFormatCommands?: readonly string[];
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
  /** Complete task-class route. Runtime runner pins are already folded into it. */
  resolveRoute?(taskClass?: AfkModelTier): ResolvedTaskRoute;
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
  /** Budget for the post-enqueue merge confirmation on a merge-queue base (#2986). */
  mergeQueueWait?: MergeQueueWaitInput;
  /** Slot-release boundary across the PR landing tail (#2427). */
  landingWait?: "merge" | "ci" | "none";
  /** Durable native-queue hand-off; when present Landing arms and terminates. */
  queueCustody?: (
    identity: QueueCustodyIdentity,
    armNativeIntent: () => Promise<{ readonly ok: boolean; readonly reason?: string }>,
  ) => Promise<QueueCustodyHandoffResult>;
  /**
   * Shared tail observer. The call starts observation and returns the eventual
   * landing verdict; processIssue deliberately does not await it so the worker
   * slot is reusable while CI/merge/close finish.
   */
  landingTailObserver?: (
    task: DeferredLandingTail & { issue: number },
  ) => Promise<LandingResult>;
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
  /** Publish the review verdict. The Issue is the ONLY surface: the review runs
   * pre-PR now, so there is no pull request to comment on (#2730). */
  postAdversarialReview?(input: {
    issue: number;
    body: string;
    findings: AdversarialReviewFindings;
  }): Promise<void>;
  /** The Issue half of the Re-seed trail (#2731): ONE comment upserted in place
   * through the existing edit-comment primitive, so repeated rounds edit rather
   * than append. Absent, the trail keeps its draft pull request and drops the
   * comment — both are derived projections of the Attempt record. */
  reseedTrailGh?: ReseedTrailGh;
  envelope: EmitEnvelopeDeps;
  nowEpoch(): number;
  nowIso(): string;
  /** Canonical structured log for everything this Worker did. */
  workerLogPath?: string;
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
  /** ADR 0122 heal ledger (#2576): durable per-issue retry accounting so the
   * merge-retry cap survives worker replacement. Optional; absent in tests
   * that predate it (worker-local ordinal then applies alone). */
  healLedger?: import("@reddb-io/red-castle/engine").HealLedgerStore;
  recordOutcomeEvent?(event: OutcomeEvent): Promise<void>;
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
  const route = deps.resolveRoute?.(taskClass);
  if (route?.runner === runner) return { model: route.model, effort: route.effort };
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
  /** The exact commit the daemon judged this Worker against (ADR 0138). */
  forkSha: string;
  baseInput: ResolveBaseInput;
  specRef?: string;
  runMode?: string;
  laneLabel?: string;
}
export type ProcessOutcome = WorkerOutcome;
export interface ProcessIssueResult {
  outcome: ProcessOutcome;
  issue: number;
  branch?: string;
  base?: string;
  locked?: boolean;
  mergeSha?: string;
  cleanupError?: string;
  hooksFired: HookName[];
  envelopePosted?: boolean;
  preserved: boolean;
  swept: boolean;
  /** Why this ending happened, in one operator-facing line. Set by the endings
   * whose workspace the sweep discards (#3156) — a `claim-lost` that reported
   * only its outcome name withheld the answer it already had. */
  reason?: string;
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
  if (outcome === "host-config") {
    return {
      ...base,
      "current.last_exit_code": HOST_CONFIG_EXIT_CODE,
      "current.failure_kind": "host-config",
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
