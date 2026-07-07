// process-issue — the AFK per-issue lifecycle, ported from afk.sh's
// process_issue (+ iter_open / iter_close_* / claim_lock_acquire /
// completion_sweep_issue / the pre/post_attempt helpers), and the
// "Per-Issue Loop" / "Issue Lifecycle" sections of SKILL.md.
//
// PURE SEQUENCING: it owns only the ORDER of the lifecycle and the
// compose-decider-then-apply pattern — every step composes an already-ported
// pure module and applies its side effects through injected IO. No real gh, git,
// spawn, fs, or clock lives here; `processIssue` performs IO only through `deps`.
//
// Execution (worktree + agent spawn + sentinel detect + worker-branch commit) is
// delegated to the injected sandcastle `runAgent` port (ADR 0033). The
// lock-toggled landing (push → pre_merge → integrate → land → post_merge) is
// delegated to `doLanding` (landing.ts, ADR 0030/0031). AFK STILL OWNS: claim +
// labels, the attempt dir, handoff materialisation, the feedback gate, envelope
// emission, close, completion sweep, and the lifecycle hooks.
//
// Lifecycle hooks fire (via dispatchHooks over resolveHooks) at pre_worktree,
// pre_attempt, post_attempt, pre_merge, post_merge, and on_attempt_error. A
// terminal envelope is emitted on every exit path.

import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "./base-resolver.js";
import {
  buildRefFromSlug,
  deleteRemote,
  pushAttempt,
  slugifyRef,
  type GitExec,
} from "./remote-branch.js";
import { buildHandoff, exitProtocolFor, type HandoffComment } from "./handoff.js";
import { evaluateGoalPredicate } from "./goal-predicate.js";
import {
  type AgentOutcome,
  type AgentEffort,
  type AgentStreamEvent,
  type AttemptProgressInfo,
  type RunAgentInput,
  type RunAgentResult,
  type SandboxMode,
} from "./execution.js";
import {
  runFeedback,
  isInfraFeedbackFailure,
  type Exec as PnpmExec,
  type PackageLayout,
  type RunFeedbackResult,
} from "./feedback.js";
import {
  planMainRedRepair,
  type MainRedRepairIssue,
} from "./main-red-repair.js";
import {
  computeValidationScope,
  formatValidationScope,
  scopesForValidationScope,
  type ValidationScope,
  type WorkspaceGraph,
} from "./validation-scope.js";
import { runBackpressure, type BackpressureExec } from "./backpressure.js";
import { runPostAttemptFormat, type PostAttemptFormatExec } from "./post-attempt-format.js";
import {
  openReviewPr,
  openManualLandingPr,
  type Exec as MergeExec,
  type ConflictResolver,
  type WaitForReviewInput,
  type CiAwaitInput,
} from "./merge.js";
import { doLanding } from "./landing.js";
import { reconcile, type ReconcileInput } from "./reconcile.js";
import { ExitBarrierError, type ExitReceipt, type TerminalReceipt } from "./exit-barrier.js";
import {
  emitEnvelope,
  type EmitEnvelopeDeps,
  type SectionBodies,
} from "./envelope-emit.js";
import { dispatchHooks, type HookExec } from "./hook-dispatcher.js";
import { type RecoveryEnv } from "./recovery.js";
import { dispose } from "./disposition.js";
import {
  blockedLabelFor,
  envelopeStatusFor,
  type AttemptOutcome,
} from "./attempt-outcome.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "./hook-config.js";
import { formatStartedMarker } from "./heartbeat.js";
import { parseReqLabels, planCloseCascade, type DependentIssue } from "./boot-sweep.js";
import { buildAttemptRecordPayload, deriveIssueType, type AttemptRecordPayload } from "./attempt-record.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import { acquireClaim, type ClaimGh, type ClaimReconcileOptions } from "./claim.js";
import { applyCurrentBlockerEdit, parseCurrentBlocker, type CurrentBlocker } from "./blocker-state.js";
import {
  parseTrustPolicy,
  evaluateClaimTrust,
  resolveActorTrust,
  describeTrustPosture,
  type TrustProvenance,
  type RepoVisibility,
  type ActorTrustSignals,
} from "./trust-gate.js";
import { getConfig } from "./config.js";
import type { AfkModelTier, ConfigValues } from "./config.js";
import { runNotesLoop, notesPath, type NotesLoopConfig } from "./notes-loop.js";
import {
  buildIssueClassificationMetadata,
  shouldRequestReview,
  type IssueClassificationMetadata,
  type ReviewGateConfig,
} from "./issue-classifier.js";
import type { AttemptStatus } from "./envelope.js";
import type { Runner } from "../types/runner.js";
import { runnerSupportsStructuredOutput, toAgentRunner } from "./runner-spec.js";
import type { HistoryClock } from "./history.js";
import { DEFAULT_GO_VERIFY_RETRIES, LABEL_GO_LANE } from "./go.js";

type ContainerSandboxMode = Exclude<SandboxMode, "none">;

// ---------- injected IO ----------

/** gh side effects this lifecycle drives. Each mirrors a `gh issue …` call in
 * process_issue, kept out of the module so it stays IO-free. */
export interface ProcessGh {
  /** Current label set for the claim pre-check (`gh issue view --json labels`). */
  viewLabels(issue: number): Promise<string[]>;
  /** gh issue edit --remove-label … --add-label … (returns false on failure). */
  editLabels(issue: number, remove: string[], add: string[]): Promise<boolean>;
  /** Idempotently create a label on the fly (best-effort) so a missing typed
   * `blocked:<reason>` label never fails the close. Mirrors the runner-error
   * label-create pattern. */
  ensureLabel(name: string): Promise<void>;
  /** gh issue comment --body … */
  comment(issue: number, body: string): Promise<void>;
  /** gh issue edit --body … (best-effort; optional for older callers/tests). */
  editBody?(issue: number, body: string): Promise<boolean>;
  /** gh issue close --reason completed. */
  close(issue: number): Promise<void>;
  /** List open issues carrying `label` (number + label-name list). Backs the
   * close cascade's `req:<closedIssue>` dependent lookup. */
  listByLabel(label: string): Promise<{ number: number; labels: string[] }[]>;
  /** Resolve whether issue `n` is CLOSED. Resolves the cascade's per-dependency
   * `req:*` closed-states. A 404 / transient failure resolves to false. */
  issueClosed(n: number): Promise<boolean>;
  /**
   * Trust-gate provenance (#621, ADR 0085): the issue author + the actor who
   * applied `ready-for-agent`, read from the issue TIMELINE — never inferred from
   * the mutable label set. Consulted at claim time ONLY when an allowlist is
   * configured. Optional → absent callers/tests degrade to permissive (the gate
   * never fires), preserving today's behaviour.
   */
  issueTrust?(issue: number): Promise<TrustProvenance>;
  /**
   * Repository visibility (`gh repo view --json visibility`), folded into the
   * trust policy so the no-allowlist default is visibility-aware (issue #1101): a
   * PUBLIC repo fails closed, a private/undeterminable one stays permissive.
   * Optional → absent callers/tests degrade to the permissive default (no
   * visibility resolved), preserving today's behaviour.
   */
  repoVisibility?(): Promise<RepoVisibility | undefined>;
  /**
   * Dynamic-base trust signals for one actor (write-access / CODEOWNERS), the
   * `ActorTrustLookup` the fail-closed default resolves author + promoter trust
   * over. Optional → absent callers/tests cannot fail closed (the gate degrades to
   * permissive even on a public repo), preserving today's behaviour.
   */
  actorTrustSignals?(actor: string): Promise<ActorTrustSignals>;
  /**
   * Render (or refresh) the HITL decision card on a `ready-for-human` issue
   * (#935, S11a). Called best-effort after the escalation labels are applied.
   * Optional → absent callers/tests degrade silently (no card posted, existing
   * behaviour preserved).
   */
  renderDecisionCard?(issue: number): Promise<void>;
  /** Find the single open auto-filed main-red repair issue, if any. Optional so
   * older callers degrade to the historical baseline-downgrade behaviour. */
  findMainRedRepairIssue?(): Promise<MainRedRepairIssue | null>;
  /** Create the auto-filed main-red repair issue. */
  createMainRedRepairIssue?(spec: { title: string; body: string; labels: readonly string[] }): Promise<number>;
  /** Refresh the auto-filed main-red repair issue's title/body/labels. */
  updateMainRedRepairIssue?(
    issue: number,
    spec: { title: string; body: string; labels: readonly string[] },
  ): Promise<void>;
  /** Close the auto-filed main-red repair issue once the baseline probe is green. */
  closeMainRedRepairIssue?(issue: number, comment: string): Promise<void>;
}

/** Claim-lock side effects (the local mkdir lock at .red/tmp/claims/{N}/). */
export interface ProcessClaimLock {
  /** mkdir the per-issue claim dir; false when already held (POSIX-atomic). */
  acquire(issue: number): Promise<boolean>;
  /** rm -rf the per-issue claim dir. Best-effort. */
  release(issue: number): Promise<void>;
}

/** Filesystem side effects: the attempt dir, the handoff file, marker teardown.
 * Worktree creation/teardown is sandcastle's now (ADR 0033); AFK only retains
 * the cheap host-side artifacts (attempt dir + handoff + completion sweep). */
export interface ProcessFs {
  /** mkdir -p the attempt dir + open afk.log / lanes (iter_open). */
  ensureAttemptDir(dir: string): Promise<void>;
  /** Write the handoff.md into the attempt dir (the sandcastle promptFile). */
  writeHandoff(path: string, content: string): Promise<void>;
  /**
   * Write the machine-readable validation sidecar (`$ITER_DIR/validation.jsonl`,
   * SKILL.md §Validation Sidecar) — one `red.afk.validation.v1` JSON record per
   * line. Consumed by the optional Memory bridge; NOT rendered into the issue
   * comment. Best-effort: the caller swallows a write failure so it never fails
   * the close. Optional so older callers/tests that predate the sidecar degrade
   * to "do not write it".
   */
  writeValidationSidecar?(path: string, lines: string[]): Promise<void>;
  /** Remove every attempt dir for a completed issue (completion_sweep_issue). */
  completionSweep(issue: number): Promise<string[]>;
}

/** git side effects beyond the merge/remote-branch primitives: the rev-parse the
 * close path reads for the merge sha + local branch cleanup. Worktree create is
 * gone (sandcastle owns it). */
export interface ProcessGit {
  /** git -C primary rev-parse --short HEAD after a successful merge. */
  headShortSha(): Promise<string>;
  /** git -C primary branch -d <branch> after landing (best-effort). */
  deleteLocalBranch(branch: string): Promise<void>;
  /**
   * git -C primary fetch origin <base> — make the resolved base ref current
   * before sandcastle forks the worker branch off it (ADR 0031). Best-effort;
   * sandcastle's NamedBranchStrategy.baseBranch start point reads the fetched
   * ref. Optional so existing wiring/tests that predate the start point degrade
   * to sandcastle's HEAD default.
   */
  fetchBase?(base: string): Promise<void>;
  /**
   * Adapter-side guard for sandcastle's named-branch reuse path. After
   * `fetchBase()` refreshes `origin/<base>`, remove stale local worker state
   * before `runAgent()` so red-castle must recreate the worker branch from
   * `baseRef` instead of reusing a branch whose merge-base predates the fresh
   * base tip. `force` is true for a retry after a prior merge-conflict terminal;
   * non-conflict retries still get a stale-merge-base check inside the runtime
   * implementation, preserving same-run reuse when the branch is already current.
   */
  prepareFreshWorkerBranch?(input: { branch: string; baseRef: string; force: boolean }): Promise<boolean | void>;
}

/** Injected lookups the composed deciders need (issue body for the pin, the
 * lock value for the base, the handoff projection, the feedback scope inputs). */
export interface ProcessLookups {
  /** Resolve the effective base (lock > pin > main). */
  base: ResolveBaseDeps;
  /** True when the session is locked to a branch. Since #842 the lock only
   * resolves the base; the landing mode is the `worktreeLaunchesPr` flag. The
   * result still echoes this for observability. */
  isLocked(): Promise<boolean>;
  /** Issue comments projected for the handoff (gh issue view --json comments). */
  comments(issue: number): Promise<HandoffComment[]>;
  /** Resolved gh issue url for the handoff `source:` line. */
  issueUrl(issue: number): Promise<string>;
  /** Restart-informed retry block (issue #255); empty on a first attempt. */
  priorAttemptContext(issue: number): Promise<string | undefined>;
  /** Changed files of the worker branch vs the base, for feedback scope resolution. */
  changedFiles(branch: string, base: string): Promise<string[]>;
  /** Diffstat line for the done envelope. */
  diffstat(branch: string, base: string): Promise<string>;
  /**
   * FIX E: confirm the worker branch actually reached the host before the
   * feedback gate. `changedFiles` returns `[]` for a NON-EXISTENT branch (a
   * three-dot diff against a missing ref), which would silently bypass the merge
   * gate on unvalidated work if sandcastle's push never landed. The CLI binds
   * this to `git rev-parse --verify` (with one fetch attempt). Optional so
   * pre-existing wiring/tests that predate the check degrade to "assume present"
   * (the legacy behaviour).
   */
  branchPresent?(branch: string): Promise<boolean>;
  /**
   * Goal predicate own-merge signal (ADR 0057): has the worker branch already
   * landed in `<base>`? Consulted ONCE when the attempt-guard poll observes the
   * claimed issue CLOSED, to map the moot attempt — `true` → the close carries
   * THIS attempt's own merge (`done`); `false`/absent → a foreign lander closed
   * it (`claim-lost`). Optional so legacy wiring/tests degrade to `claim-lost`.
   */
  branchMerged?(branch: string, base: string): Promise<boolean>;
}

function remoteTrackingBaseRef(remote: string, base: string): string {
  if (/^[0-9a-f]{7,40}$/i.test(base) || base.startsWith("refs/") || base.startsWith(`${remote}/`)) {
    return base;
  }
  return `${remote}/${base}`;
}

function isMergeConflictRetry(priorAttemptContext: string | undefined): boolean {
  if (!priorAttemptContext) return false;
  const marker = "prev-failure-reason:";
  const idx = priorAttemptContext.indexOf(marker);
  const failureReason = idx === -1 ? priorAttemptContext : priorAttemptContext.slice(idx + marker.length);
  return /\bmerge-conflict\b/.test(failureReason);
}

/** The hook dispatch surface: the parsed config + the default resolver + the
 * injected command executor. resolveHooks runs once; dispatchHooks per point. */
export interface ProcessHooks {
  config: ConfigValues;
  resolveOptions: ResolveHooksOptions;
  exec: HookExec;
  /** RED_AFK_* env handed to every hook command (defaults to {}). */
  env?: Record<string, string>;
}

