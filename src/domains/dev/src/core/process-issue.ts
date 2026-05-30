// process-issue — the AFK per-issue lifecycle, ported from afk.sh's
// process_issue (+ iter_open / iter_close_success / iter_close_preserve /
// claim_lock_acquire / completion_sweep_issue / the _afk_fire_pre/post_attempt
// helpers and the do_merge wiring), and the "Per-Issue Loop" / "Issue
// Lifecycle" sections of SKILL.md.
//
// This module is PURE SEQUENCING. It owns only the ORDER of the per-issue
// lifecycle and the compose-decider-then-apply pattern: every step composes one
// of the already-ported pure modules (base-resolver / remote-branch / handoff /
// execution / feedback / merge / envelope-emit / hook-dispatcher / hook-config /
// heartbeat / state / attempt-ledger) and applies its side effects through
// injected IO. No real gh, git, spawn, fs, or clock lives here — the composed
// modules perform no ambient IO, and `processIssue` performs IO only through the
// injected `deps`.
//
// ---------------------------------------------------------------------------
// EXECUTION SUBSTRATE DELEGATED TO SANDCASTLE (ADR 0033)
// ---------------------------------------------------------------------------
// The "create a worktree + spawn the inner agent + stream/sentinel detect +
// commit on the worker branch" middle is no longer hand-rolled here. It is a
// single call to the injected `deps.runAgent` port (a closure over
// execution.runAgent + defaultSandcastleDeps in the CLI; a fake in tests).
// sandcastle now OWNS: worktree creation, agent spawn, stream/sentinel
// detection, and committing on the worker branch via
// branchStrategy {type:"branch", branch: afk/{id}/{N}-{slug}}.
//
// AFK STILL OWNS (unchanged): claim + labels, the attempt dir, handoff
// materialisation, the feedback gate, the lock-toggled landing, envelope
// emission, close, completion sweep, and the lifecycle hooks.
//
// PRAGMATIC INTEGRATION CHOICES (the seams where AFK's host-side modules meet a
// sandcastle-owned worktree we never see a path to in-process):
//   * The handoff is written to the HOST attempt dir (`<attemptDir>/handoff.md`)
//     and passed to `runAgent` as the sandcastle `promptFile` (handoffPath). The
//     AGENT-PROMPT contract is unchanged — the DONE/BLOCKED sentinels are the
//     sandcastle completion signals.
//   * `runAgent` returns the worker branch + its commits. AFK does NOT create or
//     push the branch up-front any more (no push_initial / post-commit hook).
//     After a DONE run, AFK makes the worker branch's origin state certain by
//     pushing it (remote-branch.pushAttempt to origin/<branch>) BEFORE landing,
//     so landMerge / landPr (which run from the primary checkout / a host
//     worktree) have a remote ref to merge.
//   * Feedback runs against a checkout/worktree of the returned branch through
//     the injected pnpm/layout execs. We pass `result.branch` as the feedback
//     `worktree` token; the concrete CLI closure resolves it to a real path
//     (e.g. a sandcastle worktree handle or a host re-checkout). The unit tests
//     inject a fake pnpm, so the token is opaque here — this is the one seam that
//     cannot be fully resolved without a real sandcastle worktree handle.
//   * `merge-conflict` is no longer a reachable inner-agent outcome (sandcastle
//     either lands commits or not); the merge stage can still fail to integrate
//     or land, and that path keeps the `merge-conflict` envelope/outcome.
// ALL IO stays injected; nothing real is ever spawned from this module.
//
// Lifecycle hooks fire (via dispatchHooks over resolveHooks) at pre_worktree,
// pre_attempt, post_attempt, pre_merge, post_merge, and on_attempt_error — the
// canonical names; SKILL.md's pre_worker/post_worker/on_worker_error are the
// deprecated aliases. A terminal envelope is emitted on every exit path.

