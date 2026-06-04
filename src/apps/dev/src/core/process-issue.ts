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
  slugifyRef,
  type GitExec,
} from "./remote-branch.js";
import { buildHandoff, type HandoffComment } from "./handoff.js";
import {
  type AgentOutcome,
  type AgentEffort,
  type AgentStreamEvent,
  type AttemptProgressInfo,
  type RunAgentInput,
  type RunAgentResult,
} from "./execution.js";
import {
  relevantScopes,
  runFeedback,
  type Exec as PnpmExec,
  type PackageLayout,
  type RunFeedbackResult,
} from "./feedback.js";
import { runBackpressure, type BackpressureExec } from "./backpressure.js";
import {
  type Exec as MergeExec,
  type ConflictResolver,
  type WaitForReviewInput,
} from "./merge.js";
import { doLanding } from "./landing.js";
import {
  emitEnvelope,
  type EmitEnvelopeDeps,
  type SectionBodies,
} from "./envelope-emit.js";
import { dispatchHooks, type HookExec } from "./hook-dispatcher.js";
import { recoveryCap, recoveryDecision, type RecoveryEnv } from "./recovery.js";
import {
  blockedLabelFor,
  envelopeStatusFor,
  recoveryReasonFor,
  type AttemptOutcome,
} from "./attempt-outcome.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "./hook-config.js";
import { formatStartedMarker } from "./heartbeat.js";
import { parseReqLabels, planCloseCascade, type DependentIssue } from "./boot-sweep.js";
import { buildAttemptRecordPayload, type AttemptRecordPayload } from "./attempt-record.js";
import { parseCurrentBlocker, upsertCurrentBlocker, type CurrentBlocker } from "./blocker-state.js";
import type { AfkModelTier, ConfigValues } from "./config.js";
import {
  buildIssueClassificationMetadata,
  type IssueClassificationMetadata,
} from "./issue-classifier.js";
import type { AttemptStatus } from "./envelope.js";
import type { Runner } from "../types/runner.js";
import type { HistoryClock } from "./history.js";

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
}

/** Injected lookups the composed deciders need (issue body for the pin, the
 * lock value for the base, the handoff projection, the feedback scope inputs). */
