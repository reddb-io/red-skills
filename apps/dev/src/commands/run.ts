import { parseRunnerFlag, detectRunner } from "../core/runner-detection.js";
import { callerProcessTreeNative } from "../runtime/caller-process.js";
import {
  runSession,
  type SessionContext,
  type SessionDeps,
  type SelectionFilter,
  type IssueCandidate,
} from "../core/session.js";
import { genWorkerId } from "../core/session.js";
import { runBoot, type BootDeps, type BootOptions, type BootstrapInput, type ReconcileBootRunner } from "../core/boot.js";
import { reconcile, type ReconcileDeps, type ReconcileInput } from "../core/reconcile.js";
import { resolveBase } from "../core/base-resolver.js";
import { findOwnedBranch, type ReconcileSweepPlan } from "../core/boot-sweep.js";
import { processIssue, type ProcessIssueDeps, type ProcessIssueInput } from "../core/process-issue.js";
import {
  toMemoryPayload,
  resolveMemoryCli,
  type AttemptRecordPayload,
} from "../core/attempt-record.js";
import { isRunner, type Runner } from "../types/runner.js";
import {
  afkPaths,
  collectPrecheckFacts,
  collectBootOptions,
  collectMonitorInputs,
  makeRunAgent,
  resolveRepoContext,
  resolveRunSettings,
  type RepoContext,
  type AfkPaths,
} from "../runtime/wire.js";
import type { LaneIdleStallConfig } from "../core/lane-idle-reaper.js";
import { workerDir as workerDirPath, workerPidFile } from "../core/worker-paths.js";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { LABEL_HUMAN, LABEL_RUNNING } from "../core/triage-labels.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import * as fsx from "../runtime/fs.js";
import type { GhContext } from "../runtime/gh.js";
import type { GitContext } from "../runtime/git.js";
import type { ExecFn } from "../runtime/exec.js";
import { getConfig, loadConfig, readBackpressure, resolveTier } from "../core/config.js";
import {
  classifyIssue,
  type IssueClassificationMetadata,
} from "../core/issue-classifier.js";
import { resolveHooks } from "../core/hook-config.js";
import { attemptLedgerContext, formatAttemptContext, highestAttempt, type AttemptDirEntry } from "../core/attempt-ledger.js";
import { isValidWorkerId } from "../core/worker-paths.js";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { specialUserRequestBlock, claudeSpawnArgs, codexSpawnArgs } from "../core/runner-spawn.js";
import { buildWorkerAttemptPath } from "../core/worker-paths.js";
import { branchLockPath, readLockedBranch, isLocked } from "../runtime/lock.js";
import { makeHookExec, makeHookResolveOptions, hookEnv } from "../runtime/hooks.js";
import { makeFeedbackWorktree, type FeedbackWorktree } from "../runtime/feedback-worktree.js";
import { join } from "node:path";
import { appendAgentRecord, appendRecord } from "../core/jsonl-log.js";
import { initState, updateState } from "../core/state.js";
import { buildProgressHeartbeat, formatIterationMarker } from "../core/heartbeat.js";
import { DEFAULT_MAX_ITERATIONS } from "../core/execution.js";
import type { AgentStreamEvent } from "../core/execution.js";

export interface RunOptions {
  args: string[];
  cwd?: string;
}

interface ParsedRunFlags {
  filter: SelectionFilter;
  iterCap?: number;
  once: boolean;
  runnerFlag?: string;
  /** --model <slug>: override the resolved tier model for every tier (flag > env > config). */
  model?: string;
  /** --effort <e>: override the resolved tier effort (still provider-gated downstream). */
  effort?: string;
  request?: string;
  /** --alternate: rotate the runner between consecutive issues (claude↔codex). */
  alternate: boolean;
  /** --fallback-runner: swap runners mid-issue on RUNNER_EXHAUSTED. */
  fallbackRunner: boolean;
  /** --boot-only: run the boot sweeps then exit without selecting/claiming/processing. */
  bootOnly: boolean;
  /**
   * --reconcile-issue <n>: supervisor-dispatched reconcile worker mode (ADR 0055,
   * #562). Bypass the normal boot+session; validate-and-land the parked branch for
   * issue `n` without re-running the agent.
   */
  reconcileIssue?: number;
}

/** Raised when --alternate is combined with --runner (mutually exclusive). */
export class RunFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunFlagError";
  }
}

/** Parse a comma-separated issue list into an ordered, finite number list. */
function parseIssueList(raw: string): number[] {
  return raw.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
}

/**
 * Coerce a `--issues` value into the issues filter, rejecting an all-invalid
 * value. `--issues banana` (or any value yielding zero finite numbers) would
 * otherwise produce `{ kind: "issues", numbers: [] }`, which `selectIssues`
 * reads as "select nothing" — the run then silently drains only urgents (or
 * nothing). Erroring here forces the operator to fix the typo instead of
 * launching a worker that quietly does the wrong thing.
 */
function coerceIssuesFilter(raw: string): SelectionFilter {
  const numbers = parseIssueList(raw);
  if (numbers.length === 0) {
    throw new RunFlagError(`--issues requires at least one valid issue number (got: ${JSON.stringify(raw)})`);
  }
  return { kind: "issues", numbers };
}

/**
 * Flag schema for the `run` command, expressed against the shared CLI layer
 * (`packages/shared/args.ts`, built over `cli-args-parser`). The coercions here
 * reproduce the exact semantics the dev suite asserts: `--prd`/`-n` map through
 * `Number`, `--issues` trims and filters to finite numbers, booleans are
 * present-or-absent, and `--request` accepts the `-r` short alias.
 */
const RUN_FLAG_SCHEMA = {
  prd: { kind: "value", coerce: (raw: string): SelectionFilter => ({ kind: "prd", prd: Number(raw) }) },
  issues: { kind: "value", coerce: coerceIssuesFilter },
  n: { kind: "value", coerce: (raw: string): number => Number(raw) },
  once: { kind: "boolean" },
  runner: { kind: "value", coerce: (raw: string): string => raw },
  model: { kind: "value", coerce: (raw: string): string => raw },
  effort: { kind: "value", coerce: (raw: string): string => raw },
  request: { kind: "value", aliases: ["r"], coerce: (raw: string): string => raw },
  alternate: { kind: "boolean" },
  "fallback-runner": { kind: "boolean" },
  "boot-only": { kind: "boolean" },
  "reconcile-issue": { kind: "value", coerce: (raw: string): number => Number(raw) },
} satisfies FlagSchema;