import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "./base-resolver.js";
import {
  buildRefFromSlug,
  deleteRemote,
  pushAttempt,
  slugifyRef,
  type GitExec,
} from "./remote-branch.js";
import { buildHandoff, type HandoffComment } from "./handoff.js";
import { type RunAgentInput, type RunAgentResult } from "./execution.js";
import {
  relevantScopes,
  runFeedback,
  type Exec as PnpmExec,
  type PackageLayout,
  type RunFeedbackResult,
} from "./feedback.js";
import {
  integrateOrigin,
  landMerge,
  landPr,
  type Exec as MergeExec,
} from "./merge.js";
import { emitEnvelope, type EmitEnvelopeDeps, type SectionBodies } from "./envelope-emit.js";
import { dispatchHooks, type HookExec } from "./hook-dispatcher.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "./hook-config.js";
import { formatStartedMarker } from "./heartbeat.js";
import type { ConfigValues } from "./config.js";
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
  /** gh issue comment --body … */
  comment(issue: number, body: string): Promise<void>;
  /** gh issue close --reason completed. */
  close(issue: number): Promise<void>;
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
   * The sandcastle execution port (ADR 0033): run the inner agent on a worktree,
   * detect the DONE/BLOCKED sentinel, and commit on the worker branch. The CLI
   * passes a closure over execution.runAgent + defaultSandcastleDeps; tests pass
   * a fake returning a scripted RunAgentResult.
   */
  runAgent(input: RunAgentInput): Promise<RunAgentResult>;
  /** Model id passed through to runAgent (provider-specific, e.g. "claude-opus-4-8"). */
  model: string;
  hooks: ProcessHooks;
  lookups: ProcessLookups;
  /**
   * Mid-issue runner fallback (--fallback-runner / FALLBACK_RUNNER). When true,
   * a first exhaustion swaps to the other runner (claude↔codex) and re-runs the
   * attempt once; double-exhaustion is terminal (outcome `exhausted`). When
   * false (default), a single exhaustion is terminal.
   */
  fallbackRunner?: boolean;
  /** Envelope-emit IO (poster / marker writer / posted writer / git push). */
  envelope: EmitEnvelopeDeps;
  /** Clock: epoch seconds (date +%s) and an ISO timestamp (date -Iseconds). */
  nowEpoch(): number;
  nowIso(): string;
  /** Append one plain line to the iteration's afk.log (heartbeat boundary). */
  appendIterLog(line: string): void;
  /** History ledger path + clock for the terminal envelope (optional). */
  historyPath?: string;
  historyClock?: HistoryClock;
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