export interface ProcessLookups {
  /** Resolve the effective base (lock > pin > main). */
  base: ResolveBaseDeps;
  /** True when the session is locked to a branch — drives the landing toggle. */
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
   * The sandcastle execution port (ADR 0033): run the inner agent on a worktree,
   * detect the DONE/BLOCKED sentinel, and commit on the worker branch. The CLI
   * passes a closure over execution.runAgent + defaultSandcastleDeps; tests pass
   * a fake returning a scripted RunAgentResult.
   */
  runAgent(input: RunAgentInput): Promise<RunAgentResult>;
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
   * Opt-in advisory-review wait for the UNLOCKED admin-PR landing
   * (`afk.merge.wait_for_review`, ADR 0048). Resolved from config by the CLI:
   * present → the landing holds until the configured review check concludes
   * before the admin-merge, then merges regardless of the verdict (the review
   * stays advisory — drift-guard + in-process backpressure are the binding
   * gates). Absent (the default) → admin-merge ignores advisory checks. Tests
   * omit it.
   */
  waitForReview?: WaitForReviewInput;
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
   * Salvage uncommitted work the inner agent left in its worktree. The codex
   * runner sometimes edits, passes the gates, and emits `<promise>DONE</promise>`
   * WITHOUT ever running `git commit`, so sandcastle collects zero commits and
   * the worker branch is empty — a DONE attempt then lands an empty merge and the
   * issue is never really resolved. When `runAgent` reports zero commits on a
   * done / no-sentinel outcome, processIssue calls this to commit the dirty
   * worktree (one commit per file) onto `branch` and push, so the SAME feedback
   * gate + landing tail see the work. Returns the count of files committed (0 =
   * clean worktree, nothing salvaged). Best-effort; MUST NOT throw. Optional →
   * tests/legacy callers omit it (no salvage, today's behaviour).
   */
  salvageUncommitted?(branch: string): Promise<number>;
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
  /** The lifecycle points that fired, in order — the parity target for tests. */
  hooksFired: HookName[];
  /** True when the terminal envelope was posted. */
  envelopePosted?: boolean;
  /** True when the attempt dir was preserved (every failure path). */
  preserved: boolean;
  /** True when the completion sweep ran (done only). */
  swept: boolean;
}

// ---------- the orchestration ----------

const LABEL_READY = "ready-for-agent";
const LABEL_RUNNING = "running";
const LABEL_HUMAN = "ready-for-human";

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

/**
 * Apply the BOUNDED auto-recovery routing for a terminal failure. The policy
 * (recovery.ts) decides retry vs escalate from the reason + the real attempt
 * number + the env caps:
 *   - "retry"    → remove [running], add [ready-for-agent, blocked:<reason>]
 *   - "escalate" → remove [running], add [ready-for-human,  blocked:<reason>]
 * The typed `blocked:<reason>` label is added in BOTH cases (descriptive). When
 * we ESCALATE a reason that was recoverable (its retry budget ran out), post a
 * one-line comment so the human page is self-explanatory. Returns the decision
 * so the caller can log / shape its terminal result if it cares.
 */
async function routeRecovery(
  deps: ProcessIssueDeps,
  issue: number,
  reason: AttemptOutcome,
  attemptN: number,
): Promise<"retry" | "escalate"> {
  const policyReason = recoveryReasonFor(reason);
  // A reason with no policy mapping is treated as escalate (page a human),
  // preserving the pre-recovery default for any unexpected reason.
  if (policyReason === null) {
    await editLabelsTagged(deps, issue, [LABEL_RUNNING], [LABEL_HUMAN], reason);
    return "escalate";
  }
  const env = deps.recoveryEnv ?? {};
  const decision = recoveryDecision(policyReason, attemptN, env);
  if (decision === "retry") {
    await editLabelsTagged(deps, issue, [LABEL_RUNNING], [LABEL_READY], reason);
    return "retry";
  }
  // escalate
  await editLabelsTagged(deps, issue, [LABEL_RUNNING], [LABEL_HUMAN], reason);
  const cap = recoveryCap(policyReason, env);
  if (cap !== null) {
    // A previously-auto-recoverable reason whose retry budget is exhausted —
    // announce the page so it is not mistaken for a first-attempt human block.
    const typed = blockedLabelFor(reason) ?? `blocked:${policyReason}`;
    await deps.gh.comment(
      issue,
      `🤖 /afk escalating to ready-for-human: ${typed} retry budget exhausted (attempt ${attemptN}/${cap}).`,
    );
  }
  return "escalate";
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

  const fireHook = async (name: HookName, context: string): Promise<boolean> => {
    hooksFired.push(name);
    const result = await dispatchHooks(name, resolved[name], context, deps.hooks.exec, {
      env: deps.hooks.env ?? {},
    });
    // Capture the pre_worktree env mutation (FIX J). Only this point computes the
    // mutable `env` slice the runner must inherit; other points' mutations are
    // not env-bearing, so we read it just here.
    if (name === "pre_worktree" && !result.aborted) {
      const parsed = parseHookEnv(result.context);
      if (parsed) agentEnv = parsed;
    }
    return !result.aborted;
  };

  // ---- 1. claim ----
  // local mkdir lock → pre-check ready-for-agent still present / not running →
  // the actual edit. A lost race at any layer abandons the attempt and skips.
  if (!(await deps.claimLock.acquire(issue))) {
    return claimLost(issue, hooksFired);
  }
  const labels = await deps.gh.viewLabels(issue);
  if (!labels.includes(LABEL_READY) || labels.includes(LABEL_RUNNING)) {
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }

  const activeBlocker = parseCurrentBlocker(input.body);
  if (activeBlocker) {
    await editLabelsTagged(deps, issue, [LABEL_READY], [LABEL_HUMAN], "blocked");
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

  if (!(await deps.gh.editLabels(issue, [LABEL_READY], [LABEL_RUNNING]))) {
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }

  // ---- branch ref + base ----
  const slug = slugifyRef(input.title);
  const branch = buildRefFromSlug("afk", input.workerId, issue, slug);
  if (branch === null) {
    // A malformed ref refuses the iteration; restore the claim like the bash
    // "refusing malformed live branch ref" guard (return before running).
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_READY]);
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }
  const base = await resolveBase(input.baseInput, deps.lookups.base);
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
  if (deps.git.fetchBase) await deps.git.fetchBase(base);
  let activeRunner: Runner = input.runner === "codex" ? "codex" : "claude";
  let attemptN = input.attempt;
  // Anchor sandcastle at the per-attempt dir so its `.sandcastle/` (worktrees,
  // logs, .env, patches) + git ops land under .red/, never at the repo root.
  // attemptDir is always absolute (built from `${root}/.red/tmp/...`), which is
  // also why promptFile/handoffPath must stay absolute — sandcastle resolves
  // promptFile against process.cwd(), not against this cwd.
  const initialTier = resolveSpawnTier(deps, activeRunner, taskClass);
  let run: RunAgentResult = await deps.runAgent({
    runner: activeRunner,
    model: initialTier.model,
    effort: initialTier.effort,
    handoffPath,
    branch,
    base,
    cwd: input.attemptDir,
    // Native-path liveness: drain sandcastle's file-log to the attempt dir and
    // forward each agent stream event to the lanes (agent.log.jsonl + firehose)
    // so the stall detector / monitor see a live agent instead of a frozen lane.
    logPath: `${input.attemptDir}/sandcastle.log`,
    onAgentEvent: deps.recordAgentEvent,
    // Externalized proof-of-life (PR-B): the attempt-guard poll fires this each
    // tick. processIssue owns the hook dispatcher, so it fires the `on_heartbeat`
    // user hook here (fire-and-forget) AND forwards the progress signal to the
    // CLI-wired sink (firehose record + state.last_progress_at). Never throws.
    onHeartbeat: (info) => {
      void fireHook(
        "on_heartbeat",
        hookContext({
          issue,
          title: input.title,
          workspace: branch,
          runner: input.runner,
          attempt_n: input.attempt,
        }),
      );
      deps.emitHeartbeat?.(info);
    },
    // Restore the issue #191 continuous-push guarantee: sandcastle pushes the
    // worker branch up-front + after every commit (host worktree hook), so a
    // SIGKILL mid-iteration preserves the diff on origin. Best-effort.
    remote: input.remote,
    continuousPush: true,
    // FIX J: env computed by the pre_worktree hook (e.g. CARGO_TARGET_DIR per
    // slot) — runAgent applies it to the spawned agent's environment.
    env: agentEnv,
  });

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
    const fallbackTier = resolveSpawnTier(deps, other, taskClass);
    run = await deps.runAgent({
      runner: other,
      model: fallbackTier.model,
      effort: fallbackTier.effort,
      handoffPath,
      branch,
      base,
      cwd: input.attemptDir,
      logPath: `${input.attemptDir}/sandcastle.log`,
      onAgentEvent: deps.recordAgentEvent,
      remote: input.remote,
      continuousPush: true,
      // FIX J: carry the pre_worktree env onto the fallback runner too.
      env: agentEnv,
    });
    if (isRunnerRecoverableOutcome(run.outcome)) {
      // Both runner invocations failed in a recoverable runner class → close the
      // fallback attempt's cycle, then terminate through the bounded policy.
      await fireHook("post_attempt", postAttemptContext({ ...input, attempt: attemptN }, branch, "fail", run.outcome));
      return await runnerRecoverable(deps, input, branch, base, hooksFired, activeRunner, run.outcome, true);
    }
  }

  // The worker branch sandcastle landed commits on is authoritative.
  const workerBranch = run.branch || branch;
  // The effective per-attempt identity after any fallback swap — the remaining
  // hook contexts / envelopes label themselves with the runner that actually
  // authored the exit and the attempt number it ran under.
  const current: ProcessIssueInput = { ...input, runner: activeRunner, attempt: attemptN };

  const common = {
    deps,
    input: current,
    branch: workerBranch,
    base,
    slug,
    hooksFired,
    startedEpoch,
  } satisfies StageCommon;

  // ---- commit-leftovers salvage (codex DONE-without-commit, ADR 0050) ----
  // The inner agent (observed: codex) can edit, pass the gates, and emit
  // `<promise>DONE</promise>` WITHOUT ever running `git commit`. sandcastle then
  // collects zero commits → the worker branch is empty → a DONE attempt lands an
  // empty merge and the issue is never really resolved (the no-sentinel salvage
  // below misses it too: the branch carries no commits). When runAgent reports
  // zero commits on a sentinel-bearing (done) or no-sentinel outcome, commit the
  // dirty worktree onto the worker branch (one commit per file) so the SAME
  // feedback gate + landing tail validate and merge the real work. A clean
  // worktree salvages nothing (count 0) → today's behaviour is unchanged.
  if (
    deps.salvageUncommitted &&
    run.commits.length === 0 &&
    (run.outcome === "done" || run.outcome === "no-sentinel")
  ) {
    const salvagedFiles = await deps.salvageUncommitted(workerBranch).catch(() => 0);
    if (salvagedFiles > 0) {
      deps.appendIterLog(
        `🤖 /afk: inner agent emitted ${run.outcome} but committed nothing — salvaged ${salvagedFiles} uncommitted file(s) onto \`${workerBranch}\` so the feedback gate + landing see the work.`,
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
  let salvaged = false;
  if (run.outcome === "no-sentinel") {
    const branchHasWork =
      (await deps.lookups.changedFiles(workerBranch, base)).length > 0 &&
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
  } else if (run.outcome === "timeout") {
    // ---- attempt progress guard fired: alive but no new commit within the cap.
    // Park to ready-for-human (blocked:stalled), preserving the pushed branch/PR
    // — never auto-retry (recoveryReasonFor("stalled") = null → always escalate). ----
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

  // ---- 5b. feedback loops (the merge gate, ADR 0008) ----
  // Feedback runs against a checkout of the returned worker branch; the injected
  // pnpm/layout execs resolve `workerBranch` to a concrete path in the CLI.
  const changedFiles = await deps.lookups.changedFiles(workerBranch, base);
  const feedback: RunFeedbackResult = await runFeedback(deps.pnpm, {
    worktree: workerBranch,
    scopes: relevantScopes(deps.layout, changedFiles),
    layout: deps.layout,
    now: deps.nowEpoch,
  });
  if (!feedback.ok) {
    // The feedback-failed path also has a structured sidecar — persist it for
    // Memory (best-effort) just like the done path does.
    await writeValidationSidecar(deps, input.attemptDir, feedback.sidecar);
    return await terminalFailure(common, "feedback-failed", "feedback", {
      notes: salvaged
        ? "Salvaged a no-sentinel branch (it carried work), but feedback validation failed — the branch was not merged."
        : "Feedback validation failed after the inner agent emitted DONE. The worker branch was not merged.",
      validation: feedback.sidecar.join("\n"),
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
      return await terminalFailure(common, "feedback-failed", "feedback", {
        notes:
          "Backpressure validation failed after the feedback gate passed. The worker branch was not merged.",
        validation: backpressure.sidecar.join("\n"),
      }, { validationSummary: backpressure.sidecar.join("\n") });
    }
  }
  // Both gates passed — the close path's sidecar/envelope carries their union.
  const validationSidecar = [...feedback.sidecar, ...backpressureSidecar];

  // ---- 6. push the worker branch, integrate, then land per lock state ----
  // The entire lock-toggled landing (push → pre_merge → integrate → land →
  // locked conflict self-resolve → post_merge) is owned by doLanding (landing.ts,
  // ADR 0030/0031). A non-ok result maps to the merge-conflict terminal-failure
  // path; on success the FINAL merge sha is read below (post post_merge), exactly
  // as before, to drive the done close.
  const locked = await deps.lookups.isLocked();
  const landing = await doLanding(
    {
      mergeExec: deps.mergeExec,
      remoteGit: deps.remoteGit,
      headShortSha: () => deps.git.headShortSha(),
      fireHook,
      conflictResolver: deps.conflictResolver,
      waitForReview: deps.waitForReview,
    },
    {
      locked,
      repo: input.repo,
      repoDir: input.repoDir,
      remote: input.remote,
      branch: workerBranch,
      base,
      issue,
      title: input.title,
    },
    {
      preMerge: () => hookContext({ issue, title: input.title, workspace: input.repoDir, branch: workerBranch }),
      postMerge: () => hookContext({ issue, title: input.title, workspace: input.repoDir, branch: workerBranch }),
    },
  );
  if (!landing.ok) {
    return await mergeFailed(common, landing.reason, landing.locked);
  }

  // ---- 7. close: envelope(done) → gh close + remove running → delete remote ----
  const mergeSha = await deps.git.headShortSha();
  const durationS = deps.nowEpoch() - startedEpoch;
  // Write the machine-readable validation sidecar ($ITER_DIR/validation.jsonl,
  // SKILL.md) the Memory bridge consumes. Best-effort: never fails the close.
  await writeValidationSidecar(deps, input.attemptDir, validationSidecar);
  const posted = await emitDone(common, mergeSha, durationS, validationSidecar);
  // ADR 0017: record the reasoning attempt into Memory AFTER the terminal
  // (done) envelope. Best-effort, gated, no-op when memory is absent.
  await recordAttemptBestEffort(common, "done", {
    durationS,
    mergeSha,
    validationSummary: validationSidecar.join("\n"),
  });
  await deps.gh.close(issue);
  await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
  await deleteRemote(deps.remoteGit, input.repoDir, workerBranch);

  // ---- 8. cleanup (local branch) + completion sweep ----
  await deps.git.deleteLocalBranch(workerBranch);
  await deps.fs.completionSweep(issue);
  await deps.claimLock.release(issue);

  // ---- 9. close cascade (event-driven auto-unblock) ----
  // Issue N just closed; re-evaluate every open issue carrying `req:N`. Any
  // whose `req:*` deps are now ALL closed sheds `blocked:dependency`, gains
  // `ready-for-agent`, and gets an audit comment. Best-effort: a gh failure logs
  // a warn and never fails the close — the boot Unblock Sweep catches it next
  // run.
  await runCloseCascade(deps, issue);

  return {
    outcome: "done",
    issue,
    branch: workerBranch,
    base,
    locked,
    mergeSha,
    hooksFired,
    envelopePosted: posted,
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
  if (!deps.recordAttempt) return;
  try {
    const payload = buildAttemptRecordPayload({
      repo: input.repo,
      issue: input.issue,
      attempt: input.attempt,
      outcome,
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
    await deps.recordAttempt(payload);
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk memory attempt-record for #${input.issue} failed (best-effort; ignored): ${String(err)}`,
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
    case "merge-conflict":
      return {
        status: "blocked",
        kind: "merge-conflict",
        summary: oneLine(sections.log, "Worker branch could not be merged cleanly."),
        next: "Resolve the merge conflict or add guidance for the next agent attempt.",
      };
    default:
      return null;
  }
}

async function writeCurrentBlockerBestEffort(
  deps: ProcessIssueDeps,
  input: ProcessIssueInput,
  blocker: CurrentBlocker | null,
): Promise<void> {
  if (!blocker || !deps.gh.editBody) return;
  try {
    await deps.gh.editBody(input.issue, upsertCurrentBlocker(input.body, blocker));
  } catch {
    // Best-effort: issue-body state improves resumability, but label routing and
    // the failure envelope remain the canonical fallback if the edit fails.
  }
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

/** Emit the done envelope with the merge sha + validation report. The
 * `validationSidecar` is the union of the feedback gate's records and any
 * backpressure-gate records (#430). */
async function emitDone(
  c: StageCommon,
  mergeSha: string,
  durationS: number,
  validationSidecar: string[],
): Promise<boolean> {
  const { deps, input } = c;
  const result = await emitEnvelope(deps.envelope, {
    status: "done",
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: c.branch,
    attempt: input.attempt,
    mergeSha,
    diff: "merged",
    sections: { validation: validationSidecar.join("\n") },
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
  await deps.claimLock.release(input.issue);
  return {
    outcome: "merge-conflict",
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
      await deps.gh.editLabels(p.number, ["blocked:dependency"], [LABEL_READY]);
      await deps.gh.comment(p.number, p.comment);
    }
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk close-cascade for #${closedIssue} failed (best-effort; boot sweep will retry): ${String(err)}`,
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
  await deps.claimLock.release(input.issue);
  return {
    outcome: "hook-aborted",
    issue: input.issue,
    branch,
    base,
    hooksFired,
    preserved: true,
    swept: false,
  };
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