/** Parse the `run` flags: --prd N / --issues a,b,c / -n N / --once / --request / --runner. */
export function parseRunFlags(args: readonly string[]): ParsedRunFlags {
  const { values } = parseFlags(args, RUN_FLAG_SCHEMA);

  // --prd and --issues both feed `filter`; the last of the two in argv wins,
  // matching the original single-pass scan. Resolve order from the raw argv.
  let filter: SelectionFilter = { kind: "all" };
  let lastFilterPos = -1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === "--prd" || arg.startsWith("--prd=")) && values.prd !== undefined && i > lastFilterPos) {
      filter = values.prd as SelectionFilter;
      lastFilterPos = i;
    } else if ((arg === "--issues" || arg.startsWith("--issues=")) && values.issues !== undefined && i > lastFilterPos) {
      filter = values.issues as SelectionFilter;
      lastFilterPos = i;
    }
  }

  const runnerFlag = values.runner as string | undefined;
  const alternate = values.alternate === true;
  // --alternate (round-robin rotation) is mutually exclusive with a pinned
  // --runner: pinning fixes one backend, rotation cycles them — asking for both
  // is contradictory (SKILL.md §Runner Fallback).
  if (alternate && runnerFlag !== undefined) {
    throw new RunFlagError("--alternate is mutually exclusive with --runner");
  }

  const rawReconcileIssue = values["reconcile-issue"];
  const reconcileIssue =
    typeof rawReconcileIssue === "number" && Number.isFinite(rawReconcileIssue) && rawReconcileIssue > 0
      ? rawReconcileIssue
      : undefined;

  return {
    filter,
    iterCap: values.n as number | undefined,
    once: values.once === true,
    runnerFlag,
    model: values.model as string | undefined,
    effort: values.effort as string | undefined,
    request: values.request as string | undefined,
    alternate,
    fallbackRunner: values["fallback-runner"] === true,
    bootOnly: values["boot-only"] === true,
    reconcileIssue,
  };
}

/** Pre-resolve the gh issue-state cache the branch-cleanup reapers + orphan
 * lookup read synchronously. Mirrors collectReapInputs' eager resolution, but
 * sources every issue's meta from the SINGLE batched `listIssueStates` map
 * instead of a per-issue `gh issue view` storm. A map miss (issue beyond the
 * --limit window / just-created / transient list failure) falls back to the
 * live `ghx.issueMeta` so closedAt-grace classification stays exact. */
async function resolveBranchIssueCache(
  ghCtx: GhContext,
  options: BootOptions,
  states: Map<number, import("../runtime/gh.js").IssueStateRow>,
): Promise<Map<number, import("../core/branch-cleanup.js").IssueMeta | null | undefined>> {
  const { liveIssueFromBranch, attemptIssueFromBranch } = await import("../core/branch-cleanup.js");
  const issues = new Set<number>();
  for (const r of options.branches.snapshotRefs) {
    const n = attemptIssueFromBranch(r.branch);
    if (n !== null) issues.add(n);
  }
  for (const r of [...options.branches.remoteLiveRefs, ...options.branches.localLiveRefs]) {
    const n = liveIssueFromBranch(r.branch);
    if (n !== null) issues.add(n);
  }
  const cache = new Map<number, import("../core/branch-cleanup.js").IssueMeta | null | undefined>();
  for (const n of issues) {
    const row = states.get(n);
    if (row) cache.set(n, { state: row.state, closedAt: row.closedAt });
    else cache.set(n, await ghx.issueMeta(ghCtx, n));
  }
  return cache;
}

/** Build the boot reconcile runner (step 7, ADR 0055). The runner closes over
 * the repo context and feedback worktree so each plan invocation has full
 * reconcile deps without re-building them on every call. */
function makeBootReconcileRunner(
  ctx: RepoContext,
  paths: AfkPaths,
  workerId: string,
  runner: Runner,
  feedback: FeedbackWorktree,
): ReconcileBootRunner {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: GitContext = { cwd: ctx.root };
  const lockPath = branchLockPath(ctx.root);

  return async (plan: ReconcileSweepPlan) => {
    // Acquire the per-issue claim before validating/landing so a concurrent live
    // worker or a second concurrent boot cannot double-land the same parked
    // branch (#568). Uses the same claims/{N} dir as the per-issue path, so the
    // two are mutually exclusive; skip when another live pid already holds it.
    const claimDir = `${paths.tmpDir}/claims/${plan.number}`;
    if (!(await fsx.tryAcquireClaimDir(claimDir, process.pid))) {
      return { outcome: "skipped" as const };
    }
    const reconcileDeps: ReconcileDeps = {
      gh: {
        editLabels: async (issue, remove, add) => {
          await ghx.editLabels(ghCtx, issue, remove, add);
          return true;
        },
        ensureLabel: (name) => ghx.ensureLabel(ghCtx, name),
        comment: (issue, body) => ghx.comment(ghCtx, issue, body),
        close: (issue) => ghx.closeIssue(ghCtx, issue),
        listByLabel: (label) => ghx.listByLabel(ghCtx, label),
        issueClosed: (n) => ghx.issueClosed(ghCtx, n),
      },
      git: {
        headShortSha: () => gitx.headShortSha(gitCtx),
        deleteLocalBranch: (branch) => gitx.deleteLocalBranch(gitCtx, branch),
      },
      fs: {
        completionSweep: (issue) => fsx.completionSweep(paths.workersRoot, issue),
      },
      lookups: {
        changedFiles: (branch, base) => gitx.changedFiles(gitCtx, branch, base),
        branchPresent: async (branch) => {
          if (await gitx.branchExists(gitCtx, branch)) return true;
          await gitx.fetchBranch(gitCtx, branch);
          return gitx.branchExists(gitCtx, branch);
        },
        isLocked: () => isLocked(lockPath),
      },
      mergeExec: gitx.mergeExec(gitCtx),
      remoteGit: gitx.gitExec(gitCtx),
      pnpm: feedback.pnpm,
      layout: feedback.layout,
      // Isolated landing worktree for the LOCKED reconcile-land (#572): the merge
      // /push/rollback runs in a throwaway detached worktree, never the primary.
      makeLandingWorktree: async (base: string) => {
        const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
        const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "base";
        const dest = join(paths.tmpDir, "landing", `${slug}-boot-${slot}`);
        await gitx.worktreeRemove(gitCtx, dest);
        const ok = await gitx.worktreeAdd(gitCtx, dest, base);
        return ok ? dest : null;
      },
      removeLandingWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
      envelope: {
        git: gitx.gitExec(gitCtx),
        poster: async (issue, body) => {
          await ghx.comment(ghCtx, issue, body);
          return true;
        },
        // Boot reconcile has no per-attempt dir — markers/posted are best-effort
        // observability hooks that are silently skipped in this context.
        writeMarkers: async () => {},
        writePosted: async () => {},
      },
      nowEpoch: () => Math.floor(Date.now() / 1000),
      appendIterLog: () => {},
    };

    try {
      // Resolve the effective base (lock > pin > main, ADR 0031) instead of a
      // literal "main": a parked issue pinned to a non-main branch — or a
      // branch-locked session — must reconcile and land against that branch,
      // never the trunk (#568, trunk safety). Mirrors the per-issue base lookup.
      const base = await resolveBase(
        { issueBody: plan.body },
        { readLockedBranch: () => readLockedBranch(lockPath), fetchIssueBody: (n) => ghx.issueBody(ghCtx, n) },
      );

      const reconcileInput: ReconcileInput = {
        issue: plan.number,
        title: plan.title,
        body: plan.body,
        labels: plan.labels,
        branch: plan.branch,
        base,
        repo: ctx.repo,
        repoDir: ctx.root,
        remote: ctx.remote,
        workerId,
        attempt: 0,
        attemptDir: join(paths.tmpDir, "boot-reconcile", String(plan.number)),
        runner,
      };

      const result = await reconcile(reconcileDeps, reconcileInput);
      const outcome = result.outcome === "landed" ? "landed" as const
        : result.outcome === "parked" ? "parked" as const
        : "skipped" as const;
      return { outcome };
    } finally {
      await fsx.removeDir(claimDir);
    }
  };
}

