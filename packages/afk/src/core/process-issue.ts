// process-issue — the AFK per-issue lifecycle, ported from afk.sh's
// process_issue (+ iter_open / iter_close_success / iter_close_preserve /
// claim_lock_acquire / completion_sweep_issue / the _afk_fire_pre/post_attempt
// helpers and the do_merge wiring), and the "Per-Issue Loop" / "Issue
// Lifecycle" sections of SKILL.md.
//
// This module is PURE SEQUENCING. It owns only the ORDER of the per-issue
// lifecycle and the compose-decider-then-apply pattern: every step composes one
// of the already-ported pure modules (base-resolver / remote-branch / handoff /
// runner-spawn / feedback / merge / envelope-emit / hook-dispatcher /
// hook-config / heartbeat / state / attempt-ledger) and applies its side
// effects through injected IO. No real gh, git, spawn, fs, or clock lives here —
// the composed modules perform no ambient IO, and `processIssue` performs IO
// only through the injected `deps`.
//
// The lifecycle, mirroring SKILL.md "Per-Issue Loop" / "Issue Lifecycle":
//
//   1. claim          — local mkdir lock, then label ready-for-agent → running
//                       + start comment (claim layers; a lost race short-circuits).
//   2. attempt + state — attempt-ledger next number, attempt dir, state_init.
//   3. worktree        — resolveBase (lock > pin > main), worktree off the base,
//                        push_initial + post-commit hook (best-effort).
//   4. handoff         — buildHandoff into the attempt dir + heartbeat start.
//   5. inner agent     — runInner → DONE | BLOCKED | no-sentinel | exhausted.
//   6a. on DONE        — feedback; fail → ready-for-human; pass → merge
//                        (integrateOrigin then landMerge|landPr by lock state) →
//                        close (gh close + remove running + delete remote) →
//                        completion sweep.
//   6b. on BLOCKED / no-sentinel / merge-fail — emitEnvelope(failure) →
//                        ready-for-human, attempt dir preserved.
//
// Lifecycle hooks fire (via dispatchHooks over resolveHooks) at pre_worktree,
// pre_attempt, post_attempt, pre_merge, post_merge, and on_attempt_error — the
// canonical names; SKILL.md's pre_worker/post_worker/on_worker_error are the
// deprecated aliases of pre_attempt/post_attempt/on_attempt_error. A terminal
// envelope is emitted on every exit path.

import { resolveBase, type ResolveBaseDeps, type ResolveBaseInput } from "./base-resolver.js";
import {
  buildRefFromSlug,
  pushInitial,
  deleteRemote,
  slugifyRef,
  POST_COMMIT_HOOK_BODY,
  type GitExec,
} from "./remote-branch.js";
import { buildHandoff, type HandoffComment } from "./handoff.js";
import {
  buildInnerPrompt,
  runInner,
  type InnerSpawner,
  type SpawnInvocation,
  type InnerResult,
} from "./runner-spawn.js";
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

/** Filesystem side effects: the attempt dir, the post-commit hook, marker/
 * worktree teardown. All best-effort in afk.sh; the injected impl decides
 * real semantics. */
export interface ProcessFs {
  /** mkdir -p the attempt dir + open afk.log / lanes (iter_open). */
  ensureAttemptDir(dir: string): Promise<void>;
  /** Write the handoff.md into the attempt dir. */
  writeHandoff(path: string, content: string): Promise<void>;
  /** Install the executable post-commit hook into the worktree's gitdir. */
  installPostCommitHook(worktree: string, body: string): Promise<void>;
  /** Drop the heavy worktree, retaining the cheap artifacts (iter_drop_worktree). */
  dropWorktree(worktree: string): Promise<void>;
  /** Remove every attempt dir for a completed issue (completion_sweep_issue). */
  completionSweep(issue: number): Promise<string[]>;
}

/** git side effects beyond the merge/remote-branch primitives: worktree create
 * and the rev-parse the close path reads for the merge sha. */
export interface ProcessGit {
  /** git -C primary fetch origin <base> --quiet (best-effort). */
  fetchBase(base: string): Promise<void>;
  /** git -C primary worktree add <wt> -b <branch> origin/<base> (false on fail). */
  worktreeAdd(worktree: string, branch: string, base: string): Promise<boolean>;
  /** git -C primary rev-parse --short HEAD after a successful merge. */
  headShortSha(): Promise<string>;
  /** git -C primary branch -d <branch> after the worktree is gone (best-effort). */
  deleteLocalBranch(branch: string): Promise<void>;
}

/** Injected lookups the composed deciders need (issue body for the pin, the
 * lock value for the base, the per-issue blocked cap inputs). */