/** All injected IO + lookups for one per-issue run. */
export interface ProcessIssueDeps {
  gh: ProcessGh;
  claimLock: ProcessClaimLock;
  /** Atomic GitHub-native claim arbitration (ADR 0066). The authority that
   * decides the single winner across hosts — `claimLock` is now only a cheap
   * same-host dedupe in front of it, and the `running` label is a projection,
   * never the lock. Optional for back-compat: callers/tests that omit it fall
   * back to the legacy `running`-label pre-check as the lock. */
  claimGh?: ClaimGh;
  /** Injected staleness predicate for cross-host stale-claim recovery (ADR 0066).
   * Defaults to "never stale" when omitted. */
  claimStale?: ClaimReconcileOptions["isStale"];
  /** AFK runner improvement: resolve a recovered stale-claim owner's death cause
   * for the recovery audit comment (Pattern 5 — make the process-safety
   * diagnostic actionable). Bound by the runtime to
   * `deathCauseForRecoveredWorker`; absent → the audit keeps its original
   * wording. */
  recoveredWorkerDeathCause?: (recoveredWorker: string) => string | null;
  fs: ProcessFs;
  git: ProcessGit;
  /** git executor for merge.ts (integrateOrigin / landMerge / landPr). */
  mergeExec: MergeExec;
  /** git executor for remote-branch.ts (pushAttempt / deleteRemote). */
  remoteGit: GitExec;
  /** pnpm executor for feedback.ts. */
  pnpm: PnpmExec;
  /** Package layout probe for feedback scope resolution. */
  layout: PackageLayout;
  /**
   * Workspace dependency graph for dependency-cone scoping (T5, PRD #1013).
   * When provided, the feedback gate runs the full cone: the changed packages
   * plus every package that transitively depends on them. When absent (back-compat
   * for existing callers / tests), the gate falls back to the current
   * directly-touched-packages behaviour (no cone expansion).
   */
  graph?: WorkspaceGraph;
  /**
   * Shell executor for the operator-declared backpressure gate (#430, PRD #429).
   * Runs each `afk.backpressure` command against the worker-branch checkout.
   * Optional → when absent (or `backpressureCommands` is empty) the gate is a
   * no-op (today's behaviour). The CLI binds it to the feedback worktree's
   * `sh -c` executor rebased onto the materialised worker-branch checkout.
   */
  backpressure?: BackpressureExec;
  /**
   * Operator-declared backpressure commands (`afk.backpressure`), in order.
   * Empty/absent → the backpressure gate is skipped. SUPPLEMENTS the
   * scope-derived feedback gate; it does not replace it.
   */
  backpressureCommands?: readonly string[];
  /**
   * `/go` only: bounded number of post-DONE machine-gate correction attempts.
   * The initial DONE validation is not counted; a value of 2 allows two
   * correct-and-re-verify agent invocations before deterministic escalation.
   */
  goVerifyRetries?: number;
  /**
   * Shell executor for the post-attempt-format step (#1015): runs each
   * `afk.post_attempt_format` command in the worker-branch checkout AFTER the
   * agent's commits and BEFORE the feedback gate; auto-commits any formatting
   * delta. Optional → when absent (or `postAttemptFormatCommands` is empty) the
   * step is a no-op. The CLI binds it to the feedback worktree's auto-format
   * executor.
   */
  postAttemptFormat?: PostAttemptFormatExec;
  /**
   * Operator-declared post-attempt-format commands (`afk.post_attempt_format`),
   * in order. Empty/absent → the step is skipped. Non-zero exit aborts and
   * routes to abortAfterClaim (branch preserved for manual recovery).
   */
  postAttemptFormatCommands?: readonly string[];
  /**
   * The sandcastle execution port (ADR 0033): run the inner agent on a worktree,
   * detect the DONE/BLOCKED sentinel, and commit on the worker branch. The CLI
   * passes a closure over execution.runAgent + defaultSandcastleDeps; tests pass
   * a fake returning a scripted RunAgentResult.
   */
  runAgent(input: RunAgentInput): Promise<RunAgentResult>;
  /**
   * The operator-configured AFK sandbox mode. Trusted-author work keeps this
   * unchanged. Untrusted-author work may override it to a container backend.
   * Optional for legacy tests/callers; absence preserves the historical `none`
   * default unless untrusted-author policy has enough provenance to engage.
   */
  sandboxMode?: SandboxMode;
  /**
   * Best-effort backend availability probe for fail-closed untrusted-author
   * policy. When untrusted work needs a container and no configured container is
   * available, processIssue refuses before spawning the inner agent.
   */
  sandboxAvailable?(mode: ContainerSandboxMode): Promise<boolean>;
  /** Model id passed through to runAgent (provider-specific, e.g. "claude-opus-4-8"). */
  model: string;
  /** Reasoning effort passed through to runAgent; undefined preserves legacy callers. */
  effort?: AgentEffort;
  /** Cheap per-issue classifier (ADR 0049): model call injected by the runtime
   * and mocked in tests. Absent callers preserve the prior `think` default. */
  classifyIssue?(metadata: IssueClassificationMetadata): Promise<AfkModelTier>;
  /** Resolve the per-runner AFK tier table (ADR 0049). */
  resolveTier?(runner: Runner, taskClass?: AfkModelTier): {
    model: string;
    effort: AgentEffort;
  };
  hooks: ProcessHooks;
  lookups: ProcessLookups;
  /**
   * Mid-issue runner fallback (--fallback-runner / FALLBACK_RUNNER). When true,
   * a first exhaustion swaps to the other runner (claude↔codex) and re-runs the
   * attempt once; double-exhaustion is terminal (outcome `exhausted`). When
   * false (default), a single exhaustion is terminal.
   */
  fallbackRunner?: boolean;
  /**
   * One-shot inner-agent merge-conflict resolver (merge_resolve_conflict). When
   * a `git merge --no-ff` leaves conflicts in the primary checkout, dispatch the
   * configured runner once with the resolver prompt. Returns void; the merge
   * primitive verifies the git state afterwards. Optional: when absent, a merge
   * conflict goes straight to ready-for-human (the pre-recovery behaviour).
   */
  conflictResolver?: ConflictResolver;
  /**
   * Landing-mode flag, decoupled from the lock (ADR 0030 amended, #842). Resolved
   * from `afk.worktree_launches_pull_request` (default `true`) by the CLI. `true`
   * → the attempt lands via an admin-merged PR into the resolved base; `false` →
   * a direct merge into that base (no PR, offline). The lock only resolves the
   * base now, not the mode. Undefined (tests) is treated as `true` (the default).
   */
  worktreeLaunchesPr?: boolean;
  /**
   * Provision/tear down an isolated detached worktree at `<base>` for the DIRECT
   * (non-PR) landing (issue #572). The direct merge/push/rollback runs there so a
   * push reject's `reset --hard` can never discard the primary checkout's WIP. The
   * CLI binds these to `git worktree add --detach` / `git worktree remove`; absent
   * → the direct landing is refused (never falls back to mutating the primary).
   */
  makeLandingWorktree?(base: string): Promise<string | null>;
  removeLandingWorktree?(dir: string): Promise<void>;
  /**
   * Provision/tear down an ISOLATED worktree on the worker branch for the PR
   * path's pre-merge rebase (#1006): fetch base, rebase the branch onto it,
   * force-push, then admin-merge — so a diverged base can never false-flag the
   * landing as blocked:merge-conflict. Runs off the primary checkout (#572). The
   * CLI binds these to `git worktree add --detach origin/<branch>` / `git worktree
   * remove`; absent → the rebase is skipped and the PR lands as before (opt-in).
   */
  makeRebaseWorktree?(branch: string): Promise<string | null>;
  removeRebaseWorktree?(dir: string): Promise<void>;
  /**
   * Opt-in advisory-review wait for the admin-PR landing
   * (`afk.merge.wait_for_review`, ADR 0048). Resolved from config by the CLI:
   * present → the landing holds until the configured review check concludes
   * before the admin-merge, then merges regardless of the verdict (the review
   * stays advisory — drift-guard + in-process backpressure are the binding
   * gates). Absent (the default) → admin-merge ignores advisory checks. Tests
   * omit it.
   */
  waitForReview?: WaitForReviewInput;
  /**
   * Opt-in CI-aware merge for the UNLOCKED admin-PR landing (#812). Resolved from
   * config by the CLI (`afk.merge.ci_aware` + `RED_AFK_MERGE_CI_TIMEOUT_S`). When
   * present, the landing polls the PR's merge state and admin-merges only once it
   * settles to ready, routing the distinct `ci-failed` / `ci-pending` failure
   * modes instead of mislabelling a MERGEABLE-but-CI-blocked PR as a merge
   * conflict (and re-running the whole inner agent). Absent (the default) →
   * admin-merge immediately. Tests omit it.
   */
  ciAwait?: CiAwaitInput;
  /**
   * PR review gate (ADR 0064 §10, #749). Resolved from `afk.review_gate.*` by the
   * CLI. When enabled AND the attempt's classified tier is non-mechanical, a
   * PR landing is replaced by a review handoff: open the PR, apply
   * `ready-for-review` (firing the advisory review), and park the issue for the
   * review→merge flow instead of fast-merging. Mechanical/trivial work — and the
   * direct (non-PR) path, which never opens a PR — keep the existing fast-merge
   * path. Absent or disabled (the default) → no review hop. Tests omit it.
   */
  reviewGate?: ReviewGateConfig;
  /** Label applied to the PR to fire the advisory review (default
   * `ready-for-review`). Injected so the policy string stays in the CLI layer. */
  reviewGateLabel?: string;
  /** Envelope-emit IO (poster / marker writer / posted writer / git push). */
  envelope: EmitEnvelopeDeps;
  /** Clock: epoch seconds (date +%s) and an ISO timestamp (date -Iseconds). */
  nowEpoch(): number;
  nowIso(): string;
  /** Append one plain line to the iteration's afk.log (heartbeat boundary). */
  appendIterLog(line: string): void;
  /**
   * Best-effort observability sink for the inner agent's output stream, passed
   * to runAgent as `onAgentEvent`. The CLI wires it to append a `type=agent`
   * record to the attempt's `agent.log.jsonl` (the liveness lane the stall
   * detector / monitor read) plus a firehose line, so the lane advances while
   * the agent works instead of freezing at iteration start. Optional: when
   * absent, runAgent runs without stream forwarding (tests, legacy callers).
   */
  recordAgentEvent?(event: AgentStreamEvent): void;
  /**
   * Externalized proof-of-life sink (PR-B): called once per attempt-guard poll
   * with the progress signal. The CLI (run.ts) wires it to append an enriched
   * `type=heartbeat` firehose record and update `current.last_progress_at` in
   * afk.state.json, so external integrators can tail/read the agent's liveness +
   * progress. The `on_heartbeat` user hook fires alongside it (in processIssue,
   * which owns the hook dispatcher). Optional → tests/legacy callers omit it.
   */
  emitHeartbeat?(info: AttemptProgressInfo): void;
  /**
   * Worker-vitals provider for the `on_heartbeat` hook context (ADR 0065/#832).
   * Called on each attempt-guard poll right before the hook fires; returns the
   * live cumulative WorkerVitals (tools/text/reasoning/reasoning-tokens/loc/cost)
   * so the `on_heartbeat` stdin-JSON carries the full vitals snapshot and a hook
   * can drive custom live alerting. The CLI (run.ts) wires it to the attempt's
   * activity meter + last-observed diff volume. Optional → when absent the hook
   * context omits `vitals` (byte-for-byte the pre-#832 record).
   */
  heartbeatVitals?(): Record<string, number> | undefined;
  /**
   * Intra-attempt notes-loop config (Track C, #924). Resolved from
   * `afk.notes_loop.*` by the CLI (`resolveNotesLoopConfig`). When enabled, the
   * single inner-agent invocation is wrapped in a bounded outer loop that carries
   * an accumulated `notes.md` between iterations. Absent (tests / legacy callers)
   * or `enabled:false` → exactly one agent call, today's behaviour, unchanged.
   */
  notesLoop?: NotesLoopConfig;
  /**
   * Persist the notes-loop's carried `notes.md` (Track C, #924). The CLI binds it
   * to a filesystem writer; the loop calls it with the attempt-dir path (outside
   * the worker branch's worktree, so it is never committed). Optional → when
   * absent the notes are carried in-process only.
   */
  writeNotes?(path: string, content: string): void;
  /**
   * Persist compact machine-readable attempt state beyond the coarse phase.
   * The CLI binds this to afk.state.json updates; tests inject a recorder.
   * Optional so older callers preserve their existing behaviour.
   */
  markState?(patch: Record<string, unknown>): void;
  /**
   * Stamp the attempt's macro-lifecycle phase (issue #811) — the calm signal the
   * task-mirror title surfaces. processIssue calls it at the orchestrator-owned
   * lifecycle points the inner-agent stream cannot see: `validating` at the start
   * of the feedback gate (step 5b) and `merging` at the start of landing (step 6).
   * The CLI (run.ts) wires it to `updateState(current.phase)`; `setup`/`coding`
   * are stamped elsewhere (the seed + the agent stream sink). Optional → tests and
   * legacy callers omit it (the call is `?.`-guarded).
   */
  markPhase?(phase: string): void;
  /** History ledger path + clock for the terminal envelope (optional). */
  historyPath?: string;
  historyClock?: HistoryClock;
  /**
   * Env view the BOUNDED auto-recovery policy reads the RED_AFK_RETRY_* caps
   * from (recovery.ts). Defaults to `process.env` in the CLI; tests inject a
   * record. Absent → an empty env (every recoverable reason uses its default
   * cap).
   */
  recoveryEnv?: RecoveryEnv;
  /**
   * AFK→Memory "reasoning attempt" recording (ADR 0017). Called best-effort
   * AFTER each terminal Envelope is emitted, with the AFK-side attempt context.
   * The wired implementation (run.ts) serialises the payload to a temp file and
   * execs the memory CLI DIRECTLY (`attempt record --root <root>` with the
   * payload on stdin), gating on memory availability (ADR 0009) — a no-op when
   * memory is absent / not opted-in. The port
   * SWALLOWS every error so a memory failure can NEVER fail the AFK close.
   * Optional so tests/older callers omit it entirely (the call is `?.`-guarded).
   */
  recordAttempt?(payload: AttemptRecordPayload): Promise<void>;
  /**
   * AFK→Brain outcome-event recording. Called best-effort after attempt
   * completion with the shared versioned outcome-event contract. Optional and
   * fully swallowed: Brain absence/down must never fail or delay the attempt
   * terminal path.
   */
  recordOutcomeEvent?(event: OutcomeEvent): Promise<void>;
  /**
   * Salvage uncommitted work the inner agent left in its worktree. The codex
   * runner sometimes edits, passes the gates, and emits `<promise>DONE</promise>`
   * without committing every dirty path. After any done / no-sentinel outcome,
   * processIssue calls this to commit remaining dirty worktree paths (one commit
   * per file) onto `branch` and push, so the SAME feedback gate + landing tail
   * see the complete work. Returns the count of files committed (0 = clean
   * worktree, nothing salvaged). Best-effort; MUST NOT throw. Optional → tests /
   * legacy callers omit it (no salvage).
   */
  salvageUncommitted?(branch: string): Promise<number>;
  /**
   * ADR 0083 §4 exit barrier (DONE tracer, #1020). The single owner of an
   * attempt's terminal exit on the DONE path: salvage-commit any dirty worktree
   * paths, push the attempt branch to origin (retry once), and return an auditable
   * {@link ExitReceipt} (branch / head / pushedAt / salvage flag) recorded in the
   * done ProcessIssueResult + attempt record. Throws {@link ExitBarrierError} when
   * the push fails after retry — processIssue routes that to a NON-clean terminal
   * so the attempt is never reported done without a receipt ("work is saved iff
   * its branch ref is pushed to origin"). Optional → when absent the DONE path
   * falls back to the legacy salvage-only step (`salvageUncommitted`). The CLI
   * (run.ts) binds it over the same GitContext; tests inject a fake barrier.
   */
  exitBarrier?(branch: string): Promise<ExitReceipt>;
  /**
   * ADR 0083 §4 exit barrier (every-terminal, #1021). The single owner of an
   * attempt's terminal exit on EVERY FAILURE path — guard abort, stall-kill, crash
   * teardown, and (via reconcile) the no-agent lane: salvage-commit dirty worktree
   * paths + push the attempt branch to origin (retry once) and return a
   * {@link TerminalReceipt}. Unlike {@link exitBarrier} it NEVER throws — a failing
   * attempt is already terminal, so a rejected push is RECORDED (`pushed:false`)
   * not escalated. The receipt is the REQUIRED input to `preservedTerminal`, so a
   * preserved terminal that reports a status without crossing the barrier is not
   * representable. Optional → when absent `crossTerminalBarrier` returns a
   * not-pushed receipt so legacy callers still report (branch state unconfirmed).
   * run.ts binds it over the same GitContext as {@link exitBarrier}; tests inject
   * a fake barrier.
   */
  terminalExitBarrier?(branch: string): Promise<TerminalReceipt>;
  /**
   * Post-merge PRD cascade rebase (issue #1007, `afk.landing.cascade_rebase`).
   * Provides the IO surface for {@link runCascadeRebase}: after a successful DONE
   * landing, AFK rebases every open sibling branch (same prd:N label, not held by
   * a live worker) onto the new base HEAD, keeping PRD siblings fresh between
   * landings. All three operations are best-effort — a failure logs a warning and
   * never rolls back the primary landing. Optional: when absent the cascade rebase
   * is skipped entirely (legacy callers / tests that predate #1007).
   */
  cascadeRebase?: CascadeRebasePort;
}