/**
 * Supervisor-dispatched reconcile worker (ADR 0055, #562): validate-and-land the
 * parked branch for `issue` without re-running the agent. Fetches the issue
 * metadata + its `afk/…` branch, then delegates to `makeBootReconcileRunner`.
 * Best-effort: a missing branch or failed fetch exits 0 (nothing to reconcile).
 */
async function runReconcileWorker(
  issue: number,
  runner: Runner,
  ctx: RepoContext,
  paths: AfkPaths,
  workerId: string,
): Promise<number> {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: GitContext = { cwd: ctx.root };

  const issueData = await ghx.viewIssueFull(ghCtx, issue);
  if (!issueData) {
    process.stderr.write(`[afk reconcile-worker] #${issue} not found or fetch failed — nothing to reconcile\n`);
    return 0;
  }

  const remoteBranches = await gitx.listRemoteBranches(gitCtx, "afk/");
  const branch = findOwnedBranch(remoteBranches.map((r) => r.branch), issue);
  if (!branch) {
    process.stderr.write(`[afk reconcile-worker] no afk branch for #${issue} — nothing to reconcile\n`);
    return 0;
  }

  const plan: ReconcileSweepPlan = {
    number: issueData.number,
    title: issueData.title,
    body: issueData.body,
    labels: issueData.labels,
    branch,
  };

  const feedback = makeFeedbackWorktree(ctx.root, join(paths.tmpDir, "feedback"));
  try {
    const reconcileRunner = makeBootReconcileRunner(ctx, paths, workerId, runner, feedback);
    await reconcileRunner(plan);
  } finally {
    await feedback.cleanup();
  }

  return 0;
}

async function buildBootDeps(ctx: RepoContext, options: BootOptions, nowS: number): Promise<BootDeps> {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: GitContext = { cwd: ctx.root };
  // ONE batched issue-state fetch backs every per-issue boot lookup below.
  const issueStates = await ghx.listIssueStates(ghCtx);
  const branchCache = await resolveBranchIssueCache(ghCtx, options, issueStates);
  return {
    fs: {
      ensureDir: fsx.ensureDir,
      ensureGitignoreLine: fsx.ensureGitignoreLine,
      writeWorkerPid: fsx.writeWorkerPid,
      removeDir: fsx.removeDir,
    },
    gh: {
      editLabels: async (issue, remove, add) => {
        await ghx.editLabels(ghCtx, issue, remove, add);
      },
      comment: (issue, body) => ghx.comment(ghCtx, issue, body),
    },
    git: {
      deleteRemoteBranch: (branch) => gitx.deleteRemoteBranch(gitCtx, branch),
      deleteLocalBranch: (branch) => gitx.deleteLocalBranch(gitCtx, branch),
    },
    lookups: {
      // Live-claim ownership for the orphan sweep (#644): a dead attempt dir
      // naming an issue whose claims/{N}/pid is a LIVE process is claim-race
      // debris, not a mid-issue crash — the sweep removes it without touching
      // the winner's `running` label.
      claimHolderAlive: (issue) => fsx.claimPathHeldByLivePid(join(afkPaths(ctx.root).tmpDir, "claims", String(issue))),
      // Orphan state pairs gh issue state/label with the attempt dir's
      // envelope.posted flag (read from the state file, not gh). Derived from
      // the batched map, preserving ghx.orphanState's exact label/state →
      // verdict mapping (ready-for-human > running > null). On a map MISS the
      // issue isn't in the list window — fall back to the live read so a
      // truncated/just-created/transient issue still classifies correctly.
      orphanState: async (issue) => {
        const row = issueStates.get(issue);
        if (!row) return ghx.orphanState(ghCtx, issue);
        const label = row.labels.includes(LABEL_HUMAN)
          ? LABEL_HUMAN
          : row.labels.includes(LABEL_RUNNING)
            ? LABEL_RUNNING
            : null;
        return { ghOk: true, state: row.state, label, envelopePosted: false };
      },
      branchIssue: (issue) => branchCache.get(issue),
      // Blocker state from the batched map: row.state ("OPEN"/"CLOSED") or
      // undefined on a miss. undefined-on-miss exactly matches the prior
      // 404→undefined→not-closed semantics — a missing blocker stays
      // "open-or-unknown" and the dependent issue is NOT promoted.
      blockerState: async (issue) => issueStates.get(issue)?.state,
      straggler: {
        unlabeled: () => ghx.countUnlabeled(ghCtx),
        needsTriage: () => ghx.countNeedsTriage(ghCtx),
        needsInfo: () => ghx.countNeedsInfo(ghCtx),
      },
    },
    nowS,
  };
}

/**
 * Assemble the per-issue {@link ProcessIssueDeps} — the hand-written binding of
 * ~21 real gh/git/fs/clock closures the audit flagged as untested. Exported so
 * the wiring integration test can drive the REAL assembly over a recording exec
 * fake (see tests/wiring-integration.test.ts).
 *
 * `exec` is the sole test-injection point: when supplied it is threaded into the
 * gh/git Contexts so every gh/git closure assembled here routes through the fake
 * instead of the OS. PRODUCTION leaves it undefined (see {@link runCommand}),
 * so the gh/git helpers fall through to the real `execTool` — byte-for-byte the
 * prior behaviour. Nothing else about the assembly changes.
 */
/**
 * Map a sandcastle agent stream event to an AFK pipeline stage, or `undefined`
 * when the event carries no stage signal (a text chunk, or an unrecognised
 * tool). Mirrors the shell *Stage Detection* table against tool calls: a git
 * commit → `commit`, a vitest/`pnpm test` run → `tests`, an Edit/Write → `impl`,
 * a Read/Grep/`git ls-files`/`find` → `explore`. Used by `recordAgentEvent` to
 * advance `current.stage` in afk.state.json so the monitor reflects progress;
 * keyed off tool calls (not every text chunk) to bound the state-write rate.
 */