export type ProcessOutcome =
  | "done"
  | "blocked"
  | "no-sentinel"
  | "merge-conflict"
  | "feedback-failed"
  | "claim-lost"
  | "hook-aborted"
  | "exhausted";

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

  const fireHook = async (name: HookName, context: string): Promise<boolean> => {
    hooksFired.push(name);
    const result = await dispatchHooks(name, resolved[name], context, deps.hooks.exec, {
      env: deps.hooks.env ?? {},
    });
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
  let run: RunAgentResult = await deps.runAgent({
    runner: activeRunner,
    model: deps.model,
    handoffPath,
    branch,
    base,
  });

  // ---- runner-fallback subsystem (--fallback-runner / RUNNER_EXHAUSTED) ----
  // The active runner signalled quota / rate-limit exhaustion (execution.ts
  // mapped a sandcastle throw / stdout to the `exhausted` outcome). Without
  // --fallback-runner a single exhaustion is terminal. With it, close the
  // exhausted attempt's cycle (post_attempt status=exhausted), swap to the
  // other runner, fire pre_attempt again (the per-runner-invocation cadence,
  // #226 / ADR 0026), and re-run once. Double-exhaustion is terminal.
  if (run.outcome === "exhausted") {
    if (!deps.fallbackRunner) {
      return await exhausted(deps, input, branch, base, hooksFired, activeRunner, false);
    }
    // Close attempt N's cycle (status=exhausted) before swapping.
    await fireHook("post_attempt", postAttemptContext({ ...input, attempt: attemptN }, branch, "fail", "exhausted"));
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
    run = await deps.runAgent({ runner: other, model: deps.model, handoffPath, branch, base });
    if (run.outcome === "exhausted") {
      // Both runners exhausted → close the fallback attempt's cycle, then it is
      // terminal with the double-exhaustion (both-runners) history event.
      await fireHook("post_attempt", postAttemptContext({ ...input, attempt: attemptN }, branch, "fail", "exhausted"));
      return await exhausted(deps, input, branch, base, hooksFired, activeRunner, true);
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

  // ---- on_attempt_error: the run ended without an AFK sentinel (ADR 0028) ----
  if (run.outcome === "no-sentinel") {
    await fireHook("on_attempt_error", onErrorContext(current, workerBranch, "no-sentinel", current.attempt));
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_HUMAN]);
    const posted = await emitFailure(common, "no-sentinel", "no-sentinel", {
      notes: "_(no Notes appended; inner agent exited without a sentinel)_",
      log: run.stdout ? run.stdout.split("\n").slice(-1)[0] || "(no captured stdout)" : "(no captured stdout)",
    });
    return {
      outcome: "no-sentinel",
      issue,
      branch: workerBranch,
      base,
      hooksFired,
      envelopePosted: posted,
      preserved: true,
      swept: false,
    };
  }

  // ---- post_attempt hook (terminal invocation; sentinel-bearing) ----
  const pwStatus = run.outcome === "done" ? "success" : "fail";
  await fireHook("post_attempt", postAttemptContext(current, workerBranch, pwStatus, run.outcome));

  // ---- BLOCKED ----
  if (run.outcome === "blocked") {
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_HUMAN]);
    const posted = await emitFailure(common, "blocked", "blocked", {
      notes: `_(inner agent emitted BLOCKED — see iteration log at \`${input.attemptDir}\`)_`,
    });
    return {
      outcome: "blocked",
      issue,
      branch: workerBranch,
      base,
      hooksFired,
      envelopePosted: posted,
      preserved: true,
      swept: false,
    };
  }

  // run.outcome === "done".

  // ---- 5. feedback loops (the merge gate, ADR 0008) ----
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
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_HUMAN]);
    const posted = await emitFailure(common, "blocked", "feedback", {
      notes: "Feedback validation failed after the inner agent emitted DONE. The worker branch was not merged.",
      validation: feedback.sidecar.join("\n"),
    });
    return {
      outcome: "feedback-failed",
      issue,
      branch: workerBranch,
      base,
      hooksFired,
      envelopePosted: posted,
      preserved: true,
      swept: false,
    };
  }

  // ---- 6. push the worker branch, integrate, then land per lock state ----
  // sandcastle committed on the worker branch but does not push it; AFK makes
  // its origin state certain before landing (so landMerge/landPr have a ref).
  await pushAttempt(deps.remoteGit, input.repoDir, workerBranch, workerBranch);

  const locked = await deps.lookups.isLocked();
  if (
    !(await fireHook("pre_merge", hookContext({ issue, title: input.title, workspace: input.repoDir, branch: workerBranch })))
  ) {
    return await mergeFailed(common, "pre_merge-abort");
  }

  const integrated = await integrateOrigin(deps.mergeExec, {
    repo: input.repoDir,
    remote: input.remote,
    branch: base,
    stillBehind: true,
    inSync: false,
  });
  if (!integrated.ok) {
    return await mergeFailed(common, "integrate-failed");
  }
  const preMergeSha = await deps.git.headShortSha();

  let landed: boolean;
  if (locked) {
    const r = await landMerge(deps.mergeExec, {
      repo: input.repoDir,
      remote: input.remote,
      branch: workerBranch,
      target: base,
      n: issue,
      title: input.title,
      preMergeSha,
    });
    landed = r.ok;
  } else {
    const r = await landPr(deps.mergeExec, {
      repo: input.repo,
      gitRepo: input.repoDir,
      remote: input.remote,
      branch: workerBranch,
      target: base,
      n: issue,
      title: input.title,
    });
    landed = r.ok;
  }
  if (!landed) {
    return await mergeFailed(common, "land-failed", locked);
  }

  await fireHook("post_merge", hookContext({ issue, title: input.title, workspace: input.repoDir, branch: workerBranch }));

  // ---- 7. close: envelope(done) → gh close + remove running → delete remote ----
  const mergeSha = await deps.git.headShortSha();
  const durationS = deps.nowEpoch() - startedEpoch;
  const posted = await emitDone(common, mergeSha, durationS, feedback);
  await deps.gh.close(issue);
  await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
  await deleteRemote(deps.remoteGit, input.repoDir, workerBranch);

  // ---- 8. cleanup (local branch) + completion sweep ----
  await deps.git.deleteLocalBranch(workerBranch);
  await deps.fs.completionSweep(issue);
  await deps.claimLock.release(issue);

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

/** Emit the done envelope with the merge sha + validation report. */
async function emitDone(
  c: StageCommon,
  mergeSha: string,
  durationS: number,
  feedback: RunFeedbackResult,
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
    sections: { validation: feedback.sidecar.join("\n") },
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
  await deps.gh.editLabels(input.issue, [LABEL_RUNNING], [LABEL_HUMAN]);
  const posted = await emitFailure(c, "merge-conflict", "merge-conflict", {
    log: "(no merge log captured)",
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
  await deps.gh.editLabels(input.issue, [LABEL_RUNNING], [LABEL_READY]);
  await deps.gh.comment(
    input.issue,
    `🤖 /afk aborted before runner invocation (${_reason}). Restored \`${LABEL_READY}\`.`,
  );
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
  await deps.gh.editLabels(input.issue, [LABEL_RUNNING], [LABEL_READY]);
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

// ---------- context + prompt helpers ----------

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