/** Injectable IO for the post-merge PRD cascade rebase (#1007). */
export interface CascadeRebasePort {
  /**
   * List remote branch names under the `afk/` namespace (e.g.
   * `["afk/wXXX/42-fix-thing", …]`). Used to find which origin branches belong
   * to sibling issues.
   */
  listAFKBranches(repoDir: string, remote: string): Promise<string[]>;
  /**
   * True when the worker process owning `workerId` is still alive. Used to skip
   * branches currently held by a running worker — rebasing a live worker's branch
   * would race with its next push.
   */
  isWorkerLive(workerId: string): boolean;
  /**
   * Rebase `branch` onto `origin/<newBase>` in an isolated worktree and push the
   * result with `--force-with-lease`. Best-effort: never throws; returns
   * `{ok:false, warn}` on any failure (rebase conflict, push rejection, worktree
   * setup error).
   */
  rebaseAndPush(repoDir: string, branch: string, newBase: string): Promise<{ ok: boolean; warn?: string }>;
}

function resolveSpawnTier(
  deps: ProcessIssueDeps,
  runner: Runner,
  taskClass: AfkModelTier,
): { model: string; effort?: AgentEffort } {
  return deps.resolveTier?.(runner, taskClass) ?? { model: deps.model, effort: deps.effort };
}

/** Static per-issue inputs the caller resolves before `processIssue`. */
export interface ProcessIssueInput {
  issue: number;
  title: string;
  body: string;
  runner: Runner;
  /** Worker id (the `{id}` in the branch ref / attempt dir). */
  workerId: string;
  /** Claimant identity for the GitHub-native claim (`host:worker_id`, ADR 0066).
   * Unique per worker process per host so two hosts never collide. Defaults to
   * `workerId` when the caller does not resolve a hostname. */
  claimant?: string;
  /** .red/tmp root, for the attempt dir + claim lock paths. */
  tmpDir: string;
  /** Attempt number from the attempt-ledger (1-based). */
  attempt: number;
  /** Resolved attempt dir `<tmp>/workers/{id}/{N}-a{n}`. */
  attemptDir: string;
  /** Primary checkout (`owner/repo` for gh, dir for git -C). */
  repo: string;
  repoDir: string;
  remote: string;
  /** Pin-resolution input for resolveBase (the issue/PRD number + body). */
  baseInput: ResolveBaseInput;
  /** Optional PRD reference for the handoff `prd:` line. */
  prdRef?: string;
  /** Execution mode modifier: `"scout"` activates the read-only investigation
   * path — agent runs without committing, no push / PR / landing; report is
   * posted as a comment and the disposable issue closes. Forwarded from the
   * `--run-mode` flag by `run.ts`/`buildProcessInput`. */
  runMode?: string;
  /**
   * The candidate-listing label the session selected this issue under — the
   * `--lane` value (`ready-for-agent` for `/afk`, `lane:go` for `/go`,
   * `lane:scout` for scout). The pre-claim state-validity recheck re-reads the
   * issue's labels and requires THIS label to still be present; a lane-blind
   * hardcode to `ready-for-agent` made every `/go`/scout dispatch a silent
   * `claim-lost` (#1045), because those lanes carry the isolated lane label,
   * never `ready-for-agent`. Absent → defaults to `ready-for-agent`, so the
   * `/afk` path is byte-for-byte unchanged. */
  laneLabel?: string;
}

// ---------- result ----------

// The subset of `AttemptOutcome` that the per-issue lifecycle itself can return.
// `infra` (boot setup) originates outside processIssue, so it is excluded here
// while the shared owner (attempt-outcome) keeps the full union. `stalled` is
// now ALSO a processIssue terminal: the attempt progress guard (execution.ts)
// surfaces a `timeout` agent-outcome which processIssue maps to `stalled` (→
// blocked:stalled, ready-for-human). Exclude<> ties this to the single owner so
// the two can never drift.
export type ProcessOutcome = Exclude<AttemptOutcome, "infra">;

export interface ProcessIssueResult {
  outcome: ProcessOutcome;
  issue: number;
  /** Resolved live branch ref (afk/{id}/{N}-{slug}); undefined when the claim was lost. */
  branch?: string;
  /** Resolved base branch (lock > pin > main); undefined when the claim was lost. */
  base?: string;
  /** Locked-branch landing was used (landMerge) vs admin-PR landing (landPr). */
  locked?: boolean;
  /** Merge commit sha on a successful done close. */
  mergeSha?: string;
  /**
   * ADR 0083 §4 exit-barrier receipt (#1020) — the auditable proof the attempt
   * branch reached origin (branch / head / pushedAt / salvage flag). Present on
   * the DONE path when an `exitBarrier` port is wired; undefined otherwise.
   */
  exitReceipt?: ExitReceipt;
  /** The lifecycle points that fired, in order — the parity target for tests. */
  hooksFired: HookName[];
  /** True when the terminal envelope was posted. */
  envelopePosted?: boolean;
  /** True when the attempt dir was preserved (every failure path). */
  preserved: boolean;
  /** True when the completion sweep ran (done only). */
  swept: boolean;
}

const CLEAN_EXIT_CODE = 0;
const CRASH_EXIT_CODE = 1;
const TIMEOUT_EXIT_CODE = 124;

function stateExitPatch(outcome: ProcessOutcome): Record<string, unknown> {
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
  return { ...base, "current.last_exit_code": CRASH_EXIT_CODE };
}

function markTerminalState(deps: ProcessIssueDeps, outcome: ProcessOutcome): void {
  deps.markState?.(stateExitPatch(outcome));
}

// ---------- the orchestration ----------

import {
  LABEL_READY,
  LABEL_RUNNING,
  LABEL_HUMAN,
  LABEL_DEPENDENCY,
  LABEL_READY_FOR_REVIEW,
  LABEL_LANDING_MANUAL,
  LABEL_SENSITIVE_PATH,
  LABEL_SPEC,
} from "./triage-labels.js";
import { validateIssueLifecycleTransition, type IssueLifecycleEdge } from "./issue-lifecycle.js";

/**
 * The typed `blocked:*` labels present in a label set (#402). Promoting an issue
 * to `running` (or `ready-for-agent`) must shed any stale `blocked:*` reason in
 * the SAME edit so no live/queued issue ever carries `running`/`ready-for-agent`
 * together with `blocked:*` — the exact hygiene gap the adoption doctor flags.
 * Only labels actually present are returned, so the caller never asks gh to
 * remove a label the issue does not have.
 */
function blockedLabelsIn(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith("blocked:"));
}

const MECHANICAL_BLOCKER_KINDS = new Set(["stalled", "crashed", "merge-conflict"]);

/**
 * ADDITIVE typed-blocked observability tag. Apply the routing label transition
 * (remove → add) and, ALONGSIDE it in the SAME editLabels call, the DESCRIPTIVE
 * `blocked:<reason>` label for the terminal failure. The typed label is created
 * on the fly (best-effort) so a missing label never fails the close — routing is
 * unchanged: the caller's `add` (e.g. ready-for-human / ready-for-agent) is
 * preserved exactly, the typed label is merely appended.
 */
async function editLabelsTagged(
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

async function editIssueLifecycleLabels(
  deps: ProcessIssueDeps,
  issue: number,
  fromLabels: readonly string[],
  remove: string[],
  add: string[],
  edge: IssueLifecycleEdge,
): Promise<boolean> {
  validateIssueLifecycleTransition({ edge, fromLabels, removeLabels: remove, addLabels: add });
  return deps.gh.editLabels(issue, remove, add);
}

/**
 * Apply the BOUNDED auto-recovery routing for a terminal failure. The policy
 * (recovery.ts) decides retry vs escalate from the reason + the real attempt
 * number + the env caps:
 *   - "retry"    → remove [running], add [ready-for-agent]            (CLEAN)
 *   - "escalate" → remove [running], add [ready-for-human, blocked:<reason>]
 * The typed `blocked:<reason>` label rides ONLY the escalation (#402): a re-queued
 * issue returns to `ready-for-agent` with no `blocked:*` label, so it never trips
 * the adoption-doctor hygiene check. The failure reason is still recorded by the
 * attempt envelope + the attempt-ledger; the label is for the parked human lane.
 * When we ESCALATE a reason that was recoverable (its retry budget ran out), post a
 * one-line comment so the human page is self-explanatory. Returns the decision
 * so the caller can log / shape its terminal result if it cares.
 */
async function routeRecovery(
  deps: ProcessIssueDeps,
  issue: number,
  reason: AttemptOutcome,
  attemptN: number,
  opts: { forceDecision?: "retry" | "escalate" } = {},
): Promise<"retry" | "escalate"> {
  // The composer owns the retry-vs-escalate decision, the label sets, and the
  // budget-exhausted page comment (core/disposition). This site only APPLIES it:
  //   - retry    → editLabels [running] → [ready-for-agent] CLEAN (#402); the
  //                issue reached here from `running`, already stripped of any
  //                blocked:* reason, so the promotion stays hygienic.
  //   - escalate → ensure + add the typed blocked:* label alongside ready-for-human,
  //                then post the page comment when a recoverable budget ran out.
  // The per-issue lifecycle never auto-retries `stalled` (the reaper owns that
  // bounded re-claim), so we ask the composer for the PER-ISSUE policy view.
  const disp = dispose(reason, attemptN, deps.recoveryEnv ?? {}, { stalledRecoverable: false });

  // on_recovery_decision (#832, MUTABLE): hand the composer's proposed decision
  // to a hook, which may override retry↔escalate via a `{"decision":…}` stdout
  // JSON before any label is applied. An absent / silent hook is a no-op.
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
    // Build the escalate label set from the typed label (computed independent of
    // the composer's own decision) so a hook-FORCED escalate still pages cleanly.
    const addLabels = disp.typedLabel !== null ? [LABEL_HUMAN, disp.typedLabel] : [LABEL_HUMAN];
    await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], addLabels, "human-blocked");
    // The budget-exhausted page comment only rides the composer's OWN escalate
    // (it tells a retry-budget story); a hook-forced escalate stays silent.
    if (decision === disp.decision && disp.escalationComment !== null) {
      await deps.gh.comment(issue, disp.escalationComment);
    }
    // on_blocked (#832): the issue is now parked to a human gate.
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
    // Render the HITL decision card (#935, S11a). Best-effort: a card failure
    // must never block the recovery path — the label transition already happened.
    if (deps.gh.renderDecisionCard) {
      try {
        await deps.gh.renderDecisionCard(issue);
      } catch {
        // best-effort: card render failure is non-fatal.
      }
    }
  } else {
    // retry → CLEAN promotion: running → ready-for-agent, no blocked:* tag.
    await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], [LABEL_READY], "retry");
  }
  return decision;
}

/**
 * Dispatch ONE lifecycle point from a site that lives outside the processIssue
 * closure (recovery routing, reconcile bracketing). Resolves the hook list from
 * the injected config each call (pure + cheap) and returns the full dispatch
 * result so a mutable point can read its stdout-JSON override back. Never throws
 * — a recovery hook must not be able to wedge the recovery path.
 */