export function deriveStage(event: AgentStreamEvent): string | undefined {
  if (event.type !== "toolCall") return undefined;
  const name = event.name.toLowerCase();
  const args = event.formattedArgs.toLowerCase();
  if (/\bgit\s+commit\b/.test(args)) return "commit";
  // Tool-name classification wins for file tools BEFORE the loose args `test`
  // match (#589): reading/grepping/editing a path that merely CONTAINS "test"
  // (e.g. `src/test-utils.ts`) is explore/impl, not a test run. The `\btest\b`
  // args check below is for command tools running an actual test runner.
  if (/^(edit|write|multiedit|notebookedit)$/.test(name)) return "impl";
  if (/^(read|grep|glob)$/.test(name)) return "explore";
  if (/\b(vitest|jest|pnpm[^|]*\btest\b|\btest\b)\b/.test(args)) return "tests";
  if (/\bgit\s+ls-files\b|\bfind\b/.test(args)) return "explore";
  return undefined;
}

function parseSlot(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function buildProcessDeps(
  ctx: RepoContext,
  model: string,
  sandbox: ReturnType<typeof resolveRunSettings>["sandbox"],
  feedback: FeedbackWorktree,
  current: CurrentAttempt,
  fallbackRunner: boolean,
  runner: Runner,
  exec?: ExecFn,
  maxIterations?: number,
  attemptTimeoutSeconds?: number,
  laneIdle?: LaneIdleStallConfig,
): ProcessIssueDeps {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo, exec };
  const gitCtx: GitContext = { cwd: ctx.root, exec };
  const paths = afkPaths(ctx.root);
  const lockPath = branchLockPath(ctx.root);
  // Per-agentic-iteration boundary tracking (observability): when sandcastle's
  // re-invocation count (event.iteration) ticks, emit "iteration N ended/started"
  // markers. Reset per attempt — a new attempt's run restarts at iteration 1
  // (detected by the attempt dir changing or the count going backwards).
  const iterMax = maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let lastIter = 0;
  let lastIterDir = "";

  // ---- lifecycle hooks: load config + resolve built-in defaults + real exec ----
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const resolveOptions = makeHookResolveOptions(ctx.root);
  // resolveHooks runs once here to surface a malformed-hook-name error early;
  // process-issue re-resolves per run from the same config + options.
  resolveHooks(config, resolveOptions);

  // Merge-gate policy (ADR 0048). Default off → the unlocked admin-merge ignores
  // advisory review checks (drift-guard + in-process backpressure stay the
  // binding gates). When `afk.merge.wait_for_review` is true, the unlocked
  // landing holds until the configured review check (`afk.merge.review_check`)
  // concludes, then merges regardless of the verdict.
  const waitForReview =
    getConfig(config, "afk.merge.wait_for_review") === "true"
      ? {
          check: getConfig(config, "afk.merge.review_check") || "CodeRabbit",
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        }
      : undefined;

  return {
    gh: {
      viewLabels: (issue) => ghx.viewLabels(ghCtx, issue),
      editLabels: (issue, remove, add) => ghx.editLabels(ghCtx, issue, remove, add),
      ensureLabel: async (name) => {
        try {
          await ghx.ensureLabel(ghCtx, name);
        } catch {
          // best-effort: a missing typed label must never fail the close.
        }
      },
      comment: (issue, body) => ghx.comment(ghCtx, issue, body),
      editBody: (issue, body) => ghx.editBody(ghCtx, issue, body),
      close: (issue) => ghx.closeIssue(ghCtx, issue),
      listByLabel: (label) => ghx.listByLabel(ghCtx, label),
      issueClosed: (n) => ghx.issueClosed(ghCtx, n),
    },
    claimLock: {
      // Atomic POSIX mkdir lock (#434): a non-recursive mkdir that fails EEXIST,
      // so two simultaneous boots cannot both claim the same issue. The prior
      // pathExists+ensureDir form was check-then-act and raced into dup PRs.
      acquire: (issue) => fsx.tryAcquireClaimDir(`${paths.tmpDir}/claims/${issue}`, process.pid),
      release: async (issue) => {
        await fsx.removeDir(`${paths.tmpDir}/claims/${issue}`);
      },
    },
    fs: {
      ensureAttemptDir: (dir) => fsx.ensureDir(dir),
      writeHandoff: (path, content) => fsx.writeHandoff(path, content),
      // $ITER_DIR/validation.jsonl — the machine-readable feedback sidecar the
      // Memory bridge consumes (SKILL.md §Validation Sidecar).
      writeValidationSidecar: (path, lines) => fsx.writeValidationSidecar(path, lines),
      completionSweep: (issue) => fsx.completionSweep(paths.workersRoot, issue),
    },
    git: {
      headShortSha: () => gitx.headShortSha(gitCtx),
      deleteLocalBranch: (branch) => gitx.deleteLocalBranch(gitCtx, branch),
      // Make the resolved base ref current before sandcastle forks off it
      // (ADR 0031). Best-effort: a fetch failure leaves sandcastle on the
      // stale/HEAD default rather than aborting the iteration.
      fetchBase: async (base) => {
        await gitx.gitExec(gitCtx)(["fetch", ctx.remote, base]);
      },
    },
    mergeExec: gitx.mergeExec(gitCtx),
    remoteGit: gitx.gitExec(gitCtx),
    // Commit-leftovers salvage: when the inner agent emits DONE / exits without
    // committing (observed with codex), commit its dirty worktree onto the worker
    // branch so the feedback gate + landing see the work instead of an empty
    // merge. No-op when the worktree is clean. Best-effort.
    salvageUncommitted: (branch) => gitx.salvageUncommitted(gitCtx, branch, ctx.remote),
    // Feedback runs against a checkout of the worker branch — the feedback
    // worktree manager materialises it and rebases pnpm/layout onto it.
    pnpm: feedback.pnpm,
    layout: feedback.layout,
    // Backpressure gate (#430, PRD #429): operator-declared `afk.backpressure`
    // shell commands run against the same worker-branch checkout after feedback.
    backpressure: feedback.backpressure,
    backpressureCommands: readBackpressure(config),
    runAgent: makeRunAgent(sandbox, process.env, maxIterations, attemptTimeoutSeconds, laneIdle),
    model,
    classifyIssue: makeIssueClassifier(config, runner, ctx.root, exec),
    resolveTier: (activeRunner, taskClass = "think") => resolveTier(config, activeRunner, taskClass, process.env),
    fallbackRunner,
    waitForReview,
    // One-shot merge-conflict resolver (merge_resolve_conflict): re-enter the
    // configured runner in the LANDING WORKTREE (`cwd`, the isolated checkout the
    // locked merge happens in, #572) with the resolver prompt. The merge primitive
    // verifies git state afterwards, so a non-zero / thrown runner here is
    // swallowed. Mirrors run_claude / run_codex on the conflicted checkout.
    conflictResolver: async (prompt: string, cwd: string) => {
      const conflictTier = resolveTier(config, runner, "think", process.env);
      const invocation =
        runner === "codex"
          ? codexSpawnArgs({
              prompt,
              worktree: cwd,
              lastMessagePath: join(paths.tmpDir, "merge-resolve.last"),
              model: conflictTier.model,
              effort: conflictTier.effort,
            })
          : claudeSpawnArgs({ prompt, worktree: cwd });
      const { execTool } = await import("../runtime/exec.js");
      await execTool(invocation.command, invocation.args, { cwd });
    },
    // Isolated landing worktree for the LOCKED path (#572): a detached worktree at
    // <base> so the locked merge/push/rollback never `git -C`'s the primary
    // checkout. The primary branch is sacred — a rejected push's `reset --hard`
    // only rewinds this throwaway worktree, never the primary's WIP. A stale dir
    // from a prior crash is removed first so `worktree add` does not collide.
    makeLandingWorktree: async (base: string) => {
      const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
      const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "base";
      const dest = join(paths.tmpDir, "landing", `${slug}-${slot}`);
      await gitx.worktreeRemove(gitCtx, dest);
      const ok = await gitx.worktreeAdd(gitCtx, dest, base);
      return ok ? dest : null;
    },
    removeLandingWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
    hooks: {
      config,
      resolveOptions,
      exec: makeHookExec(ctx.root),
      env: hookEnv(ctx.repo, ctx.root, parseSlot(process.env.RED_AFK_SLOT)),
    },
    lookups: {
      base: {
        readLockedBranch: () => readLockedBranch(lockPath),
        fetchIssueBody: (n) => ghx.issueBody(ghCtx, n),
      },
      isLocked: () => isLocked(lockPath),
      comments: (issue) => ghx.issueComments(ghCtx, issue),
      issueUrl: (issue) => ghx.issueUrl(ghCtx, issue),
      // Restart-informed retry block (#255): read the prior attempt's markers
      // (failure.reason / snapshot-branch.ref) via the attempt-ledger.
      priorAttemptContext: async (issue) => {
        try {
          const context = await attemptLedgerContext(paths.tmpDir, issue);
          return context ? formatAttemptContext(context) : undefined;
        } catch {
          return undefined;
        }
      },
      changedFiles: (branch, base) => gitx.changedFiles(gitCtx, branch, base),
      diffstat: (branch, base) => gitx.diffstat(gitCtx, branch, base),
      // FIX E: confirm the sandcastle worker branch actually landed on the host
      // before the merge gate. Try once, fetch on a miss, then re-check — a still
      // -absent branch escalates instead of silently bypassing feedback.
      branchPresent: async (branch) => {
        if (await gitx.branchExists(gitCtx, branch)) return true;
        await gitx.fetchBranch(gitCtx, branch);
        return gitx.branchExists(gitCtx, branch);
      },
    },
    envelope: {
      git: gitx.gitExec(gitCtx),
      poster: async (issue, body) => {
        await ghx.comment(ghCtx, issue, body);
        return true;
      },
      // Markers/posted land in the CURRENT attempt dir, set per issue by
      // buildProcessInput before each processIssue call.
      writeMarkers: (markers) => fsx.writeFailureMarkers(current.attemptDir, markers),
      writePosted: (posted) => fsx.writeEnvelopePosted(current.attemptDir, posted),
    },
    nowEpoch: () => Math.floor(Date.now() / 1000),
    nowIso: () => new Date().toISOString(),
    // The per-iteration afk.log heartbeat boundary lives in the attempt dir.
    appendIterLog: (line) => {
      void fsx.appendLine(join(current.attemptDir, "afk.log"), line);
    },
    // Native-path liveness (#284 observability gap): sandcastle captures the
    // inner agent's stream itself, so on the native path nothing advances the
    // agent lane and its mtime freezes at iteration start — the stall detector
    // (reaper-signal) and monitor then read a live agent as silent. Forward
    // each sandcastle stream event to the clean agent lane (the liveness signal
    // supervisor-fs / reaper key off) and mirror it into the firehose afk.log.
    // Best-effort: lane-write failures are swallowed so observability can never
    // break a run (sandcastle also swallows any throw from this callback).
    recordAgentEvent: (event) => {
      const ts = new Date().toISOString();
      // Agentic-iteration boundary markers (synthetic — afk.log + firehose, NEVER
      // the agent lane). Emit "iteration N ended" + "iteration N+1 started" when
      // sandcastle's re-invocation count advances, so a run burning through
      // iterations (re-validating instead of emitting DONE) is visible.
      const dir0 = current.attemptDir;
      if (dir0 !== lastIterDir) {
        lastIterDir = dir0;
        lastIter = 0; // new attempt → fresh iteration count
      }
      if (event.iteration !== lastIter) {
        const emit = (line: string, phase: string, n: number): void => {
          void fsx.appendLine(join(dir0, "afk.log"), line);
          void appendRecord(join(dir0, "log.jsonl"), "iteration", line, {
            ts,
            fields: { extra: { iteration: String(n), phase } },
          }).catch(() => {});
        };
        if (lastIter > 0) emit(formatIterationMarker(lastIter, "ended", iterMax), "ended", lastIter);
        lastIter = event.iteration;
        emit(formatIterationMarker(lastIter, "started", iterMax), "started", lastIter);
        void updateState(join(dir0, "afk.state.json"), { "current.iteration": String(lastIter) }).catch(() => {});
      }
      const msg = event.type === "text" ? event.message : `→ ${event.name} ${event.formattedArgs}`;
      void appendAgentRecord(join(current.attemptDir, "agent.log.jsonl"), msg, {
        ts,
        fields: { extra: { iteration: String(event.iteration), kind: event.type } },
      }).catch(() => {});
      // Firehose lane (issue #250): every record in the uniform envelope. The
      // native port left this unopened; restore it so the post-mortem firehose
      // carries the agent turns alongside the (future) heartbeat/hook records.
      void appendRecord(join(current.attemptDir, "log.jsonl"), "agent", msg, {
        ts,
        fields: { extra: { iteration: String(event.iteration), kind: event.type } },
      }).catch(() => {});
      void fsx.appendLine(join(current.attemptDir, "afk.log"), `[agent] ${msg}`);
      // Advance the monitor's state view on recognised tool-call transitions
      // (bounded write rate vs every text chunk — the lane mtime above is the
      // stall-detector's liveness signal; this is the dashboard's stage/last).
      const stage = deriveStage(event);
      if (stage) {
        void updateState(join(current.attemptDir, "afk.state.json"), {
          "current.stage": stage,
          "current.last_stream_line": msg.slice(0, 200),
        }).catch(() => {});
      }
    },
    // Externalized proof-of-life sink (PR-B): the attempt-guard fires this each
    // poll (~60s) with the progress signal. Append an enriched `type=heartbeat`
    // firehose record carrying the live LINE-DIFF (+A -R) AND mirror
    // `current.{last_progress_at,diff_added,diff_removed}` into the state file, so
    // each tick shows how the attempt is evolving and the monitor's +A -R stays
    // fresh between its sparse 10-min ticks (#448). Best-effort — swallowed.
    emitHeartbeat: (info) => {
      const ts = new Date().toISOString();
      const secs = Math.max(0, Math.floor((info.nowMs - info.lastProgressMs) / 1000));
      const lastProgressAt = new Date(info.lastProgressMs).toISOString();
      const head = info.head ?? "";
      void (async () => {
        // sandcastle creates the agent's worktree at
        // `{attemptDir}/.sandcastle/worktrees/{slug}`, NOT the legacy
        // `{attemptDir}/worktree` the state seeds — diffing the latter fails
        // (it never exists) and every tick read a permanent `+0 -0` even with a
        // dirty worktree, which also starved the attempt-progress guard's
        // proof-of-life. Resolve the real worktree from `git worktree list`,
        // and persist it into `current.worktree` so the monitor (which reads
        // that field for its own diffstat) gets the live path too. Fall back to
        // the legacy path only when no worktree is registered yet.
        const worktree =
          (await gitx.worktreePathUnder(gitCtx, current.attemptDir).catch(() => undefined)) ??
          join(current.attemptDir, "worktree");
        const baseRef = info.base ? `origin/${info.base}` : "origin/main";
        const { added, removed } = await gitx
          .diffstatShortstat({ cwd: worktree }, baseRef)
          .catch(() => ({ added: 0, removed: 0 }));
        const hb = buildProgressHeartbeat({
          secsSinceProgress: secs,
          lastProgressAt,
          head,
          added,
          removed,
        });
        await appendRecord(join(current.attemptDir, "log.jsonl"), "heartbeat", hb.msg, {
          ts,
          fields: { extra: hb.extra },
        }).catch(() => {});
        await fsx.appendLine(join(current.attemptDir, "afk.log"), `[heartbeat] ${hb.msg}`);
        await updateState(join(current.attemptDir, "afk.state.json"), {
          ...hb.statePatch,
          "current.worktree": worktree,
          ...(info.base ? { "current.base": info.base } : {}),
        }).catch(() => {});
      })();
    },
    historyPath: paths.historyPath,
    historyClock: { ts: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000) },
    // BOUNDED auto-recovery reads its RED_AFK_RETRY_* caps from the process env.
    recoveryEnv: process.env,
    // ADR 0017: best-effort AFK→Memory "reasoning attempt" recording. Serialise
    // the payload to a temp JSON file under the attempt dir, then exec the memory
    // CLI DIRECTLY (`<memoryCli> attempt record --root <root>` with the payload on
    // stdin). The resolver gates on memory availability (ADR 0009) — a silent
    // no-op when memory is absent / not opted-in — replacing the old shell-bridge
    // hop. ALL errors are swallowed (one warn line), so a memory failure can
    // NEVER fail the close.
    recordAttempt: makeRecordAttempt(ctx.root, current, exec),
  };
}