export interface ProcessLookups {
  /** Resolve the effective base (lock > pin > main). */
  base: ResolveBaseDeps;
  /** True when the session is locked to a branch — drives the landing toggle. */
  isLocked(): Promise<boolean>;
  /** Issue comments projected for the handoff (gh issue view --json comments). */
  comments(issue: number): Promise<HandoffComment[]>;
  /** Resolved gh issue url for the handoff `source:` line. */
  issueUrl(issue: number): Promise<string>;
  /** `git log -n 5` block for the base — for buildInnerPrompt (unused argv here). */
  recentCommits(): Promise<string>;
  /** Restart-informed retry block (issue #255); empty on a first attempt. */
  priorAttemptContext(issue: number): Promise<string | undefined>;
  /** Changed files of the worker branch vs the base, for feedback scope resolution. */
  changedFiles(worktree: string, base: string): Promise<string[]>;
  /** Diffstat line for the done envelope. */
  diffstat(worktree: string, base: string): Promise<string>;
}

/** The injected spawner + invocation builder for the inner agent. */
export interface ProcessRunner {
  spawn: InnerSpawner;
  /** Build the per-runner spawn invocation from the assembled prompt + worktree. */
  buildInvocation(input: { prompt: string; worktree: string; runner: Runner }): SpawnInvocation;
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
  /** git executor for remote-branch.ts (pushInitial / deleteRemote). */
  remoteGit: GitExec;
  /** pnpm executor for feedback.ts. */
  pnpm: PnpmExec;
  /** Package layout probe for feedback scope resolution. */
  layout: PackageLayout;
  runner: ProcessRunner;
  hooks: ProcessHooks;
  lookups: ProcessLookups;
  /** Envelope-emit IO (poster / marker writer / posted writer / git push). */
  envelope: EmitEnvelopeDeps;
  /** Clock: epoch seconds (date +%s) and an ISO timestamp (date -Iseconds). */
  nowEpoch(): number;
  nowIso(): string;
  /** Append one plain line to the iteration's afk.log (heartbeat boundary). */
  appendIterLog(line: string): void;
  /** Env for the cap/grace resolvers and the agent-prompt body. */
  agentPromptBody: string;
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
  | "exhausted"
  | "feedback-failed"
  | "claim-lost"
  | "hook-aborted";

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
    // "refusing malformed live branch ref" guard (return before any worktree).
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_READY]);
    await deps.claimLock.release(issue);
    return claimLost(issue, hooksFired);
  }
  const base = await resolveBase(input.baseInput, deps.lookups.base);
  const startedAt = deps.nowIso();
  const worktree = `${input.attemptDir}/worktree`;
  const worktreeRel = `${input.attemptDir}/worktree`;

  // ---- 2. attempt dir + state init ----
  await deps.fs.ensureAttemptDir(input.attemptDir);
  await deps.gh.comment(
    issue,
    `🤖 /afk started at \`${startedAt}\` on runner \`${input.runner}\` (worker \`${input.workerId}\`). worktree: \`${worktreeRel}\``,
  );

  // ---- pre_worktree hook (after claim, before git worktree add) ----
  if (!(await fireHook("pre_worktree", hookContext({ issue, title: input.title, target: worktree, branch })))) {
    return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_worktree");
  }

  // ---- 3. worktree off the resolved base + remote mirror ----
  await deps.git.fetchBase(base);
  if (!(await deps.git.worktreeAdd(worktree, branch, base))) {
    return await abortAfterClaim(deps, input, branch, base, hooksFired, "worktree-add");
  }
  // Continuous remote-branch push (issue #191): best-effort, never blocks.
  await pushInitial(deps.remoteGit, worktree, branch);
  await deps.fs.installPostCommitHook(worktree, POST_COMMIT_HOOK_BODY);

  // ---- 4. handoff + heartbeat start ----
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
  await deps.fs.writeHandoff(`${input.attemptDir}/handoff.md`, handoff);
  deps.appendIterLog(formatStartedMarker(issue, startedAt));

  // ---- pre_attempt hook (after the worktree exists, before the runner) ----
  if (
    !(await fireHook(
      "pre_attempt",
      hookContext({ issue, title: input.title, workspace: worktree, runner: input.runner, attempt_n: input.attempt }),
    ))
  ) {
    return await abortAfterClaim(deps, input, branch, base, hooksFired, "pre_attempt");
  }

  // ---- 5. inner agent ----
  const prompt = buildInnerPrompt({
    agentPromptBody: deps.agentPromptBody,
    handoffPath: `${input.attemptDir}/handoff.md`,
    recentCommits: await deps.lookups.recentCommits(),
  });
  const inner: InnerResult = await runInner(deps.runner.spawn, {
    runner: input.runner,
    invocation: deps.runner.buildInvocation({ prompt, worktree, runner: input.runner }),
  });

  const common = {
    deps,
    input,
    branch,
    base,
    slug,
    worktree,
    worktreeRel,
    hooksFired,
    startedEpoch,
  } satisfies StageCommon;

  // ---- on_attempt_error: EOF without a sentinel (ADR 0028) or exhaustion ----
  if (inner.exhausted) {
    // Both runners conceptually exhausted here (the TS capstone does not model
    // the fallback swap): restore ready-for-agent, preserve, emit a discarded
    // envelope, and surface the exhausted outcome.
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_READY]);
    await fireHook("post_attempt", postAttemptContext(input, worktree, "fail", ""));
    const posted = await emitFailure(common, "discarded", "exhausted", {});
    await deps.fs.dropWorktree(worktree);
    return {
      outcome: "exhausted",
      issue,
      branch,
      base,
      hooksFired,
      envelopePosted: posted,
      preserved: true,
      swept: false,
    };
  }

  if (inner.outcome === null) {
    // EOF-without-sentinel → on_attempt_error (no post_attempt for this firing).
    await fireHook("on_attempt_error", onErrorContext(input, worktree, "no-sentinel", input.attempt));
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_HUMAN]);
    const posted = await emitFailure(common, "no-sentinel", "no-sentinel", {
      notes: "_(no Notes appended; inner agent exited without a sentinel)_",
      log: inner.lastLine || "(no captured stdout)",
    });
    await deps.fs.dropWorktree(worktree);
    return {
      outcome: "no-sentinel",
      issue,
      branch,
      base,
      hooksFired,
      envelopePosted: posted,
      preserved: true,
      swept: false,
    };
  }

  // ---- post_attempt hook (terminal invocation; sentinel-bearing) ----
  const pwStatus = inner.outcome.kind === "done" ? "success" : "fail";
  await fireHook("post_attempt", postAttemptContext(input, worktree, pwStatus, inner.outcome.kind));

  // ---- BLOCKED ----
  if (inner.outcome.kind === "blocked") {
    await deps.gh.editLabels(issue, [LABEL_RUNNING], [LABEL_HUMAN]);
    const posted = await emitFailure(common, "blocked", "blocked", {
      notes: `_(inner agent emitted BLOCKED — see iteration log at \`${input.attemptDir}\`)_`,
    });
    await deps.fs.dropWorktree(worktree);
    return {
      outcome: "blocked",
      issue,
      branch,
      base,
      hooksFired,
      envelopePosted: posted,
      preserved: true,
      swept: false,
    };
  }

  // outcome.kind === "done" (no_more_tasks is ignored inside an iteration).

  // ---- 6a. feedback loops (the merge gate, ADR 0008) ----
  const changedFiles = await deps.lookups.changedFiles(worktree, base);
  const feedback: RunFeedbackResult = await runFeedback(deps.pnpm, {
    worktree,
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
    await deps.fs.dropWorktree(worktree);
    return {
      outcome: "feedback-failed",
      issue,
      branch,
      base,
      hooksFired,
      envelopePosted: posted,
      preserved: true,
      swept: false,
    };
  }

  // ---- 6a. merge: integrate then land per lock state ----
  const locked = await deps.lookups.isLocked();
  if (
    !(await fireHook("pre_merge", hookContext({ issue, title: input.title, workspace: input.repoDir, branch })))
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
      branch,
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
      branch,
      target: base,
      n: issue,
      title: input.title,
      worktree,
    });
    landed = r.ok;
  }
  if (!landed) {
    return await mergeFailed(common, "land-failed", locked);
  }

  await fireHook("post_merge", hookContext({ issue, title: input.title, workspace: input.repoDir, branch }));

  // ---- 6a. close: envelope(done) → gh close + remove running → delete remote ----
  const mergeSha = await deps.git.headShortSha();
  const durationS = deps.nowEpoch() - startedEpoch;
  const posted = await emitDone(common, mergeSha, durationS, feedback);
  await deps.gh.close(issue);
  await deps.gh.editLabels(issue, [LABEL_RUNNING], []);
  await deleteRemote(deps.remoteGit, input.repoDir, branch);

  // ---- 11. cleanup (split teardown) + completion sweep ----
  await deps.fs.dropWorktree(worktree);
  await deps.git.deleteLocalBranch(branch);
  await deps.fs.completionSweep(issue);
  await deps.claimLock.release(issue);

  return {
    outcome: "done",
    issue,
    branch,
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
  worktree: string;
  worktreeRel: string;
  hooksFired: HookName[];
  startedEpoch: number;
}

/** Emit a failure-family envelope (blocked / no-sentinel / merge-conflict /
 * discarded), composing envelope-emit. Returns the posted flag. */
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
    worktreeRel: c.worktreeRel,
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
  await deps.fs.dropWorktree(c.worktree);
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

/** Abort after a successful claim (a pre_* hook aborted or the worktree add
 * failed): restore ready-for-agent, release the claim, return hook-aborted. The
 * attempt dir is preserved for inspection. */
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
  worktree: string,
  status: "success" | "fail",
  outcome: string,
): string {
  return JSON.stringify({
    issue: { number: input.issue, title: input.title },
    workspace: worktree,
    result: { status, outcome },
    attempt_n: input.attempt,
  });
}

function onErrorContext(input: ProcessIssueInput, worktree: string, errClass: string, attempt: number): string {
  return JSON.stringify({
    issue: { number: input.issue, title: input.title },
    workspace: worktree,
    error: { class: errClass, rc: 0 },
    attempt_n: attempt,
  });
}