async function fireRecoveryHook(
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

/**
 * Parse a mutable `on_recovery_decision` hook's stdout JSON for a
 * `decision` override. Returns the validated decision, or null when the hook
 * was silent / returned an unrecognised value (→ keep the composer's decision).
 */
function parseRecoveryDecision(contextJson: string): "retry" | "escalate" | null {
  try {
    const parsed: unknown = JSON.parse(contextJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const decision = (parsed as Record<string, unknown>).decision;
    return decision === "retry" || decision === "escalate" ? decision : null;
  } catch {
    return null;
  }
}

/**
 * Parse a mutable `on_feedback_classify` hook's stdout JSON for a `class`
 * override. Returns the validated classification, or null when the hook was
 * silent / returned an unrecognised value (→ keep the computed classification).
 */
function parseFeedbackClass(contextJson: string): "infra" | "semantic" | null {
  try {
    const parsed: unknown = JSON.parse(contextJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const cls = (parsed as Record<string, unknown>).class;
    return cls === "infra" || cls === "semantic" ? cls : null;
  } catch {
    return null;
  }
}

function resolveGoVerifyRetries(deps: ProcessIssueDeps): number {
  const raw = deps.recoveryEnv?.RED_GO_VERIFY_RETRIES;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  if (deps.goVerifyRetries !== undefined && Number.isInteger(deps.goVerifyRetries) && deps.goVerifyRetries >= 0) {
    return deps.goVerifyRetries;
  }
  return DEFAULT_GO_VERIFY_RETRIES;
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function appendGoVerifyRetryHandoff(
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

interface UntrustedSandboxDecision {
  sandboxMode: SandboxMode;
  authorTrusted: boolean;
  refused: boolean;
  reason?: string;
}

async function resolveUntrustedAuthorSandbox(
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
  for (const mode of candidates) {
    if (!deps.sandboxAvailable || (await deps.sandboxAvailable(mode))) {
      return { sandboxMode: mode, authorTrusted: false, refused: false };
    }
  }

  return {
    sandboxMode: configured,
    authorTrusted: false,
    refused: true,
    reason:
      `untrusted issue author ${provenance.author ? `'${provenance.author}'` : "(unknown)"} requires container isolation, ` +
      "but no docker/podman sandbox backend is available",
  };
}

async function refuseNoSandboxForUntrustedAuthor(
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
      // best-effort: card render failure is non-fatal.
    }
  }
  await deps.claimLock.release(input.issue);
  return {
    outcome: "blocked",
    issue: input.issue,
    hooksFired,
    preserved: false,
    swept: false,
  };
}

async function syncMainRedRepairIssue(
  deps: ProcessIssueDeps,
  feedback: RunFeedbackResult,
): Promise<void> {
  if (!feedback.baselineProbeRan) return;
  const {
    findMainRedRepairIssue,
    createMainRedRepairIssue,
    updateMainRedRepairIssue,
    closeMainRedRepairIssue,
  } = deps.gh;
  if (!findMainRedRepairIssue || !createMainRedRepairIssue || !updateMainRedRepairIssue || !closeMainRedRepairIssue) {
    return;
  }

  try {
    const current = await findMainRedRepairIssue();
    const plan = planMainRedRepair(feedback.baselineFailures ?? [], current);
    switch (plan.action) {
      case "noop":
        return;
      case "create": {
        const created = await createMainRedRepairIssue({
          title: plan.title,
          body: plan.body,
          labels: plan.labels,
        });
        deps.appendIterLog(`🤖 /afk baseline probe: opened main-red repair issue #${created}.`);
        return;
      }
      case "update":
        await updateMainRedRepairIssue(plan.issue, {
          title: plan.title,
          body: plan.body,
          labels: plan.labels,
        });
        deps.appendIterLog(`🤖 /afk baseline probe: updated main-red repair issue #${plan.issue}.`);
        return;
      case "close":
        await closeMainRedRepairIssue(plan.issue, plan.comment);
        deps.appendIterLog(`🤖 /afk baseline probe: closed main-red repair issue #${plan.issue}.`);
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.appendIterLog(`warn: main-red repair issue sync failed: ${message}`);
  }
}

/**
 * Run the AFK per-issue lifecycle IN ORDER, composing each pure module and
 * applying its plan through injected IO. The SEQUENCE + the label transitions +
 * the lock-toggled landing are the parity target (process_issue + SKILL.md).
 * Execution itself (worktree + agent spawn + commits) is delegated to the
 * injected sandcastle `runAgent` port (ADR 0033).
 */
export async function processIssue(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
): Promise<ProcessIssueResult> {
  const { issue } = input;
  const hooksFired: HookName[] = [];
  const startedEpoch = deps.nowEpoch();
  const resolved: ResolvedHooks = resolveHooks(deps.hooks.config, deps.hooks.resolveOptions);

  // FIX J: the env slice the pre_worktree hook chain mutates (e.g. the cargo /
  // gradle defaults inject CARGO_TARGET_DIR=.../slot-N for per-slot build
  // isolation). dispatchHooks returns the mutated context; we capture its `env`
  // here and thread it onto the runAgent input so the sandcastle-spawned agent
  // inherits it (see execution.runAgent — applied to process.env for noSandbox).
  let agentEnv: Record<string, string> | undefined;

  // Dispatch one point and return the FULL result, so a MUTABLE point (#832:
  // on_feedback_classify) can read its stdout-JSON override back. fireHook wraps
  // this for the boolean veto-only callers.
  const fireHookCtx = async (name: HookName, context: string): Promise<{ context: string; aborted: boolean }> => {
    hooksFired.push(name);
    const result = await dispatchHooks(name, resolved[name], context, deps.hooks.exec, {
      env: deps.hooks.env ?? {},
      log: (line) => deps.appendIterLog(line),
    });
    // Capture the pre_worktree env mutation (FIX J). Only this point computes the
    // mutable `env` slice the runner must inherit; other points' mutations are
    // not env-bearing, so we read it just here.
    if (name === "pre_worktree" && !result.aborted) {
      const parsed = parseHookEnv(result.context);
      if (parsed) agentEnv = parsed;
    }
    return result;
  };
  const fireHook = async (name: HookName, context: string): Promise<boolean> => {
    return !(await fireHookCtx(name, context)).aborted;
  };

  // ---- 1. claim (ADR 0066: atomic GitHub-native claim) ----
  // The host-local mkdir lock is now only a CHEAP same-host dedupe in front of
  // the real arbiter; the cross-host winner is decided by the GitHub-native
  // claim (a structured claim-comment whose server-assigned id is the total
  // order). A lost race at either layer abandons the attempt cleanly.
  if (!(await deps.claimLock.acquire(issue))) {
    return claimLost(issue, hooksFired);
  }
  // State-validity recheck: the issue must still want an agent. This is NOT the
  // contention lock (that is the claim below) — it only rejects an issue that was
  // closed/blocked/re-triaged out of ITS LANE between selection and now.
  // `running` is deliberately NOT consulted here: it is a projection, not a lock.
  //
  // Lane-aware (#1045): the recheck validates against the label the session
  // SELECTED this issue under (`input.laneLabel`, defaulting to `ready-for-agent`
  // for `/afk`), never a hardcoded `ready-for-agent`. A `lane:go`/`lane:scout`
  // issue never carries `ready-for-agent` by design, so the old hardcode fired
  // `claim-lost` on every `/go` dispatch BEFORE the claim was ever posted — the
  // silent boot death (no attempt dir, no claim comment, launcher prints
  // `1/1 (100%) exit 0`). Validating against the selecting lane fixes it while
  // leaving the `/afk` path byte-for-byte unchanged.
  const laneLabel = input.laneLabel ?? LABEL_READY;
  const labels = await deps.gh.viewLabels(issue);
  if (!labels.includes(laneLabel)) {
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }
  // Atomic GitHub-native arbitration. When `claimGh` is wired (production), this
  // is the authority that guarantees a single winner across hosts. Omitted only
  // by legacy callers/tests, which fall back to the `running` pre-check below.
  if (deps.claimGh) {
    const decision = await acquireClaim(
      deps.claimGh,
      { worker: input.claimant ?? input.workerId, runner: input.runner },
      issue,
      { isStale: deps.claimStale, deathFor: deps.recoveredWorkerDeathCause },
    );
    if (decision.verdict === "lost") {
      // acquireClaim already conceded our marker; nothing to project, next issue.
      await deps.claimLock.release(issue);
      return claimLost(issue, hooksFired);
    }
  } else if (labels.includes(LABEL_RUNNING)) {
    // Legacy lock (no claimGh): `running` present means another worker holds it.
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }

  const activeBlocker = parseCurrentBlocker(input.body);
  if (activeBlocker && !MECHANICAL_BLOCKER_KINDS.has(activeBlocker.kind)) {
    await deps.gh.ensureLabel(LABEL_SPEC);
    await editIssueLifecycleLabels(deps, issue, labels, [LABEL_READY], [LABEL_HUMAN, LABEL_SPEC], "preflight-blocked");
    await deps.gh.comment(
      issue,
      `🤖 /afk preflight stopped: active Current blocker (${activeBlocker.kind}) still requires human input: ${activeBlocker.next}`,
    );
    await deps.claimLock.release(issue);
    return {
      outcome: "blocked",
      issue,
      hooksFired,
      preserved: false,
      swept: false,
    };
  }

  // ---- trust gate (#621, ADR 0085; visibility-aware default #1101) ----
  // The "executable issue" predicate, evaluated BEFORE the promotion-to-running
  // edit and before ANY worktree/handoff work. Provenance is read from the issue
  // TIMELINE + author field (deps.gh.issueTrust), never inferred from the mutable
  // label set. The active POSTURE (folded from the allowlist config + the repo
  // visibility) decides:
  //   - STRICT (allowlist configured) → author AND promoter must be allowlisted;
  //   - FAIL-CLOSED (#1101: public repo, no allowlist) → author AND promoter must
  //     resolve as maintainers (write-access / CODEOWNERS); otherwise the issue is
  //     HELD for a maintainer summon (not auto-claimed);
  //   - PERMISSIVE (private/undeterminable repo, no allowlist) → no-op, today's
  //     single-maintainer behaviour preserved exactly.
  // A refusal releases the claim and abandons the attempt (claim-lost) with a
  // posture-tagged log line; the session loop then skips to the next candidate.
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
      await deps.claimLock.release(issue);
      return claimLost(issue, hooksFired);
    }
  }

  // ---- untrusted-author sandbox policy (#1112) ----
  // Source-trust is separate from the executable-issue trust gate: an issue may be
  // delegable because a maintainer summoned it, while its original author remains
  // untrusted. In that case the inner agent must never run under host-native
  // `none`; pick an available container backend or page a human before any
  // worktree/handoff/agent execution exists.
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

  // Project the `running` label, shedding any stale `blocked:*` reason in the same
  // edit (#402). `labels` was just fetched above, so we only remove labels the
  // issue actually carries — a clean promotion the adoption doctor can never flag.
  // Under ADR 0066 this is a best-effort OBSERVABILITY PROJECTION: the claim is
  // already won via the GitHub-native arbiter, so a failed label edit must not
  // abandon the attempt. Legacy callers (no `claimGh`) keep the old semantics
  // where the edit-to-running was the lock and its failure lost the claim.
  const claimRemoveLabels = [LABEL_READY, ...blockedLabelsIn(labels)];
  const promoted = await editIssueLifecycleLabels(deps, issue, labels, claimRemoveLabels, [LABEL_RUNNING], "claim");
  if (!promoted && !deps.claimGh) {
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }

  // ---- branch ref + base ----
  const slug = slugifyRef(input.title);
  const branch = buildRefFromSlug("afk", input.workerId, issue, slug);
  if (branch === null) {
    // A malformed ref refuses the iteration; restore the claim like the bash
    // "refusing malformed live branch ref" guard (return before running).
    await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], [LABEL_READY], "retry");
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }
  const base = await resolveBase(input.baseInput, deps.lookups.base);
  // ADR 0083 landing precondition (#1018): the configured Trunk (`plugins.dev.trunk`,
  // default `main`) the primary checkout tracks — distinct from the resolved `base`
  // (which may be a lock/pin branch). Both the ADR 0055 no-agent reconcile and the
  // DONE-path doLanding verify the LOCAL trunk has not diverged from `origin/<trunk>`.
  const trunk = (deps.lookups.base.configTrunk ?? "").trim() || "main";
  const startedAt = deps.nowIso();

  // ---- 2. attempt dir + state init ----
  await deps.fs.ensureAttemptDir(input.attemptDir);
  await deps.gh.comment(
    issue,
    `🤖 /afk started at \`${startedAt}\` on runner \`${input.runner}\` (worker \`${input.workerId}\`). branch: \`${branch}\``,
  );

  // ---- pre_worktree hook (after claim, before sandcastle provisions the run) ----
  if (!(await fireHook("pre_worktree", hookContext({ issue, title: input.title, target: branch, branch })))) {
    return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_worktree");
  }

  // ---- 3. handoff materialisation (the sandcastle promptFile) + heartbeat ----
  const comments = await deps.lookups.comments(issue);
  const url = await deps.lookups.issueUrl(issue);
  const priorAttemptContext = await deps.lookups.priorAttemptContext(issue);
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
    prdRef: input.prdRef,
    // Surface the operator-declared backpressure commands as the binding
    // `<merge-gate>` so the inner agent satisfies the EXACT gate the
    // orchestrator enforces after DONE, instead of bouncing as
    // blocked:validation off a narrower touched-package check (issue #849).
    mergeGateCommands: deps.backpressureCommands ?? [],
  });
  const handoffPath = `${input.attemptDir}/handoff.md`;
  await deps.fs.writeHandoff(handoffPath, handoff);
  deps.appendIterLog(formatStartedMarker(issue, startedAt));

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

  // ---- pre_attempt hook (after the prompt exists, before the run) ----
  if (
    !(await fireHook(
      "pre_attempt",
      hookContext({ issue, title: input.title, workspace: branch, runner: input.runner, attempt_n: input.attempt }),
    ))
  ) {
    return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
  }

  // ---- 4. run the inner agent on sandcastle (ADR 0033) ----
  // sandcastle creates the worktree off the host's active branch (driven to
  // `base` by the base-resolver), spawns the agent with `handoffPath` as the
  // prompt, detects the DONE/BLOCKED completion signal, and commits on `branch`.
  // Make the resolved base ref current so sandcastle forks the worker branch off
  // it (ADR 0031): the pinned/locked base becomes the branch's parent, not HEAD.
  // fetchBase runs `git fetch origin <base>` which updates the remote-tracking
  // ref (origin/main) but NOT the local branch. We therefore pass the
  // remote-tracking ref to runAgent so sandcastle's baseBranch start point
  // uses the freshly-fetched ref, not the potentially-stale local branch.
  if (deps.git.fetchBase) await deps.git.fetchBase(base);
  const baseRef = remoteTrackingBaseRef(input.remote, base);
  await deps.git.prepareFreshWorkerBranch?.({
    branch,
    baseRef,
    force: isMergeConflictRetry(priorAttemptContext),
  });
  // Pin to a sandcastle-backed runner. claude/codex/opencode (ADR 0059) +
  // claude-minimax (PRD #788) each map to a first-class provider and pass
  // through; any other value (e.g. the runner-neutral hermes, which has no
  // provider) coerces to claude so the spawn always has a real agent.
  let activeRunner: Runner = toAgentRunner(input.runner);
  let attemptN = input.attempt;
  // Anchor sandcastle at the per-attempt dir so its `.sandcastle/` (worktrees,
  // logs, .env, patches) + git ops land under .red/, never at the repo root.
  // attemptDir is always absolute (built from `${root}/.red/tmp/...`), which is
  // also why promptFile/handoffPath must stay absolute — sandcastle resolves
  // promptFile against process.cwd(), not against this cwd.
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
  };
  let validationSidecar: string[] = [];
  let lastValidationScope: ValidationScope | undefined = undefined;
  let mainRed = false;
  let currentHandoff = handoff;
  let goVerifyRetriesUsed = 0;
  let salvagedUncommittedFiles = 0;
  let salvagedUncommittedOutcome: RunAgentResult["outcome"] | undefined;
  let salvagedRunCommitCount = 0;
  // ADR 0083 §4 exit-barrier receipt (#1020). Set on the DONE path once the barrier
  // has salvage-committed + pushed the attempt branch to origin; recorded in the
  // done ProcessIssueResult + the attempt record so "was this work saved?" is
  // answerable from the record alone.
  let exitReceipt: ExitReceipt | undefined;
  // Scout mode: collect the agent's text-chunk events as the report. The
  // orchestrator posts this as a GitHub comment instead of pushing a branch.
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
    // The base sandcastle input for THIS attempt. When the intra-attempt
    // notes-loop (#924) is enabled, `runNotesLoop` re-invokes `runAgent` with
    // this input and a per-iteration `handoffContent` (base handoff + carried
    // notes) plus the optional inner-ceiling override; when disabled, it fires
    // exactly once with `handoffContent: handoff` — byte-for-byte today's call.
    const baseAgentInput: RunAgentInput = {
      runner: activeRunner,
      model: initialTier.model,
      effort: initialTier.effort,
      handoffPath,
      handoffContent: currentHandoff,
      // Structured-output rollout (ADR 0090, #932): a schema-enabled runner gets
      // the AgentOutput emit clause; others keep the text-sentinel-only protocol.
      systemPrompt: exitProtocolFor({
        runMode: input.runMode,
        structuredOutput: runnerSupportsStructuredOutput(toAgentRunner(activeRunner)),
      }),
      branch,
      base: baseRef,
      cwd: input.attemptDir,
      // Native-path liveness + ONE unified human log: point red-castle's file-log
      // at the attempt's `afk.log` (our canonical log, the one `state.log` and
      // `tail -f afk.log` reference) instead of a separate `sandcastle.log`, so the
      // setup phase red-castle narrates (worktree / sandbox / deps) lands in the
      // SAME file as the agent turns + heartbeats — no more empty log before the
      // agent streams. The structured per-event lanes (agent.log.jsonl + firehose)
      // still get every stream event via `onAgentEvent`; the plaintext `[agent]`
      // mirror is dropped (run.ts) so agent turns are not doubled in afk.log.
      logPath: `${input.attemptDir}/afk.log`,
      onAgentEvent: agentEventSink,
      // Externalized proof-of-life (PR-B): the attempt-guard poll fires this each
      // tick. processIssue owns the hook dispatcher, so it fires the `on_heartbeat`
      // user hook here (fire-and-forget) AND forwards the progress signal to the
      // CLI-wired sink (firehose record + state.last_progress_at). Never throws.
      onHeartbeat: (info) => {
        // Enrich the on_heartbeat context with the full worker vitals (ADR 0065/
        // #832) so an operator hook can build custom live alerting off the
        // tool/text/reasoning/loc/cost counters, not just the bare liveness ping.
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
      // Restore the issue #191 continuous-push guarantee: sandcastle pushes the
      // worker branch up-front + after every commit (host worktree hook), so a
      // SIGKILL mid-iteration preserves the diff on origin. Best-effort.
      remote: input.remote,
      // Scout mode disables continuous push: the branch must never reach the
      // remote. `pushAttempt` is also skipped in the scout short-circuit below.
      continuousPush: input.runMode !== "scout",
      // Goal predicate (ADR 0057): rides the attempt-guard poll — one issue-state
      // read per tick. A CLOSED claimed issue moots the attempt (the 2026-06-09
      // re-verify incident). issueClosed resolves false on a gh failure, so an
      // uncertain read is a no-op (the predicate never kills on uncertainty).
      goalProbe: () => deps.gh.issueClosed(issue),
      // FIX J: env computed by the pre_worktree hook (e.g. CARGO_TARGET_DIR per
      // slot) — runAgent applies it to the spawned agent's environment.
      env: agentEnv,
      sandboxMode: sandboxDecision.sandboxMode,
    };

    // Intra-attempt notes-loop (Track C, #924). Default OFF → `runNotesLoop`
    // fires the base input exactly once. Enabled → a bounded outer loop makes one
    // small committed change per iteration, seeds the next with an accumulated
    // `notes.md` (materialised at the attempt dir, never committed to the worker
    // branch), short-circuits on DONE, and hands the last partial run back on a
    // cap-hit so the existing salvage + landing path runs. The loop's resource
    // caps are checked BETWEEN iterations, so they never double-abort with the
    // per-call attempt guard inside `runAgent`.
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
      // Wall-clock cap reasons in ms; the attempt clock is epoch seconds.
      now: () => deps.nowEpoch() * 1000,
      // Cumulative input+output tokens for the token cap, read from the live
      // WorkerVitals (ADR 0065). Absent vitals → 0, so the cap stays inert.
      tokensSpent: () => {
        const vitals = deps.heartbeatVitals?.();
        return vitals ? (vitals.input_tokens ?? 0) + (vitals.output_tokens ?? 0) : 0;
      },
      log: (message) => deps.appendIterLog(message),
    });
    let run: RunAgentResult = notesOutcome.run;

    // ---- runner-fallback subsystem (--fallback-runner / runner failure) ----
    // The active runner signalled quota / rate-limit exhaustion OR a transient
    // runner transport/setup failure (for example Codex websocket 502 /
    // thread-start). Without --fallback-runner the runner failure is terminal
    // through bounded recovery. With it, close this runner's cycle, swap to the
    // other runner, fire pre_attempt again (the per-runner-invocation cadence,
    // #226 / ADR 0026), and re-run once. A second runner failure is terminal.
    if (isRunnerRecoverableOutcome(run.outcome)) {
      if (!deps.fallbackRunner) {
        return await runnerRecoverable(deps, input, branch, base, hooksFired, activeRunner, run.outcome, false);
      }
      // Close attempt N's cycle before swapping.
      await fireHook("post_attempt", postAttemptContext({ ...input, attempt: attemptN }, branch, "fail", run.outcome));
      const other: Runner = activeRunner === "claude" ? "codex" : "claude";
      activeRunner = other;
      attemptN += 1;
      // pre_attempt fires again for the fresh runner invocation (second firing).
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
        }),
        branch,
        base,
        cwd: input.attemptDir,
        logPath: `${input.attemptDir}/afk.log`,
        onAgentEvent: agentEventSink,
        remote: input.remote,
        continuousPush: input.runMode !== "scout",
        // Goal predicate rides the fallback attempt's guard poll too (ADR 0057).
        goalProbe: () => deps.gh.issueClosed(issue),
        // FIX J: carry the pre_worktree env onto the fallback runner too.
        env: agentEnv,
        sandboxMode: sandboxDecision.sandboxMode,
      });
      if (isRunnerRecoverableOutcome(run.outcome)) {
        // Both runner invocations failed in a recoverable runner class → close the
        // fallback attempt's cycle, then terminate through the bounded policy.
        await fireHook("post_attempt", postAttemptContext({ ...input, attempt: attemptN }, branch, "fail", run.outcome));
        return await runnerRecoverable(deps, input, branch, base, hooksFired, activeRunner, run.outcome, true);
      }
    }

    // The worker branch sandcastle landed commits on is authoritative.
    workerBranch = run.branch || branch;
    // The effective per-attempt identity after any fallback swap — the remaining
    // hook contexts / envelopes label themselves with the runner that actually
    // authored the exit and the attempt number it ran under.
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

    // ---- commit-leftovers salvage (codex DONE/partial-commit leftovers, ADR 0050) ----
    // The inner agent (observed: codex) can edit, pass the gates, and emit
    // `<promise>DONE</promise>` without committing every dirty path. This includes
    // the original zero-commit bug and the partial-commit variant: sandcastle
    // reports at least one commit, but useful edits remain unstaged/uncommitted.
    // After any done/no-sentinel outcome, ask the salvage port to commit leftover
    // dirty worktree paths onto the worker branch (one commit per file) so the
    // SAME feedback gate + landing tail validate and merge the complete work. A
    // clean worktree salvages nothing (count 0).
    // ADR 0083 §4 exit barrier (DONE tracer, #1020): on the DONE path, obtain the
    // attempt's exit through the single barrier — salvage-commit any dirty worktree
    // paths, push the branch to origin (retry once), and produce an auditable
    // receipt. "Work is saved iff its branch ref is pushed to origin"; a push
    // failure after retry throws ExitBarrierError and routes to a NON-clean
    // terminal (the attempt is never reported done without a receipt). The legacy
    // salvage-only step below still covers the other salvageable outcomes
    // (no-sentinel / budget-exceeded), whose barrier wiring is the follow-up slice.
    if (deps.exitBarrier && run.outcome === "done") {
      try {
        exitReceipt = await deps.exitBarrier(workerBranch);
      } catch (err) {
        if (err instanceof ExitBarrierError) {
          // The barrier could not push the attempt branch to origin after its
          // retry — "work is saved iff its branch ref is pushed" is NOT satisfied,
          // so the attempt must NOT be reported as cleanly done. Route to the
          // recoverable merge-conflict terminal (branch preserved, bounded retry
          // re-pushes next run) with a receipt-absent reason in the envelope.
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
    } else if (
      deps.salvageUncommitted &&
      (run.outcome === "done" || run.outcome === "no-sentinel" || run.outcome === "budget-exceeded")
    ) {
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

    // ---- no-sentinel: the run ended without an AFK sentinel (ADR 0028) ----
    // ADR 0028 keeps `<promise>` canonical: a missing sentinel is a CRASH signal,
    // not a "nothing to do" signal. But a worker branch can already carry a COMPLETE
    // commit from a prior iteration — the agent finished the work, then exited
    // without re-emitting the sentinel (issue #332; the live #300 loop: done at
    // iteration 1, re-invoked to 4/20, never closed). Abandoning such a branch never
    // converges. So we SALVAGE a no-sentinel attempt IFF its branch is ahead of base
    // AND present on the host — but only THROUGH the same feedback gate + landing
    // tail the DONE path uses. The feedback gate is load-bearing: it is the only
    // thing that distinguishes "complete prior work" from a half-baked crash-edit.
    // A branch with no work keeps today's terminal `no-sentinel` behaviour.
    // ---- budget guard fired (#908): the attempt breached a resource ceiling ----
    // The salvage pass above already committed any dirty worktree paths onto the
    // worker branch, so the partial work is preserved on the branch/PR ("never
    // wake up empty-handed"). Park it for a human with `blocked:budget`: a runaway
    // is NOT auto-retried (recoveryReasonFor → null), and re-running the inner
    // agent would just re-spend the budget. The salvaged commits stay on the
    // branch for the human to review, continue with a larger budget, or stop.
    if (run.outcome === "budget-exceeded") {
      await fireHook("on_attempt_error", onErrorContext(current, workerBranch, "budget-exceeded", current.attempt));
      return await terminalFailure(common, "budget-exceeded", "budget", {
        notes:
          salvagedUncommittedFiles > 0
            ? `_(budget guard aborted the attempt; salvaged ${salvagedUncommittedFiles} uncommitted file(s) onto \`${workerBranch}\` — partial work preserved for review)_`
            : "_(budget guard aborted the attempt; no uncommitted work to salvage)_",
        log: run.stdout || "afk: attempt aborted — per-attempt resource budget exceeded (#908)",
      });
    }
    let salvaged = false;
    if (run.outcome === "no-sentinel") {
      const branchHasWork =
        // Scout runs read-only — the inner agent never commits, so there is
        // nothing to salvage. Always treat no-sentinel as a hard failure.
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
      // Salvage path: the branch is ahead of base and present. Treat the attempt as
      // a success for hook purposes (we are about to LAND it, not error it) and fall
      // through to the shared feedback + land + close tail. `on_attempt_error` is NOT
      // fired — a salvaged-and-landed attempt is not an error.
      salvaged = true;
      deps.appendIterLog(
        `🤖 /afk: no-sentinel exit but worker branch \`${workerBranch}\` carries work — salvaging through the feedback gate (issue #332).`,
      );
      await fireHook("post_attempt", postAttemptContext(current, workerBranch, "success", "no-sentinel"));
    } else if (run.outcome === "goal-moot") {
      // ---- goal predicate fired (ADR 0057): the claimed issue is already CLOSED ----
      // The attempt's goal is already reflected in the world (the 2026-06-09
      // re-verify incident). Terminate deterministically WITHOUT a terminal
      // envelope — at most ONE concise local record, so the issue thread stays
      // readable. Map the moot attempt with the pure predicate: own-merge close →
      // `done`; foreign close → `claim-lost`. The own-merge signal is best-effort
      // (an absent lookup or any failure degrades to `claim-lost`, never falsely
      // claiming credit).
      const ownMerge = deps.lookups.branchMerged
        ? await deps.lookups.branchMerged(workerBranch, base).catch(() => false)
        : false;
      const verdict = evaluateGoalPredicate({ closed: true, ownMerge });
      const outcome: ProcessOutcome = verdict === "done" ? "done" : "claim-lost";
      // Close the per-attempt lifecycle symmetrically (the pre_attempt hook fired
      // at claim). No on_attempt_error — a mooted attempt is not a crash.
      await fireHook(
        "post_attempt",
        postAttemptContext(current, workerBranch, verdict === "done" ? "success" : "fail", "goal-moot"),
      );
      deps.appendIterLog(
        verdict === "done"
          ? `🤖 /afk #${issue}: goal predicate — issue already CLOSED by this attempt's own merge; nothing to land (done).`
          : `🤖 /afk #${issue}: goal predicate — issue already CLOSED by another lander; attempt mooted (claim-lost).`,
      );
      // Best-effort hygiene: drop our now-stale `running` label so a CLOSED issue
      // is never left tagged running. The foreign lander typically already shed it.
      try {
        await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
      } catch {
        // best-effort: a label failure on an already-closed issue is cosmetic.
      }
      await deps.claimLock.release(issue);
      return {
        outcome,
        issue,
        branch: workerBranch,
        base,
        hooksFired,
        preserved: false,
        swept: false,
      };
    } else if (run.outcome === "timeout") {
      // ---- attempt progress guard fired: alive but no new commit within the cap. ----
      // on_attempt_timeout (#832): the commit-anchored progress guard (ADR 0044/
      // 0045) just fired. Announce it before the no-agent reconcile / escalation
      // routing decides what to do with the parked branch.
      await fireHook(
        "on_attempt_timeout",
        hookContext({
          issue,
          title: input.title,
          workspace: branch,
          runner: activeRunner,
          attempt_n: attemptN,
          reason: "timeout",
        }),
      );
      // Before escalating, try the ADR 0055 NO-AGENT reconcile: a stalled attempt
      // frequently carries a COMPLETE, green branch — the agent finished the work
      // but stalled before a final non-committing step, so the guard fired on a
      // landable branch. reconcile validates the pushed branch through the SAME
      // scoped gate the DONE path uses and lands it WITHOUT re-running the agent
      // (the agent re-run stays recovery.ts). Mechanical class only; the land
      // path's drift-guard + integrate/rebase catch any cross-package breakage.
      // (The sibling no-sentinel-WITH-commits case is already reconciled by the
      // salvage-through-feedback path above, which lands an ahead-of-base branch
      // through the identical gate.)
      const reconciled = await reconcile(
        { ...deps, fireHook },
        reconcileInputFor(input, current, workerBranch, base, trunk, labels, activeRunner),
      );
      // on_reconcile (#832): the no-agent reconcile (ADR 0055) re-validated the
      // parked mechanical branch and landed / parked / skipped it. Surface the
      // outcome so an operator can track auto-landings without re-running the agent.
      await fireHook(
        "on_reconcile",
        hookContext({
          issue,
          title: input.title,
          workspace: branch,
          attempt_n: attemptN,
          outcome: reconciled.outcome,
        }),
      );
      if (reconciled.outcome === "landed") {
        // reconcile already closed the issue, dropped labels, deleted the remote
        // branch, swept the attempt dir + ran the close cascade — only the claim
        // lock (which AFK, not reconcile, owns) remains to release.
        await deps.claimLock.release(issue);
        return {
          outcome: "done",
          issue,
          branch: workerBranch,
          base,
          locked: reconciled.locked,
          mergeSha: reconciled.mergeSha,
          hooksFired,
          envelopePosted: reconciled.posted,
          preserved: true,
          swept: true,
        };
      }
      if (reconciled.outcome === "parked") {
        await deps.claimLock.release(issue);
        return {
          outcome: "feedback-failed",
          issue,
          branch: workerBranch,
          base,
          hooksFired,
          envelopePosted: reconciled.posted,
          preserved: true,
          swept: false,
        };
      }
      // skipped (not mechanical / no commits / branch absent) → fall through to
      // the original stalled escalation: park to ready-for-human (blocked:stalled),
      // preserving the pushed branch/PR — never auto-retry (recoveryReasonFor
      // ("stalled") = null → always escalate).
      await fireHook("on_attempt_error", onErrorContext(current, workerBranch, "stalled", current.attempt));
      return await terminalFailure(common, "stalled", "stalled", {
        notes: "_(no Notes appended; attempt aborted — inner agent made no progress within the wall-clock guard)_",
        log: run.stdout || "(attempt progress guard fired)",
      });
    } else {
      // ---- post_attempt hook (terminal invocation; sentinel-bearing) ----
      const pwStatus = run.outcome === "done" ? "success" : "fail";
      await fireHook("post_attempt", postAttemptContext(current, workerBranch, pwStatus, run.outcome));

      // ---- BLOCKED ----
      if (run.outcome === "blocked") {
        return await terminalFailure(common, "blocked", "blocked", {
          notes: `_(inner agent emitted BLOCKED — see iteration log at \`${input.attemptDir}\`)_`,
        });
      }
      // run.outcome === "done" → fall through to the shared land + close tail.
    }

    // ---- Scout mode: read-only terminal path ----
    // The agent emitted DONE (or was salvaged) in read-only mode. Instead of
    // the push / feedback / landing pipeline, post the collected text-chunk
    // output as a report comment and close the disposable issue. No branch is
    // ever pushed to the remote; the worktree was ephemeral.
    if (input.runMode === "scout") {
      const report = scoutTextChunks.join("").trim() ||
        "_Scout completed without output. Check the attempt log for details._";
      await deps.gh.comment(issue, `## 🔍 Scout Report\n\n${report}`);
      await deps.gh.close(issue);
      await deps.claimLock.release(issue);
      return {
        outcome: "done",
        issue,
        hooksFired,
        preserved: false,
        swept: false,
      };
    }

    // run.outcome === "done" OR a salvaged no-sentinel branch: shared feedback +
    // land + close tail (the salvage path lands exactly like a DONE attempt).

    // ---- 5a. worker-branch presence gate (FIX E) ----
    // changedFiles() does `git diff base...branch`, which returns [] on a MISSING
    // branch (code 0) — indistinguishable from "no changes". If sandcastle's commits
    // never reached the host (push failed), feedback would run against an EMPTY
    // changed-file set → no validation scopes → the merge gate is bypassed on
    // unvalidated work. Confirm the branch exists (the lookup attempts one fetch
    // first); if it is still absent, do NOT proceed to feedback/merge — route to the
    // merge-conflict / ready-for-human terminal path with a clear reason.
    if (deps.lookups.branchPresent && !(await deps.lookups.branchPresent(workerBranch))) {
      deps.appendIterLog(
        `🤖 /afk: worker branch \`${workerBranch}\` absent on host — sandcastle commits did not reach the host; escalating.`,
      );
      return await mergeFailed(common, "worker branch absent — sandcastle commits did not reach the host");
    }

    // ---- 5a'. post_attempt_format (pre-feedback mutating step, #1015) ----
    // After the agent's commits and before the feedback gate, run any
    // operator-declared `afk.post_attempt_format` commands in the worker-branch
    // checkout. If a command exits 0 and leaves the checkout dirty, the executor
    // stages + commits (`style: <cmd>`) + pushes the delta so the feedback gate
    // sees a cleanly-formatted branch. A non-zero exit aborts (branch preserved
    // for manual recovery via abortAfterClaim — same recovery policy as pre_*
    // hooks). Absent executor or empty command list → no-op.
    const postAttemptFormatCommands = deps.postAttemptFormatCommands ?? [];
    if (deps.postAttemptFormat && postAttemptFormatCommands.length > 0) {
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

    // ---- 5b. feedback loops (the merge gate, ADR 0008) ----
    // Feedback runs against a checkout of the returned worker branch; the injected
    // pnpm/layout execs resolve `workerBranch` to a concrete path in the CLI.
    // AFK runner improvement: pass `base` as the `baselineWorktree` so a failure
    // that ALSO fails on the base branch (pre-existing flake, not the worker's
    // fault — the #791/#792/#793/#794 cause) is downgraded to `skipped` instead
    // of parking a green branch. The baseline probe only runs on failure, so the
    // happy path costs nothing.
    // Macro phase → `validating` (issue #811): the feedback gate is starting.
    deps.markPhase?.("validating");
    const changedFiles = await deps.lookups.changedFiles(workerBranch, baseRef);
    // Compute the validation scope: expand to the full dependency cone when a
    // workspace graph is injected, otherwise keep the directly-touched package
    // cone. Root-config and explicit core-module changes always escalate to
    // whole-workspace before any package scoping.
    const validationScope = computeValidationScope(
      changedFiles,
      deps.layout,
      deps.graph ?? { packages: [] },
    );
    const feedbackScopes = scopesForValidationScope(validationScope);
    // pre_feedback (#832): a pre_* gate around the scope-derived feedback run — a
    // non-zero exit VETOES validation and routes the attempt to the abort-after-
    // claim terminal (the branch/PR is preserved, the issue returns to the queue).
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
    });
    // on_baseline_probe (#832): the "already failing on main?" probe (ADR 0071)
    // runs ONLY when the gate failed AND a baseline worktree was supplied. Report
    // whether it downgraded any pre-existing-on-baseline failures.
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
    await syncMainRedRepairIssue(deps, feedback);
    // post_feedback (#832): the scope-derived gate has produced its verdict.
    await fireHook(
      "post_feedback",
      hookContext({
        issue,
        title: input.title,
        workspace: branch,
        result: { status: feedback.ok ? "pass" : "fail" },
      }),
    );
    if (!feedback.ok) {
      // The feedback-failed path also has a structured sidecar — persist it for
      // Memory (best-effort) just like the done path does.
      await writeValidationSidecar(deps, input.attemptDir, feedback.sidecar);
      // AFK runner improvement: classify the failure before choosing the outcome.
      // An INFRA root cause (worktree add / submodule init / pnpm install / OOM /
      // ENOENT — see `isInfraFeedbackFailure`) routes through the `validation-infra`
      // recovery policy (bounded retry, default cap 2) so a flake self-heals; a
      // SEMANTIC failure (the worker's code really has a problem) still pages a
      // human. The simple→complex escalation only helps for SEMANTIC failures —
      // bumping the tier can't fix a broken submodule, so it would just burn a
      // retry for nothing.
      let isInfra = isInfraFeedbackFailure(feedback);
      // on_feedback_classify (#832, MUTABLE): hand the INFRA-vs-SEMANTIC verdict
      // (ADR 0071) to a hook, which may override it via a `{"class":…}` stdout
      // JSON. An operator that knows a given failure shape is really infra (or
      // really the worker's fault) can steer the recovery policy this way.
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

    // ---- 5c. backpressure gate (the operator-declared merge gate, #430/PRD #429) ----
    // After the scope-derived feedback gate passes, run the operator's
    // `afk.backpressure` commands in order against the same worker-branch checkout.
    // Backpressure SUPPLEMENTS feedback (it never replaces it). Any command exiting
    // non-zero blocks the merge and parks the issue to ready-for-human EXACTLY like
    // a feedback failure (same `feedback-failed` outcome → blocked:validation): its
    // records distinguish it by their `backpressure:<cmd>` names + failing-command
    // output. An absent executor or an empty command list is a no-op.
    const backpressureCommands = deps.backpressureCommands ?? [];
    let backpressureSidecar: string[] = [];
    if (deps.backpressure && backpressureCommands.length > 0) {
      const backpressure = await runBackpressure(deps.backpressure, {
        worktree: workerBranch,
        commands: backpressureCommands,
        now: deps.nowEpoch,
      });
      backpressureSidecar = backpressure.sidecar;
      if (!backpressure.ok) {
        // Persist BOTH gates' records (feedback passed, backpressure failed) for
        // Memory, but surface only the failing backpressure records in the envelope.
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
    // Both gates passed — the close path's sidecar/envelope carries their union.
    validationSidecar = [...feedback.sidecar, ...backpressureSidecar];
    lastValidationScope = feedback.validationScope;
    break;
  }

  // ---- 6. push the worker branch, integrate, then land per the flag ----
  // The entire flag-toggled landing (push → pre_merge → integrate → land →
  // direct conflict self-resolve → post_merge) is owned by doLanding (landing.ts,
  // ADR 0030 amended by #842 / 0031). A non-ok result maps to the merge-conflict
  // terminal-failure path; on success the FINAL merge sha is read below (post
  // post_merge), exactly as before, to drive the done close.
  //
  // Landing MODE is decoupled from the lock (#842): the lock only resolved `base`
  // (above); `afk.worktree_launches_pull_request` (default true) decides PR vs
  // direct merge. `locked` is still read for the result's observability echo.
  const locked = await deps.lookups.isLocked();
  const openPr = deps.worktreeLaunchesPr !== false;

  // ---- 6a0. per-issue MANUAL-LANDING mode (landing:manual, issue #1049) ----
  // A `landing:manual` issue ran the full normal pipeline up to here; now it must
  // STOP before any merge. Open the PR (no merge, no review label) and park the
  // issue `ready-for-human` with the PR link — exactly the `blocked:ci` shape (PR
  // left open, agent never re-runs, a human drives the final merge click). This
  // takes precedence over the review gate and applies regardless of the landing
  // MODE flag: manual landing inherently needs a PR for the human to merge, so it
  // opens one even when `afk.worktree_launches_pull_request` is false.
  if (labels.includes(LABEL_LANDING_MANUAL)) {
    return await handoffForManualLanding(common, base, validationSidecar);
  }

  // ---- 6a. PR review gate (ADR 0064 §10, #749) ----
  // When a PR is opened (openPr), a NON-mechanical change is handed off for a
  // fresh-agent review instead of fast-merged: open the PR, apply the review label
  // (firing the advisory review from #746), and park the issue for the review→merge
  // flow. Mechanical/trivial work — and the direct (non-PR) path, which never opens
  // a PR — keep the existing fast-merge path untouched.
  if (openPr && deps.reviewGate && shouldRequestReview(activeTaskClass, deps.reviewGate)) {
    return await handoffForReview(common, activeTaskClass, validationSidecar);
  }

  // Macro phase → `merging` (issue #811): the lock-toggled landing is starting.
  deps.markPhase?.("merging");
  const landing = await doLanding(
    {
      mergeExec: deps.mergeExec,
      remoteGit: deps.remoteGit,
      fireHook,
      conflictResolver: deps.conflictResolver,
      waitForReview: deps.waitForReview,
      ciAwait: deps.ciAwait,
      findMainRedRepairIssue: deps.gh.findMainRedRepairIssue,
      makeLandingWorktree: deps.makeLandingWorktree,
      removeLandingWorktree: deps.removeLandingWorktree,
      makeRebaseWorktree: deps.makeRebaseWorktree,
      removeRebaseWorktree: deps.removeRebaseWorktree,
      // Sensitive-path guard (issue #1102): diff the worker branch against the
      // resolved base before landing. Uses three-dot notation so the diff reflects
      // only what this branch changed, not the entire base history.
      getDiffPaths: async () => {
        const filesRes = await deps.mergeExec([
          "git", "-C", input.repoDir,
          "diff", "--name-only",
          `${input.remote}/${base}...${workerBranch}`,
        ]);
        const changedFiles = filesRes.stdout.trim().split("\n").filter(Boolean);
        const diffRes = await deps.mergeExec([
          "git", "-C", input.repoDir,
          "diff",
          `${input.remote}/${base}...${workerBranch}`,
          "--",
          "package.json", "**/package.json",
        ]);
        return { changedFiles, packageJsonDiff: diffRes.stdout };
      },
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
      mainRed,
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
    // ADR 0083 landing precondition (#1018): the primary checkout's LOCAL trunk
    // has DIVERGED from origin/<trunk>. The landing aborted BEFORE integrating the
    // attempt branch and never repaired the divergence — park ready-for-human with
    // a divergence envelope naming both SHAs so a human reconciles the local state.
    if (landing.reason === "trunk-diverged") {
      return await trunkDivergedBlocked(
        common,
        trunk,
        landing.localTrunkSha ?? "",
        landing.originTrunkSha ?? "",
        landing.locked,
      );
    }
    // Sensitive-path guard (issue #1102): the diff touched a CI workflow,
    // lifecycle script, git hook, or .red/ config — pages a human, never retries.
    if (landing.reason === "sensitive-paths") {
      return await sensitivePathGuarded(common, landing.sensitivePaths ?? [], landing.locked);
    }
    if (landing.reason === "main-red-untracked") {
      return await mainRedUntrackedBlocked(
        common,
        landing.message ?? "Admin-merge refused: main is red without an open main-red repair issue.",
        landing.locked,
      );
    }
    // CI-aware landing failures (#812): a completed, MERGEABLE PR the admin-merge
    // could not land because the `enforce_admins` base's required checks failed /
    // are still pending. NOT a merge conflict — preserve the OPEN PR and park to
    // ready-for-human with `blocked:ci` rather than re-running the whole agent.
    if (landing.reason === "ci-failed" || landing.reason === "ci-pending") {
      return await ciBlocked(common, landing.reason, landing.prNumber);
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
    return await mergeFailed(common, landing.reason, landing.locked);
  }

  // ---- 7. close: envelope(done) → gh close + remove running → delete remote ----
  // The locked landing runs in an isolated worktree (#572) so the primary HEAD no
  // longer advances — prefer the merge sha doLanding captured there, falling back
  // to the primary HEAD for the unlocked path (which best-effort fast-forwards it).
  const mergeSha = landing.mergeSha ?? (await deps.git.headShortSha());
  const durationS = deps.nowEpoch() - startedEpoch;
  // Write the machine-readable validation sidecar ($ITER_DIR/validation.jsonl,
  // SKILL.md) the Memory bridge consumes. Best-effort: never fails the close.
  await writeValidationSidecar(deps, input.attemptDir, validationSidecar);
  const posted = await emitDone(common, mergeSha, durationS, validationSidecar, lastValidationScope);
  // ADR 0017: record the reasoning attempt into Memory AFTER the terminal
  // (done) envelope. Best-effort, gated, no-op when memory is absent. The ADR 0083
  // §4 exit-barrier receipt (#1020), when present, rides the attempt record so the
  // auditable "work reached origin" proof is preserved with the reasoning attempt.
  await recordAttemptBestEffort(common, "done", {
    durationS,
    mergeSha,
    validationSummary: validationSidecar.join("\n"),
    notes: exitReceipt
      ? `exit-barrier receipt: branch \`${exitReceipt.branch}\` pushed to origin at ${exitReceipt.pushedAt} (head ${exitReceipt.head || "?"}, salvaged ${exitReceipt.salvagedFiles} file(s)).`
      : undefined,
  });
  await deps.gh.close(issue);
  await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
  await deleteRemote(deps.remoteGit, input.repoDir, workerBranch);

  // ---- 8. cleanup (local branch) + completion sweep ----
  await deps.git.deleteLocalBranch(workerBranch);
  await deps.fs.completionSweep(issue);
  await deps.claimLock.release(issue);
  markTerminalState(deps, "done");

  // ---- 9. close cascade (event-driven auto-unblock) ----
  // Issue N just closed; re-evaluate every open issue carrying `req:N`. Any
  // whose `req:*` deps are now ALL closed sheds `blocked:dependency`, gains
  // `ready-for-agent`, and gets an audit comment. Best-effort: a gh failure logs
  // a warn and never fails the close — the boot Unblock Sweep catches it next
  // run.
  await runCloseCascade(deps, issue);

  // ---- 10. PRD cascade rebase (keep sibling branches fresh) ----
  // After landing, rebase every open sibling branch (same prd:N, not held by
  // a live worker) onto the new base HEAD so the next worker to pick up a
  // sibling starts from a near-current base. Best-effort: per-branch failures
  // are logged as warnings and never roll back the primary landing.
  // `labels` was fetched at claim time (step 1) and carries the prd:N labels.
  await runCascadeRebase(deps, input, issue, base, labels);

  return {
    outcome: "done",
    issue,
    branch: workerBranch,
    base,
    locked,
    mergeSha,
    hooksFired,
    envelopePosted: posted,
    exitReceipt,
    preserved: true,
    swept: true,
  };
}

// ---------- validation sidecar ($ITER_DIR/validation.jsonl) ----------

/**
 * Write the machine-readable validation sidecar (`$ITER_DIR/validation.jsonl`,
 * SKILL.md §Validation Sidecar) — one `red.afk.validation.v1` record per line.
 * The native path BUILDS these records (`feedback.sidecar`) but never wrote them
 * to disk; this restores that write. ENTIRELY best-effort: the port is optional
 * (older callers/tests skip it), an empty sidecar writes nothing, and ANY throw
 * is swallowed so the sidecar write can never fail the close.
 */
async function writeValidationSidecar(
  deps: ProcessIssueDeps,
  attemptDir: string,
  lines: string[],
): Promise<void> {
  if (!deps.fs.writeValidationSidecar) return;
  if (lines.length === 0) return;
  try {
    await deps.fs.writeValidationSidecar(`${attemptDir}/validation.jsonl`, lines);
  } catch {
    // best-effort: the sidecar is an optimisation for Memory; never fail close.
  }
}

// ---------- AFK→Memory reasoning-attempt recording (ADR 0017) ----------

/**
 * Fire the best-effort Memory "reasoning attempt" recording (ADR 0017) AFTER a
 * terminal envelope was emitted. Builds the payload from the AFK-side context
 * and hands it to the injected `recordAttempt` port. ENTIRELY best-effort and
 * defensive: when the port is absent it is a no-op, and ANY throw from the port
 * is swallowed (logged once to the iteration log) so a memory failure can never
 * fail the close. ADR 0009: dev only soft-uses memory.
 */
async function recordAttemptBestEffort(
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

// ---------- shared per-stage context ----------

interface StageCommon {
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
}

/** Emit a failure-family envelope (blocked / no-sentinel / merge-conflict /
 * feedback), composing envelope-emit. Returns the posted flag. */
async function emitFailure(
  c: StageCommon,
  status: AttemptStatus,
  diffLabel: string,
  sections: SectionBodies,
): Promise<boolean> {
  const { deps, input } = c;
  const remoteName = buildRefFromSlug("afk-attempts", input.workerId, input.issue, c.slug) ?? "";
  const durationS = deps.nowEpoch() - c.startedEpoch;
  const result = await emitEnvelope(deps.envelope, {
    status,
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: c.branch,
    attempt: input.attempt,
    diff: diffLabel,
    remoteName,
    repo: input.repo,
    repoDir: input.repoDir,
    worktreeRel: input.attemptDir,
    diffstat: "",
    sections,
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner },
  });
  return result.posted;
}

function oneLine(value: string | undefined, fallback: string): string {
  const line = (value ?? "")
    .split("\n")
    .map((part) => part.replace(/^[-*]\s*(?:\[[^\]]+\]\s*)?/, "").replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  return line ?? fallback;
}

function blockerForFailure(outcome: ProcessOutcome, sections: SectionBodies): CurrentBlocker | null {
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
    case "main-red-untracked":
      return {
        status: "blocked",
        kind: "main-red-untracked",
        summary: oneLine(sections.log, "Admin-merge refused because main is red without an open main-red repair issue."),
        next: "Restore or create the auto-filed main-red repair issue, then requeue.",
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

const ACTIONABLE_BLOCKER_KINDS = new Set([
  "spec",
  "validation",
  "merge-conflict",
  "ci",
  "stalled",
  "decision",
  "trunk-diverged",
  "sensitive-path",
  "main-red-untracked",
]);

function shouldPreserveCurrentBlocker(existing: CurrentBlocker | null, next: CurrentBlocker): boolean {
  if (!existing) return false;
  if (next.kind !== "runner") return false;
  return ACTIONABLE_BLOCKER_KINDS.has(existing.kind);
}

async function writeCurrentBlockerBestEffort(
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
    // Best-effort: issue-body state improves resumability, but label routing and
    // the failure envelope remain the canonical fallback if the edit fails.
  }
}

/**
 * Cross the ADR 0083 §4 exit barrier for a FAILURE terminal (#1021): salvage-commit
 * any dirty worktree paths + push the attempt branch to origin, returning the
 * auditable {@link TerminalReceipt} every preserved terminal reports with. NEVER
 * throws — a failing attempt is already terminal, so a barrier fault or a rejected
 * push degrades to a not-pushed receipt (`pushed:false`) rather than escalating
 * into a second failure. When no barrier port is wired (legacy caller) it returns
 * the same not-pushed receipt so {@link preservedTerminal} always has its required
 * receipt input — the branch state is simply reported as unconfirmed.
 */
async function crossTerminalBarrier(deps: ProcessIssueDeps, branch: string): Promise<TerminalReceipt> {
  if (deps.terminalExitBarrier) {
    try {
      return await deps.terminalExitBarrier(branch);
    } catch {
      // The barrier port itself faulted — fall through to the not-pushed receipt.
      // The terminal still reports; the branch simply is not confirmed on origin.
    }
  }
  return { branch, head: "", pushedAt: new Date().toISOString(), salvaged: false, salvagedFiles: 0, pushed: false };
}

/**
 * Build a PRESERVED terminal {@link ProcessIssueResult}. The exit-barrier receipt
 * is a MANDATORY first argument (ADR 0083 §4, #1021): a preserved terminal is
 * reported iff its branch crossed the barrier, and the only way to obtain a
 * {@link TerminalReceipt} is {@link crossTerminalBarrier} — so a terminal that
 * reports a preserved status without first crossing the barrier is not
 * representable. Every preserved-terminal tail funnels its result shape through
 * here so the `preserved:true` / `swept:false` / `exitReceipt` invariant is owned
 * in one place.
 */
function preservedTerminal(
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

/**
 * The uniform terminal-FAILURE tail shared by no-sentinel, blocked, feedback,
 * and merge-conflict: route the BOUNDED auto-recovery labels (routeRecovery),
 * emit the failure envelope with the status derived from the outcome
 * (envelopeStatusFor — the single owner), and build the uniform preserved /
 * not-swept result. The section BODIES + the `sectionKey` (emitFailure's
 * diffLabel) stay passed-in per call site; the `outcome`, `preserved:true`,
 * `swept:false` shape is owned here. Paths whose result shape or side effects
 * differ (abortAfterClaim, exhausted, mergeFailed's extra claim release) keep
 * their own tails.
 */
async function terminalFailure(
  c: StageCommon,
  outcome: ProcessOutcome,
  sectionKey: string,
  sections: SectionBodies,
  record: { notes?: string; validationSummary?: string } = {},
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  markTerminalState(deps, outcome);
  const decision = await routeRecovery(deps, input.issue, outcome, input.attempt);
  if (decision === "escalate") {
    await writeCurrentBlockerBestEffort(deps, input, blockerForFailure(outcome, sections));
  }
  const posted = await emitFailure(c, envelopeStatusFor(outcome), sectionKey, sections);
  // ADR 0017: record the reasoning attempt into Memory AFTER the terminal
  // (failure) envelope. Best-effort, gated, no-op when memory is absent.
  await recordAttemptBestEffort(c, outcome, {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: record.notes,
    validationSummary: record.validationSummary,
  });
  // ADR 0083 §4 exit barrier (#1021): before reporting the terminal, obtain its
  // exit through the single barrier — salvage-commit any dirty worktree paths and
  // push the attempt branch to origin. This is the ONE writer for guard-abort
  // (stalled / budget) and the other salvageable failure terminals, so no path
  // strands uncommitted work ("work is saved iff its branch ref is pushed").
  const receipt = await crossTerminalBarrier(deps, c.branch);
  if (receipt.salvagedFiles > 0) {
    deps.appendIterLog(
      `🤖 /afk: exit barrier salvaged ${receipt.salvagedFiles} uncommitted file(s) onto \`${c.branch}\` and pushed to origin (${outcome} terminal; receipt head ${receipt.head || "?"}).`,
    );
  }
  // Release the per-issue claim before returning. Every other terminal path
  // (mergeFailed/exhausted/abortAfterClaim/runnerRecoverable) releases; this
  // shared tail (no-sentinel / blocked / feedback-failed / stalled) did not, so
  // a retry-routed or human-requeued issue stayed un-claimable until the live
  // worker process exited and boot's stale-claim sweep reclaimed the dir (#568).
  await deps.claimLock.release(input.issue);
  return preservedTerminal(receipt, {
    outcome,
    issue: input.issue,
    branch: c.branch,
    base: c.base,
    hooksFired: c.hooksFired,
    envelopePosted: posted,
  });
}

/** Emit the done envelope with the merge sha + validation report. The
 * `validationSidecar` is the union of the feedback gate's records and any
 * backpressure-gate records (#430). When `validationScope` is provided, a
 * human-readable scope summary is prepended to the validation section so a
 * human reading the envelope can see exactly what was tested. */
async function emitDone(
  c: StageCommon,
  mergeSha: string,
  durationS: number,
  validationSidecar: string[],
  validationScope?: ValidationScope,
): Promise<boolean> {
  const { deps, input } = c;
  const scopeHeader = validationScope ? `${formatValidationScope(validationScope)}\n` : "";
  const result = await emitEnvelope(deps.envelope, {
    status: "done",
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: c.branch,
    attempt: input.attempt,
    mergeSha,
    diff: "merged",
    sections: { validation: `${scopeHeader}${validationSidecar.join("\n")}` },
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner, merge_sha: mergeSha },
  });
  return result.posted;
}

/** Merge-failed terminal path: emit a merge-conflict envelope, flip to
 * ready-for-human, preserve the attempt dir. Mirrors the do_merge-false branch. */
async function mergeFailed(c: StageCommon, _reason: string, locked = false): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const decision = await routeRecovery(deps, input.issue, "merge-conflict", input.attempt);
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
  // ADR 0017: record the reasoning attempt into Memory AFTER the terminal
  // (merge-conflict) envelope. Best-effort, gated, no-op when memory is absent.
  await recordAttemptBestEffort(c, "merge-conflict", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: _reason,
  });
  // ADR 0083 §4 exit barrier (#1021): cross the barrier before reporting the
  // merge-conflict terminal so the preserved branch is salvaged + on origin.
  const receipt = await crossTerminalBarrier(deps, c.branch);
  await deps.claimLock.release(input.issue);
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

/**
 * CI-aware landing handoff (#812). The completed UNLOCKED attempt produced a
 * MERGEABLE PR, but the admin-merge could not land it because the
 * `enforce_admins` base's required checks FAILED (`ci-failed`) or were still
 * PENDING past the CI-wait timeout (`ci-pending`). This is NOT a merge conflict
 * and the work is DONE and committed on the open PR — so DO NOT re-run the agent:
 * park to ready-for-human with the truthful `blocked:ci` label (routeRecovery
 * escalates because ci-* carry no recovery budget), leave the PR + worker branch
 * in place, and post a self-explanatory comment so a human / CI-aware finisher
 * drives the existing PR to merge. The attempt dir is preserved; nothing swept.
 */
async function ciBlocked(
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
  // routeRecovery escalates (ci-* map to no recovery policy → ready-for-human +
  // blocked:ci). The branch is intact, so the open PR is the durable artifact.
  await routeRecovery(deps, input.issue, outcome, input.attempt);
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
  await deps.claimLock.release(input.issue);
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

/**
 * PR landing handoff for failures that happen AFTER a PR exists. At that point
 * the durable artifact is the open PR, so re-queueing the issue would make the
 * next worker re-run the agent from scratch and often create competing work.
 * Preserve the PR/branch and park the issue for a finisher instead.
 */
async function prLandingBlocked(
  c: StageCommon,
  outcome: "ci-failed" | "merge-conflict",
  prNumber: number | undefined,
  reason: string,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const prRef = prNumber !== undefined ? `PR #${prNumber}` : "the open PR";
  await routeRecovery(deps, input.issue, outcome, input.attempt, { forceDecision: "escalate" });
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
  await deps.claimLock.release(input.issue);
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

/**
 * ADR 0083 landing-precondition park (#1018). The Landing aborted BEFORE
 * integrating the attempt branch because the primary checkout's LOCAL `<trunk>`
 * ref has DIVERGED from `origin/<trunk>` — it carries commits origin does not.
 * This is NOT a merge conflict and NOT lost work: the attempt branch is intact;
 * the maintainer-owned local repository state is out of sync. The Landing NEVER
 * repairs it (no reset / stash / auto-commit / force-push), so park the issue
 * ready-for-human with a divergence blocker envelope naming both SHAs and a
 * self-explanatory comment. routeRecovery escalates (trunk-diverged carries no
 * recovery budget → ready-for-human + `blocked:trunk-diverged`); the attempt dir
 * and worker branch are preserved so a requeue re-lands once a human reconciles.
 */
async function trunkDivergedBlocked(
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
  // routeRecovery escalates (trunk-diverged is non-recoverable): drop running,
  // ensure + add ready-for-human + blocked:trunk-diverged.
  await routeRecovery(deps, input.issue, "trunk-diverged", input.attempt);
  await writeCurrentBlockerBestEffort(deps, input, blockerForFailure("trunk-diverged", { log: detail }));
  const posted = await emitFailure(c, envelopeStatusFor("trunk-diverged"), "trunk-diverged", { log: detail });
  await deps.gh.comment(input.issue, `🤖 /afk: ${detail}`);
  await recordAttemptBestEffort(c, "trunk-diverged", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: detail,
  });
  await deps.claimLock.release(input.issue);
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
 * Sensitive-path guard park (issue #1102). The landing diff touched a CI
 * workflow file, a package.json lifecycle script, a git hook, or `.red/`
 * trust/gate configuration — an intent-class change that can never auto-land.
 * Parks the issue ready-for-human with `blocked:sensitive-path` so a human
 * reviews the change before it reaches the base branch. The attempt branch and
 * dir are preserved (the work is intact; a human can land it after review).
 * routeRecovery escalates (sensitive-path is non-recoverable): a bounded retry
 * runs the same diff and hits the same guard.
 */
async function sensitivePathGuarded(
  c: StageCommon,
  hits: Array<{ path: string; reason: string }>,
  locked: boolean,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const hitList = hits.map((h) => `\`${h.path}\` (${h.reason})`).join(", ");
  const detail =
    `Landing blocked: the diff touches sensitive path(s) that require human review before auto-landing — ` +
    `${hitList}. The attempt branch is intact. Requeue after reviewing the change.`;
  await routeRecovery(deps, input.issue, "sensitive-path", input.attempt);
  await writeCurrentBlockerBestEffort(deps, input, blockerForFailure("sensitive-path", { log: detail }));
  const posted = await emitFailure(c, envelopeStatusFor("sensitive-path"), "sensitive-path", { log: detail });
  await deps.gh.comment(input.issue, `🤖 /afk: ${detail}`);
  await recordAttemptBestEffort(c, "sensitive-path", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: detail,
  });
  await deps.claimLock.release(input.issue);
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

/**
 * Main-red tracking gate park (#1237). The feedback baseline probe says trunk is
 * red, but the auto-filed main-red repair issue is not open, so admin-merge
 * refuses before opening/merging a PR. This keeps red main visible as tracked
 * work instead of allowing silent delivery onto an untracked broken baseline.
 */
async function mainRedUntrackedBlocked(
  c: StageCommon,
  message: string,
  locked: boolean,
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const detail =
    `${message} The attempt branch is intact and validated, but landing is held until the tracked-red ` +
    `repair issue exists. Requeue after the auto-file path recreates it.`;
  await routeRecovery(deps, input.issue, "main-red-untracked", input.attempt);
  await writeCurrentBlockerBestEffort(deps, input, blockerForFailure("main-red-untracked", { log: detail }));
  const posted = await emitFailure(c, envelopeStatusFor("main-red-untracked"), "main-red-untracked", { log: detail });
  await deps.gh.comment(input.issue, `🤖 /afk: ${detail}`);
  await recordAttemptBestEffort(c, "main-red-untracked", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    notes: detail,
  });
  await deps.claimLock.release(input.issue);
  return {
    outcome: "main-red-untracked",
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
 * Review-gate handoff (ADR 0064 §10, #749). The completed UNLOCKED attempt is
 * non-mechanical, so hold the merge for a fresh-agent review: push the worker
 * branch, open (or reuse) its PR and apply the review label — which fires the
 * advisory review (#746) — then park the issue to ready-for-human for the
 * review→merge flow. The PR + worker branch are intentionally LEFT in place (the
 * review runs against them) and the attempt dir is preserved. On a PR-open/label
 * failure the issue routes through the merge-conflict park instead, so the work
 * is never silently lost.
 */
async function handoffForReview(
  c: StageCommon,
  taskClass: AfkModelTier,
  validationSidecar: string[],
): Promise<ProcessIssueResult> {
  const { deps, input } = c;
  const reviewLabel = deps.reviewGateLabel ?? LABEL_READY_FOR_REVIEW;

  // Make the worker branch's origin state certain before opening the PR — the
  // landing path's first step, reused here without the merge.
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

  // Park for the review→merge flow: drop running, add ready-for-human.
  // `review-requested` carries no typed `blocked:*` label (it is a handoff, not a
  // failure), so editLabelsTagged appends nothing extra to the routing labels.
  await editLabelsTagged(deps, input.issue, [LABEL_RUNNING], [LABEL_HUMAN], "review-requested");
  await deps.gh.comment(
    input.issue,
    `🤖 /afk: non-mechanical change (\`${taskClass}\`) — opened PR #${opened.prNumber} and applied \`${reviewLabel}\` for a fresh-agent review before merge. Holding the fast-merge per the review gate (ADR 0064 §10).`,
  );

  // ADR 0017: record the attempt into Memory (best-effort, gated, no-op absent).
  await recordAttemptBestEffort(c, "review-requested", {
    durationS: deps.nowEpoch() - c.startedEpoch,
    validationSummary: validationSidecar.join("\n"),
    notes: `review-requested: PR #${opened.prNumber} labelled ${reviewLabel}`,
  });
  await deps.claimLock.release(input.issue);

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

/**
 * Per-issue MANUAL-LANDING handoff (landing:manual, issue #1049). The completed
 * attempt passed the full pipeline (DONE, committed, feedback + backpressure
 * green), but the issue is flagged `landing:manual`: run everything EXCEPT the
 * merge. Push the worker branch, open (or reuse) its PR with `Closes #N` (no
 * merge, no review label), and park the issue `ready-for-human` with the PR URL —
 * exactly the `blocked:ci` shape (PR left open, agent never re-runs, a human
 * drives the final merge click; the issue auto-closes on merge). The terminal
 * envelope carries the PR URL and names manual landing as the park reason. The PR
 * + worker branch are intentionally LEFT in place and the attempt dir is
 * preserved. On a PR-open failure the issue routes through the merge-conflict park
 * instead, so the work is never silently lost.
 */
async function handoffForManualLanding(
  c: StageCommon,
  base: string,
  validationSidecar: string[],
): Promise<ProcessIssueResult> {
  const { deps, input } = c;

  // Make the worker branch's origin state certain before opening the PR — the
  // landing path's first step, reused here without the merge.
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

  const prRef = opened.prNumber !== undefined ? `PR #${opened.prNumber}` : "the open PR";
  const prUrl = opened.prNumber !== undefined ? `https://github.com/${input.repo}/pull/${opened.prNumber}` : undefined;
  const reason =
    `manual landing (\`landing:manual\`): the full pipeline ran and ${prRef}` +
    ` is open, but the merge is HELD for a human's final merge click`;

  // Park for the human merge: drop running, add ready-for-human. `manual-landing`
  // carries no typed `blocked:*` label (it is a handoff, not a failure), so
  // editLabelsTagged appends nothing extra to the routing labels.
  await editLabelsTagged(deps, input.issue, [LABEL_RUNNING], [LABEL_HUMAN], "manual-landing");

  // Terminal envelope: carry the PR URL + the manual-landing park reason (folds
  // into the generic `blocked` status bucket — the work is intact on the open PR).
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
  await deps.claimLock.release(input.issue);

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

// ---------- close cascade (event-driven auto-unblock) ----------

/**
 * Re-evaluate the dependents of a just-closed issue and promote any whose
 * `req:*` dependencies are now ALL closed. Fires only on the DONE close path.
 *
 * For each open issue carrying `req:<closedIssue>`, read its `req:*` labels,
 * resolve each referenced issue's closed-state (the just-closed `closedIssue`
 * is known-closed without a lookup; the rest are resolved via the injected,
 * per-cascade-cached `issueClosed` lookup), run `planCloseCascade`, and apply
 * each promotion: remove `blocked:dependency`, add `ready-for-agent`, post the
 * audit comment.
 *
 * Entirely best-effort: any thrown gh error is swallowed (logged via the
 * iteration log) so it can never fail the close — the boot Unblock Sweep is the
 * safety net that re-attempts on the next run.
 */
async function runCloseCascade(deps: ProcessIssueDeps, closedIssue: number): Promise<void> {
  try {
    const dependentsRaw = await deps.gh.listByLabel(`req:${closedIssue}`);
    if (dependentsRaw.length === 0) return;

    // Cache closed-state resolutions across the cascade (a dependent set often
    // shares deps). The just-closed issue is known-closed without a lookup.
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
      await deps.gh.comment(p.number, p.comment);
    }
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk close-cascade for #${closedIssue} failed (best-effort; boot sweep will retry): ${String(err)}`,
    );
  }
}

// ---------- PRD cascade rebase (issue #1007) ----------

const PRD_LABEL_RE = /^prd:([0-9]+)$/;
const AFK_BRANCH_RE = /^afk\/([A-Za-z0-9._-]+)\/([0-9]+)-/;

/**
 * Best-effort post-merge cascade rebase for PRD siblings (issue #1007).
 * Called after a DONE close when the issue carries a `prd:N` label. Finds every
 * open issue carrying the same `prd:N` label, locates their live `afk/*` remote
 * branches, skips any held by a live worker, and rebases the rest onto the new
 * `base` HEAD with `--force-with-lease`. A per-branch failure is logged as a
 * warning and never rolls back the primary landing.
 *
 * Guarded by `afk.landing.cascade_rebase` (default "true"): setting it to
 * "false" in the repo config restores the pre-#1007 behaviour.
 *
 * @param labels - the claim-time label set of the closed issue (already fetched).
 */
async function runCascadeRebase(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  closedIssue: number,
  base: string,
  labels: string[],
): Promise<void> {
  if (!deps.cascadeRebase) return;
  if (getConfig(deps.hooks.config, "afk.landing.cascade_rebase") === "false") return;

  try {
    // Extract prd:N numbers from the claim-time labels.
    const prdNumbers: number[] = [];
    for (const l of labels) {
      const m = PRD_LABEL_RE.exec(l);
      if (m) prdNumbers.push(Number(m[1]));
    }
    if (prdNumbers.length === 0) return;

    // Collect open sibling issue numbers (same prd:N, not the closed issue itself).
    const siblingNums = new Set<number>();
    for (const prd of prdNumbers) {
      const siblings = await deps.gh.listByLabel(`prd:${prd}`);
      for (const s of siblings) {
        if (s.number !== closedIssue) siblingNums.add(s.number);
      }
    }
    if (siblingNums.size === 0) return;

    // List remote afk/* branches and rebase those belonging to sibling issues.
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
        continue;
      }

      const r = await deps.cascadeRebase.rebaseAndPush(input.repoDir, branch, base);
      if (r.ok) {
        deps.appendIterLog(`🤖 /afk cascade-rebase: rebased ${branch} onto ${base}`);
      } else {
        deps.appendIterLog(
          `🤖 /afk cascade-rebase warning: ${r.warn ?? `failed to rebase ${branch} onto ${base}`}`,
        );
      }
    }
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk cascade-rebase for #${closedIssue} failed (best-effort): ${String(err)}`,
    );
  }
}

// ---------- claim / hook-abort short-circuits ----------

function claimLost(issue: number, hooksFired: HookName[]): ProcessIssueResult {
  return { outcome: "claim-lost", issue, hooksFired, preserved: false, swept: false };
}

/** Abort after a successful claim (a pre_* hook aborted): restore
 * ready-for-agent, release the claim, return hook-aborted. The attempt dir is
 * preserved for inspection. */
async function abortAfterClaim(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  branch: string,
  base: string,
  hooksFired: HookName[],
  _reason: string,
): Promise<ProcessIssueResult> {
  // A policy-hook abort is BOUNDED-recoverable (recovery.ts, reason "policy"):
  // retry under the cap (restore ready-for-agent) else escalate (ready-for-human
  // + the budget-exhausted comment routeRecovery posts).
  const decision = await routeRecovery(deps, input.issue, "hook-aborted", input.attempt);
  if (decision === "retry") {
    await deps.gh.comment(
      input.issue,
      `🤖 /afk aborted before runner invocation (${_reason}). Restored \`${LABEL_READY}\`.`,
    );
  }
  // ADR 0083 §4 exit barrier (#1021): a crash/teardown abort still crosses the
  // barrier — salvage-commit + push whatever the aborted attempt left on the
  // branch (e.g. a pre_worktree hook's dirty edits) so no work is stranded. The
  // branch may not yet exist on origin (nothing committed); the receipt records
  // that truthfully (`pushed:false`) rather than throwing.
  const receipt = await crossTerminalBarrier(deps, branch);
  await deps.claimLock.release(input.issue);
  return preservedTerminal(receipt, {
    outcome: "hook-aborted",
    issue: input.issue,
    branch,
    base,
    hooksFired,
  });
}

/**
 * Runner-exhaustion terminal path. The active runner (and, under
 * --fallback-runner, the swapped runner too) hit a usage / quota limit. Mirrors
 * the bash exhaustion branches: restore `ready-for-agent` (so a rerun once quota
 * resets re-picks the issue), post the exhaustion comment, emit the exhausted /
 * discarded history event, preserve the attempt dir, release the claim. The
 * session loop turns this into the exit-75 (EX_TEMPFAIL) signal.
 */
async function exhausted(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  branch: string,
  base: string,
  hooksFired: HookName[],
  runner: Runner,
  both: boolean,
): Promise<ProcessIssueResult> {
  // Quota exhaustion is BOUNDED-recoverable (recovery.ts, reason "quota"):
  // restore ready-for-agent while under the cap, else escalate to
  // ready-for-human (routeRecovery posts the budget-exhausted comment).
  await routeRecovery(deps, input.issue, "exhausted", input.attempt);
  await deps.gh.comment(
    input.issue,
    both
      ? `🤖 /afk: both runners exhausted. Iteration preserved at \`${input.attemptDir}\`.`
      : `🤖 /afk: runner \`${runner}\` exhausted; rerun /afk when quota resets, or pass \`--fallback-runner\` to swap to the other runner on exhaustion.`,
  );
  // History `exhausted` event — `reason` names the dead runner(s), mirroring the
  // shell's `emit_history "exhausted" … "<runner>|both-runners"`.
  if (deps.historyPath && deps.historyClock) {
    const { historyAppend } = await import("./history.js");
    await historyAppend(deps.historyPath, deps.historyClock, "exhausted", {
      worker: input.workerId,
      issue: input.issue,
      runner,
      reason: both ? "both-runners" : runner,
    });
  }
  await deps.claimLock.release(input.issue);
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

function isRunnerRecoverableOutcome(outcome: AgentOutcome): outcome is "exhausted" | "runner-transient" {
  return outcome === "exhausted" || outcome === "runner-transient";
}

/**
 * Terminal path for runner-side failures that should be bounded by AFK policy
 * rather than surfacing as raw worker crashes. Quota exhaustion keeps its legacy
 * history/comment shape; transport/setup failures get their own typed label and
 * retry cap (`blocked:runner-transient`, RED_AFK_RETRY_RUNNER_TRANSIENT).
 */
async function runnerRecoverable(
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
  await routeRecovery(deps, input.issue, "runner-transient", input.attempt);
  await deps.gh.comment(
    input.issue,
    both
      ? `🤖 /afk: both runner invocations hit a transient runner transport/setup failure. Iteration preserved at \`${input.attemptDir}\`.`
      : `🤖 /afk: runner \`${runner}\` hit a transient transport/setup failure; bounded recovery will retry or page a human when the retry budget is exhausted.`,
  );
  if (deps.historyPath && deps.historyClock) {
    const { historyAppend } = await import("./history.js");
    await historyAppend(deps.historyPath, deps.historyClock, "runner-transient", {
      worker: input.workerId,
      issue: input.issue,
      runner,
      reason: both ? "both-runners" : runner,
    });
  }
  await deps.claimLock.release(input.issue);
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

// ---------- context + prompt helpers ----------

/**
 * Extract the `{ env: { …string } }` slice from a hook's mutated context JSON
 * (FIX J). Returns a sanitised string→string record, or `undefined` when the
 * context has no usable env (no mutation, malformed JSON, or a non-object env).
 * Non-string env values are dropped — the agent env must be string→string.
 */
function parseHookEnv(context: string): Record<string, string> | undefined {
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

/**
 * Project the live lifecycle state into a {@link ReconcileInput} (ADR 0055). The
 * labels passed are the issue's CURRENT routing set: the issue was promoted to
 * `running` (shedding `ready-for-agent` + any stale `blocked:*`) at claim, so the
 * live set is `running` + the domain labels — exactly what reconcile's land/park
 * label transitions must shed or keep. `attempt`/`runner` reflect the runner that
 * actually authored the exit after any fallback swap.
 */
function reconcileInputFor(
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
    // ADR 0083 landing precondition (#1018): the configured Trunk for doLanding's
    // local-trunk-divergence guard on the ADR 0055 no-agent reconcile land.
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

/** Build the mutable hook context JSON, mirroring the `jq -nc` builders. */
function hookContext(fields: Record<string, unknown>): string {
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

function postAttemptContext(
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
    // Per-attempt file paths exported as RED_AFK_ITER_LOG / RED_AFK_STATE_FILE
    // so the red-heartbeat and red-envelope library hooks can write to them.
    iter_log: `${input.attemptDir}/afk.log`,
    state_file: `${input.attemptDir}/afk.state.json`,
  });
}

function onErrorContext(input: ProcessIssueInput, workspace: string, errClass: string, attempt: number): string {
  return JSON.stringify({
    issue: { number: input.issue, title: input.title },
    workspace,
    error: { class: errClass, rc: 0 },
    attempt_n: attempt,
  });
}