function makeIssueClassifier(
  config: import("../core/config.js").ConfigValues,
  runner: Runner,
  cwd: string,
  exec?: ExecFn,
): (metadata: IssueClassificationMetadata) => Promise<import("../core/config.js").AfkModelTier> {
  return async (metadata) => {
    const validateTier = resolveTier(config, runner, "validate", process.env);
    return classifyIssue(metadata, async ({ prompt }) => {
      const run = exec ?? (await import("../runtime/exec.js")).execTool;
      const common = { cwd, timeoutMs: 45_000, maxBuffer: 1024 * 1024 };
      const result =
        runner === "codex"
          ? await run(
              "codex",
              [
                "exec",
                "--model",
                validateTier.model,
                "-c",
                `model_reasoning_effort=${validateTier.effort}`,
                "-C",
                cwd,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                prompt,
              ],
              common,
            )
          : await run(
              "claude",
              [
                "--model",
                validateTier.model,
                "--effort",
                validateTier.effort,
                "--permission-mode",
                "bypassPermissions",
                "--print",
                prompt,
              ],
              common,
            );
      return result.code === 0 ? result.stdout.trim() : undefined;
    });
  };
}

/** Read the `version` field of a JSON manifest file, or undefined when the file
 * is missing / unparseable / has no version. The version-keyed cache-bundle
 * candidate in {@link resolveMemoryCli} uses this to locate the fetched CLI. */
function readManifestVersion(path: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the best-effort `recordAttempt` port (ADR 0017). On each call it resolves
 * the memory CLI ({@link resolveMemoryCli}, which gates on the ADR 0009 opt-in
 * config + the bridge's candidate order), writes the payload to a temp JSON file
 * under the current attempt dir, and execs the memory CLI DIRECTLY:
 * `<memoryCli> attempt record --root <gitRoot>` with the payload piped on stdin
 * — exactly what the bridge's `memory_record_attempt` did, minus the shell hop.
 * `MEMORY_REPO_ROOT` is set in the child env (as the bridge expected) so an
 * in-repo memory checkout resolves. When no CLI resolves the call is a silent
 * no-op (memory not installed). Every error (write failure, non-zero exit, spawn
 * error) is SWALLOWED — at most one warn line is written.
 *
 * `exec` is the test-injection seam (mirrors the rest of buildProcessDeps); in
 * production it is undefined and the real `execTool` is used.
 */
function makeRecordAttempt(
  gitRoot: string,
  current: CurrentAttempt,
  exec?: ExecFn,
): (payload: AttemptRecordPayload) => Promise<void> {
  return async (payload: AttemptRecordPayload): Promise<void> => {
    try {
      const env = { ...process.env, MEMORY_REPO_ROOT: process.env.MEMORY_REPO_ROOT ?? gitRoot };
      const memoryCli = resolveMemoryCli(gitRoot, env, {
        exists: existsSync,
        readJsonVersion: readManifestVersion,
        readText: (path) => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return undefined;
          }
        },
      });
      if (!memoryCli) return; // memory not opted-in / no CLI resolves — silent skip.
      const dir = current.attemptDir || gitRoot;
      const payloadFile = join(dir, `memory-attempt-${payload.issueNumber}-a${payload.attemptNumber}.json`);
      await fsx.ensureDir(dir);
      const json = toMemoryPayload(payload);
      await writeFile(payloadFile, json, "utf8");
      const run = exec ?? (await import("../runtime/exec.js")).execTool;
      const [cmd, ...head] = memoryCli;
      await run(cmd, [...head, "attempt", "record", "--root", gitRoot], {
        cwd: gitRoot,
        env,
        input: json,
      });
    } catch (err) {
      process.stderr.write(`[afk] memory attempt-record skipped (best-effort): ${String(err)}\n`);
    }
  };
}

/** Per-issue mutable context the session-scoped process deps close over — the
 * attempt dir the envelope markers / iter-log write into. buildProcessInput
 * resets it before each processIssue call. */
interface CurrentAttempt {
  attemptDir: string;
}

const DEFAULT_RUNNER_TRANSIENT_COOLDOWN_S = 300;

async function recordBootError(workerDir: string, type: "boot-error" | "session-error", err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const payload = {
    type,
    at: new Date().toISOString(),
    message,
    stack,
  };
  await fsx.ensureDir(workerDir);
  await writeFile(join(workerDir, `${type}.log`), `${JSON.stringify(payload)}\n`, "utf8");
  process.stderr.write(`[afk] ${type}: ${message}\n`);
}

function runnerCircuitDir(tmpDir: string): string {
  return join(tmpDir, "runner-circuit");
}

function runnerCircuitPath(tmpDir: string, runner: Runner): string {
  return join(runnerCircuitDir(tmpDir), `${runner}.json`);
}

function runnerTransientCooldownS(env: Record<string, string | undefined>): number {
  const raw = env.RED_AFK_RUNNER_TRANSIENT_COOLDOWN_S;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RUNNER_TRANSIENT_COOLDOWN_S;
}

async function openRunnerCircuit(
  tmpDir: string,
  runner: Runner,
  nowS: number,
  env: Record<string, string | undefined>,
): Promise<void> {
  const cooldownS = runnerTransientCooldownS(env);
  await fsx.ensureDir(runnerCircuitDir(tmpDir));
  await writeFile(
    runnerCircuitPath(tmpDir, runner),
    `${JSON.stringify({
      runner,
      opened_at: nowS,
      expires_at: nowS + cooldownS,
      reason: "runner-transient",
    })}\n`,
    "utf8",
  );
}

async function runnerCircuitOpen(
  tmpDir: string,
  runner: Runner,
  nowS: number,
): Promise<boolean> {
  try {
    const raw = await readFile(runnerCircuitPath(tmpDir, runner), "utf8");
    const parsed = JSON.parse(raw) as { expires_at?: unknown };
    return typeof parsed.expires_at === "number" && parsed.expires_at > nowS;
  } catch {
    return false;
  }
}

/** Synchronous next-attempt resolver over the attempt-ledger's pure core, so it
 * can run inside the synchronous `buildProcessInput`. Walks `<tmp>/workers/*`
 * with readdirSync and feeds the pure `highestAttempt`: the next attempt is the
 * highest existing attempt for the issue + 1 (1 when none). Junk dirs never
 * bump the counter. A missing tree yields attempt 1. */
function nextAttemptSync(tmpDir: string, issue: number): number {
  let workers: string[];
  try {
    workers = readdirSync(join(tmpDir, "workers"));
  } catch {
    return 1;
  }
  const entries: AttemptDirEntry[] = [];
  for (const worker of workers) {
    if (!isValidWorkerId(worker)) continue;
    try {
      entries.push({ worker, basenames: readdirSync(join(tmpDir, "workers", worker)) });
    } catch {
      // not a directory / unreadable
    }
  }
  const best = highestAttempt(tmpDir, issue, entries);
  return best ? best.attempt + 1 : 1;
}

export async function runCommand(options: RunOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  const flags = parseRunFlags(options.args);
  // --model / --effort pre-set the env override (flag > env). Setting them on the
  // process env makes the override flow through both the in-process `--once` path
  // (resolveTier reads process.env) and the fleet path (buildWorkerEnv passes
  // RED_AFK_MODEL/RED_AFK_EFFORT through to workers — not in PASSTHROUGH_DENYLIST).
  if (flags.model) process.env.RED_AFK_MODEL = flags.model;
  if (flags.effort) process.env.RED_AFK_EFFORT = flags.effort;
  const detection = detectRunner({
    flag: flags.runnerFlag ?? parseRunnerFlag(options.args),
    processTree: callerProcessTreeNative(),
    scriptPath: process.argv[1],
  });
  const runner: Runner = isRunner(detection.runner) ? detection.runner : "claude";

  const ctx = await resolveRepoContext(cwd);
  const settings = resolveRunSettings(cwd, process.env, runner);
  const paths = afkPaths(cwd);

  // Worker id — probe the workers root for collisions.
  const existing = new Set((await collectMonitorInputs(cwd)).workers.map((w) => w.state.worker_id));
  const workerId = genWorkerId(Math.random, (id) => existing.has(id));
  // Emit the per-slot boot-stamp immediately so the supervisor's slot log
  // captures this worker's ID before any failure. The circuit-trip sweep
  // (sweepParkedSlot) parses `[afk] worker: wXXXX` lines from the slot log
  // to resolve all workers that ran in a parked slot — this stamp must appear
  // even when the worker fast-dies before writing worker.pid.
  process.stdout.write(`[afk] worker: ${workerId}\n`);

  // Supervisor-dispatched reconcile worker: bypass the normal boot+session and
  // validate-and-land the specific parked branch for `--reconcile-issue <n>`.
  if (flags.reconcileIssue !== undefined) {
    return runReconcileWorker(flags.reconcileIssue, runner, ctx, paths, workerId);
  }

  const facts = await collectPrecheckFacts(ctx);
  const nowS = Math.floor(Date.now() / 1000);

  const sessionCtx: SessionContext = {
    runner,
    workerId,
    iterCap: flags.iterCap,
    once: flags.once,
    filter: flags.filter,
    alternate: flags.alternate,
    bootOnly: flags.bootOnly,
    issueTemplate: {
      tmpDir: paths.tmpDir,
      repo: ctx.repo,
      repoDir: ctx.root,
      remote: ctx.remote,
      model: settings.model,
    },
  };

  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  // Boot discovery: orphan dirs, attempt-cap groups, branch refs, unblock
  // candidates. Resolved from disk/branches; gh state lookups stay lazy in the
  // boot deps.
  const bootstrap: BootstrapInput = {
    tmpDir: paths.tmpDir,
    stateDir: paths.stateDir,
    gitignorePath: paths.gitignorePath,
    workerDir: workerDirPath(paths.tmpDir, workerId),
    workerPidFile: workerPidFile(paths.tmpDir, workerId),
    workerPid: process.pid,
  };
  let bootOptions: BootOptions;
  let bootDeps: BootDeps;
  try {
    bootOptions = await collectBootOptions(ctx, facts, bootstrap, nowS);
    bootDeps = await buildBootDeps(ctx, bootOptions, nowS);
  } catch (err) {
    await recordBootError(bootstrap.workerDir, "boot-error", err).catch(() => {
      process.stderr.write(`[afk] boot-error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return 1;
  }

  // Feedback worktree manager — checks out the worker branch for the gate.
  const feedback = makeFeedbackWorktree(ctx.root, join(paths.tmpDir, "feedback"));

  // Wire the boot reconcile runner into bootDeps (step 7, ADR 0055).
  bootDeps = { ...bootDeps, reconcileRunner: makeBootReconcileRunner(ctx, paths, workerId, runner, feedback) };

  // Per-issue mutable attempt context the process deps' envelope/iter-log close
  // over; buildProcessInput resets it before each processIssue call.
  const current: CurrentAttempt = { attemptDir: "" };

  // --request/-r special block, threaded into the handoff the agent reads.
  const requestBlock = specialUserRequestBlock(flags.request);

  const deps: SessionDeps = {
    gh: { listCandidates: () => ghx.listCandidates(ghCtx) },
    runBoot,
    bootDeps,
    bootOptions,
    // Wrap the per-issue orchestrator so the attempt's state file is marked
    // not-live once it returns. Without this a terminal-but-preserved attempt
    // (e.g. blocked → dir kept) would keep showing the still-live orchestrator
    // pid and read as a live worker in `monitor`. Guarded by pathExists: on the
    // DONE path the completion sweep already removed the dir, and updateState
    // would mkdir it back, resurrecting a reaped attempt — so skip when gone.
    processIssue: async (pd, pi) => {
      const result = await processIssue(pd, pi);
      if (result.outcome === "runner-transient") {
        await openRunnerCircuit(paths.tmpDir, pi.runner, Math.floor(Date.now() / 1000), process.env).catch(() => {});
      }
      // Abandon means DELETE (#644): buildProcessInput pre-creates the attempt
      // dir + state (current.number, live pid) BEFORE the claim, so a lost race
      // leaves them naming an issue this worker never owned. The next boot's
      // orphan sweep would misread that as a mid-issue crash and restore
      // ready-for-agent over the live winner's `running` label.
      if (result.outcome === "claim-lost") {
        await fsx.removeDir(pi.attemptDir).catch(() => {});
        return result;
      }
      const sp = join(pi.attemptDir, "afk.state.json");
      if (await fsx.pathExists(sp)) await updateState(sp, { pid: 0 }).catch(() => {});
      return result;
    },
    processDeps: buildProcessDeps(ctx, settings.model, settings.sandbox, feedback, current, flags.fallbackRunner, runner, undefined, settings.maxIterations, settings.attemptTimeoutSeconds, settings.laneIdle),
    // Session-scoped lifecycle hooks (PRD #207): compose the same config /
    // resolver / exec / env the process deps use, so session + per-issue points
    // share one dispatcher rather than duplicating the wiring.
    hooks: {
      config: loadConfig(afkPaths(ctx.root).configPath, { warn: () => undefined }),
      resolveOptions: makeHookResolveOptions(ctx.root),
      exec: makeHookExec(ctx.root),
      env: hookEnv(ctx.repo, ctx.root, parseSlot(process.env.RED_AFK_SLOT)),
    },
    runnerCircuit: {
      isOpen: (r) => runnerCircuitOpen(paths.tmpDir, r, Math.floor(Date.now() / 1000)),
    },
    buildProcessInput: (candidate: IssueCandidate, c: SessionContext): ProcessIssueInput => {
      const attempt = nextAttemptSync(c.issueTemplate.tmpDir, candidate.number);
      const attemptDir = buildWorkerAttemptPath(c.issueTemplate.tmpDir, c.workerId, candidate.number, attempt);
      // Point the session-scoped envelope/iter-log closures at this attempt.
      current.attemptDir = attemptDir;
      // Native-path observability (sibling of #350): the shell era's iter_open
      // initialised afk.state.json here; the TS port's ensureAttemptDir is
      // mkdir-only, so every live native worker was invisible to `monitor` /
      // `statusline` and the fleet stall-detector (which key off this file's
      // pid + current.{number,stage} and its mtime). Restore it: write the
      // initial state with the live orchestrator pid so the worker shows up;
      // recordAgentEvent advances current.stage, and the processIssue wrapper
      // marks it not-live (pid:0) on terminal. Best-effort — never blocks work.
      const statePath = join(attemptDir, "afk.state.json");
      const startedAt = new Date().toISOString();
      void initState(statePath, {
        worker_id: c.workerId,
        pid: process.pid,
        runner: c.runner,
        log: join(attemptDir, "afk.log"),
        started_at: startedAt,
        "current.number": candidate.number,
        "current.title": candidate.title,
        "current.worktree": join(attemptDir, "worktree"),
        "current.handoff": join(attemptDir, "handoff.md"),
        "current.started_at": startedAt,
        "current.runner": c.runner,
        "current.stage": "setup",
      }).catch(() => {});
      // Append the --request block into the handoff body so the inner agent
      // (which reads handoff.md as its prompt) sees the special request.
      const body = requestBlock ? `${candidate.body}\n\n${requestBlock}` : candidate.body;
      return {
        issue: candidate.number,
        title: candidate.title,
        body,
        runner: c.runner,
        workerId: c.workerId,
        tmpDir: c.issueTemplate.tmpDir,
        attempt,
        attemptDir,
        repo: c.issueTemplate.repo,
        repoDir: c.issueTemplate.repoDir,
        remote: c.issueTemplate.remote,
        baseInput: { issueBody: candidate.body },
      };
    },
    emit: (line: string) => process.stdout.write(`${line}\n`),
  };

  let summary;
  try {
    summary = await runSession(deps, sessionCtx);
  } catch (err) {
    await recordBootError(bootstrap.workerDir, "session-error", err).catch(() => {
      process.stderr.write(`[afk] session-error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return 1;
  } finally {
    await feedback.cleanup();
  }

  if (!summary.boot.precheck.ok) {
    const failed = summary.boot.precheck.failed;
    process.stderr.write(`[afk] precheck failed: ${failed}\n`);
    return 1;
  }

  // Runner exhaustion (single without --fallback-runner, or both runners under
  // it) ends the run with exit 75 (EX_TEMPFAIL) so a supervisor retries once the
  // quota resets, rather than treating it as a clean drain (0) or hard fail (1).
  if (summary.exhausted) {
    process.stderr.write(`[afk] runner exhausted — exiting 75 (EX_TEMPFAIL); rerun when quota resets\n`);
    return 75;
  }
  if (summary.runnerTransient) {
    process.stderr.write(`[afk] runner transport/setup failed — exiting 75 (EX_TEMPFAIL); rerun when the runner backend is healthy\n`);
    return 75;
  }

  return 0;
}
