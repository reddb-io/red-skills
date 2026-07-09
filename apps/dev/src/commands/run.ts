import { parseRunnerFlag, detectRunner } from "../core/runner-detection.js";
import { callerProcessTreeNative } from "../runtime/caller-process.js";
import {
  runSession,
  runModeForCandidate,
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
import {
  classifyConflictedFileKind,
  partitionConflicts,
  type ConflictFinding,
} from "../core/merge-conflict-reconcile.js";
import { processIssue, type ProcessIssueDeps, type ProcessIssueInput } from "../core/process-issue.js";
import { passExitBarrier, passTerminalBarrier } from "../core/exit-barrier.js";
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
  buildBootDeps,
  buildMinimalBootDeps,
  makeRunAgent,
  resolveRepoContext,
  resolveRunSettings,
  type RepoContext,
  type AfkPaths,
} from "../runtime/wire.js";
import type { LaneIdleStallConfig } from "../core/lane-idle-reaper.js";
import { workerDir as workerDirPath, workerPidFile } from "../core/worker-paths.js";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import * as fsx from "../runtime/fs.js";
import type { GhContext } from "../runtime/gh.js";
import { buildReviewGh } from "../runtime/review-gh.js";
import type { GitContext } from "../runtime/git.js";
import { execTool, type ExecFn } from "../runtime/exec.js";
import { getConfig, loadConfig, readBackpressure, readPostAttemptFormat, resolveTier, resolveCiTimeoutSeconds } from "../core/config.js";
import { parseTrustPolicy, resolveActorTrust } from "../core/trust-gate.js";
import { resolveNotesLoopConfig } from "../core/notes-loop.js";
import {
  classifyIssue,
  resolveReviewGate,
  type IssueClassificationMetadata,
} from "../core/issue-classifier.js";
import { LABEL_READY_FOR_REVIEW, LABEL_GO_LANE, LABEL_SCOUT_LANE, LABEL_MERGE_CONFLICT } from "../core/triage-labels.js";
import { GO_ORIGIN, GO_WORKERS_SEGMENT } from "../core/go.js";
import { SCOUT_ORIGIN, SCOUT_WORKERS_SEGMENT } from "../core/scout.js";
import { resolveHooks } from "../core/hook-config.js";
import { attemptLedgerContext, formatAttemptContext, highestAttempt, type AttemptDirEntry } from "../core/attempt-ledger.js";
import { isValidWorkerId, WORKER_NAMESPACES } from "../core/worker-paths.js";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isLivePid } from "../runtime/kill-tree.js";
import { specialUserRequestBlock, claudeSpawnArgs, codexSpawnArgs } from "../core/runner-spawn.js";
import { buildWorkerAttemptPath } from "../core/worker-paths.js";
import { branchLockPath, readLockedBranch, isLocked } from "../runtime/lock.js";
import { makeHookExec, makeHookResolveOptions, hookEnv } from "../runtime/hooks.js";
import { makeFeedbackWorktree, type FeedbackWorktree } from "../runtime/feedback-worktree.js";
import {
  installProcessSafety,
  fileSafetyLogger,
  safetyLogPath,
  deathCauseForRecoveredWorker,
} from "../core/process-safety.js";
import { join } from "node:path";
import { hostFingerprintPrefix, workerIdentity } from "../core/host-identity.js";
import { appendAgentRecord, appendRecord } from "../core/jsonl-log.js";
import { initStateSync, readPidStartTime, updateState, writeIdentitySync } from "../core/state.js";
import { buildProgressHeartbeat, formatIterationMarker } from "../core/heartbeat.js";
import { resolveAttemptLoc, locMemoPath, type LocMemo } from "../core/loc-memo.js";
import { createActivityMeter } from "../core/activity-meter.js";
import { DEFAULT_MAX_ITERATIONS } from "../core/execution.js";
import type { AgentStreamEvent, AttemptBudget } from "../core/execution.js";
import { makeStaleClaimPredicate, resolveClaimStalenessConfig } from "../core/claim-staleness.js";
import { renderClaimComment } from "../core/claim.js";

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
  /** --origin <label>: spawn-time provenance stamped on the worker state
   * (`"afk"` | `"go"` | `"urgent"` | …). Set by each entry point so the
   * monitor/statusline can render per-source counts. */
  origin?: string;
  /** --lane <label>: the candidate-listing label the session drains. Defaults
   * to `ready-for-agent` (the fleet). `/go` passes its isolated `lane:go` so
   * its dedicated worker sees only the minted disposable issue and the running
   * fleet never does. */
  lane?: string;
  /** --pre-pr: route the run through the hardened pre-PR pipeline before opening
   * the PR (the `/go` `no-mistakes` dispatch mode, issue #923). */
  prePr: boolean;
  /** --local-merge: land the branch by an approved local fast-forward instead of
   * opening a PR (the `/go` `local-only` dispatch mode, issue #923). */
  localMerge: boolean;
  /** --yolo: the opt-in autonomy bump (`/go +yolo`, issue #923). */
  yolo: boolean;
  /** --verify <cmd>: one-shot inline command appended to backpressure for a
   * single `/go` dispatch when no configured harness exists. */
  verifyCommand?: string;
  /** --go-verify-retries <n>: bounded post-DONE machine-gate retry cap for `/go`. */
  goVerifyRetries?: number;
  /** --run-mode <mode>: execution mode modifier forwarded to `processIssue`.
   * `"scout"` activates the read-only investigation path — no commits, no push,
   * no PR, no merge; the agent report is posted as a comment and the disposable
   * issue closes. Additional modes may be added by future dispatch tiers. */
  runMode?: string;
  /** --force: bypass the live-supervisor boot guard (#1027). Operator accepts
   * the collision risk; a warning is printed but the run proceeds. */
  force: boolean;
}

/** Raised when --alternate is combined with --runner (mutually exclusive). */
export class RunFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunFlagError";
  }
}

/**
 * Probe the fleet supervisor pid file. Returns `{ live: true, pid }` when a
 * running supervisor is detected, `{ live: false }` otherwise (no file, stale
 * pid, or invalid content). `checkLivePid` is injectable so tests can provide a
 * fake process probe without spawning real processes (#1027).
 */
export async function probeFleetSupervisor(
  pidFile: string,
  checkLivePid: (pid: number) => boolean = isLivePid,
): Promise<{ live: true; pid: number } | { live: false }> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return { live: false };
    const pid = Number(raw);
    if (!checkLivePid(pid)) return { live: false };
    return { live: true, pid };
  } catch {
    return { live: false };
  }
}

/**
 * Detect a `/go` or `--scout` dispatch (#1087). These runs live in their OWN
 * worker namespace (`go-workers/` / `scout-workers/`), their own lane
 * (`lane:go` / `lane:scout`, never `ready-for-agent`), and carry `--origin
 * go`/`--origin scout` — so they can NEVER collide with a fleet's `workers/`
 * namespace, claims, or lane. The fleet-supervisor boot guard exists ONLY to
 * stop a second fleet from stomping the first on the shared `workers/`
 * namespace; it must not apply to these isolated dispatches, which the SKILL.md
 * contract requires to boot "whether or not a fleet is up". Detected via any of
 * the three redundant signals threaded through the boot context.
 */
export function isNamespacedDispatch(
  args: { origin?: string; lane?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (args.origin === GO_ORIGIN || args.origin === SCOUT_ORIGIN) return true;
  if (args.lane === LABEL_GO_LANE || args.lane === LABEL_SCOUT_LANE) return true;
  const ns = env.RED_AFK_WORKERS_NAMESPACE;
  if (ns === GO_WORKERS_SEGMENT || ns === SCOUT_WORKERS_SEGMENT) return true;
  return false;
}

/**
 * Apply the boot guard: refuse to start if a fleet supervisor is already live
 * (unless `--force` was passed). Returns `"refused"` when the caller should
 * abort, `"forced"` when the guard was bypassed with a warning, or `"clear"`
 * when no live supervisor was found.
 *
 * `exempt` (#1087) skips the `afk-supervisor.pid` check entirely for a
 * `/go`/`--scout` dispatch — an isolated, namespaced run that cannot collide
 * with the fleet, so a live supervisor must never block it.
 */
export async function checkBootGuard(
  pidFile: string,
  force: boolean,
  stdout: NodeJS.WritableStream,
  checkLivePid: (pid: number) => boolean = isLivePid,
  exempt = false,
): Promise<"refused" | "forced" | "clear"> {
  if (exempt) return "clear";
  const probe = await probeFleetSupervisor(pidFile, checkLivePid);
  if (!probe.live) return "clear";
  if (force) {
    stdout.write(`warn: --force: fleet supervisor pid=${probe.pid} is still running; collision risk accepted.\n`);
    return "forced";
  }
  stdout.write(
    `afk: a fleet supervisor is already running (pid=${probe.pid}).\n` +
      `  monitor the running fleet: /dev:afk fleet\n` +
      `  stop it first:             afk stop\n` +
      `  override (risk):           afk run --force\n`,
  );
  return "refused";
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
 * reproduce the exact semantics the dev suite asserts: `--spec`/`-n` map through
 * `Number`, `--issues` trims and filters to finite numbers, booleans are
 * present-or-absent, and `--request` accepts the `-r` short alias.
 */
const RUN_FLAG_SCHEMA = {
  spec: { kind: "value", coerce: (raw: string): SelectionFilter => ({ kind: "spec", spec: Number(raw) }) },
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
  origin: { kind: "value", coerce: (raw: string): string => raw },
  lane: { kind: "value", coerce: (raw: string): string => raw },
  "pre-pr": { kind: "boolean" },
  "local-merge": { kind: "boolean" },
  yolo: { kind: "boolean" },
  verify: { kind: "value", coerce: (raw: string): string => raw },
  "go-verify-retries": { kind: "value", coerce: (raw: string): number => Number(raw) },
  "run-mode": { kind: "value", coerce: (raw: string): string => raw },
  force: { kind: "boolean" },
} satisfies FlagSchema;

/** Parse the `run` flags: --spec N / --issues a,b,c / -n N / --once / --request / --runner. */
export function parseRunFlags(args: readonly string[]): ParsedRunFlags {
  const { values } = parseFlags(args, RUN_FLAG_SCHEMA);

  // --spec and --issues both feed `filter`; the last of the two in argv wins,
  // matching the original single-pass scan. Resolve order from the raw argv.
  let filter: SelectionFilter = { kind: "all" };
  let lastFilterPos = -1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === "--spec" || arg.startsWith("--spec=")) && values.spec !== undefined && i > lastFilterPos) {
      filter = values.spec as SelectionFilter;
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
    origin: values.origin as string | undefined,
    lane: values.lane as string | undefined,
    prePr: values["pre-pr"] === true,
    localMerge: values["local-merge"] === true,
    yolo: values.yolo === true,
    verifyCommand: values.verify as string | undefined,
    goVerifyRetries:
      typeof values["go-verify-retries"] === "number" && Number.isFinite(values["go-verify-retries"])
        ? values["go-verify-retries"] as number
        : undefined,
    runMode: values["run-mode"] as string | undefined,
    force: values.force === true,
  };
}

/**
 * Real mechanical-conflict resolver for the #1095 merge-conflict reland. Bound
 * to `gitCtx`, returns the port `preMergeRebase` invokes when a rebase onto
 * fresh trunk CONFLICTS: it lists the conflicted files, classifies each via the
 * closed mechanical allowlist (`classifyConflictedFileKind`), and auto-resolves
 * ONLY when EVERY conflict is mechanical (whitespace-only today) — otherwise it
 * declines so the rebase aborts and the branch re-parks for a human. On the
 * mechanical path it takes one (whitespace-equivalent) side per file, stages it,
 * and `git rebase --continue`s (editor suppressed). Any git/read failure → false.
 */
function makeMechanicalConflictResolver(gitCtx: GitContext): (repo: string) => Promise<boolean> {
  const git = gitx.gitExec(gitCtx);
  return async (repo: string): Promise<boolean> => {
    const list = await git(["-C", repo, "diff", "--name-only", "--diff-filter=U"]);
    if (list.code !== 0) return false;
    const paths = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (paths.length === 0) return false;

    const findings: ConflictFinding[] = [];
    for (const p of paths) {
      let body: string;
      try {
        body = await readFile(join(repo, p), "utf8");
      } catch {
        return false;
      }
      const kind = classifyConflictedFileKind(body);
      findings.push({ path: p, kind, description: `${kind} conflict in ${p}` });
    }
    // Intent-by-default: a single non-mechanical conflict declines the whole set.
    if (partitionConflicts(findings).nonMechanical.length > 0) return false;

    for (const p of paths) {
      // Whitespace-equivalent sides → taking either resolves it; keep the
      // worker's committed (validated) version, then stage.
      const checkout = await git(["-C", repo, "checkout", "--theirs", "--", p]);
      if (checkout.code !== 0) return false;
      const add = await git(["-C", repo, "add", "--", p]);
      if (add.code !== 0) return false;
    }
    const cont = await git(["-C", repo, "-c", "core.editor=true", "rebase", "--continue"]);
    return cont.code === 0;
  };
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
  const reconcileConfig = loadConfig(paths.configPath, { warn: () => undefined });
  const configLockedBranch = getConfig(reconcileConfig, "dev.lock.branch") || undefined;
  const configTrunk = getConfig(reconcileConfig, "dev.trunk") || undefined;

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
      // Isolated worker-branch worktree for the PR path's pre-merge rebase (#1006):
      // fetch base + rebase the branch + force-push run here, never the primary.
      makeRebaseWorktree: async (branch: string) => {
        const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
        const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
        const dest = join(paths.tmpDir, "rebase", `${slug}-boot-${slot}`);
        await gitx.worktreeRemove(gitCtx, dest);
        const ok = await gitx.worktreeAdd(gitCtx, dest, branch);
        return ok ? dest : null;
      },
      removeRebaseWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
      // #1095: only the merge-conflict reland auto-resolves mechanical rebase
      // conflicts; stalled/crashed relands keep the abort-on-any-conflict path.
      resolveMechanicalConflict: plan.labels.includes(LABEL_MERGE_CONFLICT)
        ? makeMechanicalConflictResolver(gitCtx)
        : undefined,
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
      // AFK runner improvement: feed process.env to the recovery policy so the
      // RED_AFK_RETRY_VALIDATION_INFRA cap on infra-rooted feedback failures
      // is overridable per-deployment (mirrors process-issue's binding).
      recoveryEnv: process.env,
    };

    try {
      // Resolve the effective base (lock > pin > main, ADR 0031) instead of a
      // literal "main": a parked issue pinned to a non-main branch — or a
      // branch-locked session — must reconcile and land against that branch,
      // never the trunk (#568, trunk safety). Mirrors the per-issue base lookup.
      const base = await resolveBase(
        { issueBody: plan.body },
        {
          readLockedBranch: () => readLockedBranch(lockPath),
          configLockedBranch,
          configTrunk,
          fetchIssueBody: (n) => ghx.issueBody(ghCtx, n),
        },
      );

      const reconcileInput: ReconcileInput = {
        issue: plan.number,
        title: plan.title,
        body: plan.body,
        labels: plan.labels,
        branch: plan.branch,
        base,
        // ADR 0083 landing precondition (#1018): the configured Trunk the primary
        // checkout tracks, for doLanding's local-trunk-divergence guard.
        trunk: configTrunk || "main",
        repo: ctx.repo,
        repoDir: ctx.root,
        remote: ctx.remote,
        workerId,
        attempt: 0,
        attemptDir: join(paths.tmpDir, "boot-reconcile", String(plan.number)),
        runner,
        // #1095: a `blocked:merge-conflict` park carries a branch that already
        // validated green before a land-time trunk conflict. Trust that prior
        // validation and skip re-running the local suite — doLanding's #1006
        // pre-merge rebase re-lands it on FRESH trunk and the PR's CI is the
        // merge gate. A branch that still conflicts re-parks merge-conflict.
        trustPriorValidation: plan.labels.includes(LABEL_MERGE_CONFLICT),
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

  const reconcileSettings = resolveRunSettings(ctx.root, process.env, runner);
  const feedback = makeFeedbackWorktree(ctx.root, join(paths.tmpDir, "feedback"), undefined, {
    rebaseOnto: reconcileSettings.feedbackRebaseBase,
  });
  try {
    const reconcileRunner = makeBootReconcileRunner(ctx, paths, workerId, runner, feedback);
    await reconcileRunner(plan);
  } finally {
    await feedback.cleanup();
  }

  return 0;
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
  attemptBudget?: AttemptBudget,
  inlineVerifyCommand?: string,
  goVerifyRetries?: number,
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
  // Per-attempt stream-activity meter (slice 1 liveness metrics): counts
  // toolCall/text events and derives waiting windows. Re-created when the
  // attempt dir changes so counts never bleed across the attempt boundary.
  let activityMeter = createActivityMeter();
  let activityMeterDir = "";
  // Last diff volume observed by the heartbeat sink, so the on_heartbeat vitals
  // provider (#832) can report loc_added/loc_removed alongside the meter's
  // activity counters without re-shelling `git diff`.
  let lastHeartbeatDiff = { added: 0, removed: 0 };
  // Per-attempt peak diff: the largest diff seen by the heartbeat for this attempt.
  // Reset at attempt boundaries (same guard as activityMeter). Written to the state
  // file so the statusline can show a sticky last-known value when the live diff
  // transiently drops to 0 (e.g. during the feedback gate).
  let peakLocAdded = 0;
  let peakLocRemoved = 0;
  let peakLocDir = "";

  // ---- lifecycle hooks: load config + resolve built-in defaults + real exec ----
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  // Trust policy for the guidance-channel source-trust projection (issue #1100).
  const trustPolicy = parseTrustPolicy(config);
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

  // CI-aware merge (#812). Default off → the unlocked admin-merge fires
  // immediately (fine on a base with NO required status checks). When
  // `afk.merge.ci_aware` is true, the unlocked landing first polls the PR's merge
  // state and admin-merges ONLY once it settles — because an admin-merge cannot
  // bypass required checks on an `enforce_admins` base, so merging a just-opened
  // PR with checks pending is rejected and was mislabelled `merge-conflict`. The
  // poll budget comes from `RED_AFK_MERGE_CI_TIMEOUT_S` (default 1800s) at a fixed
  // 10s cadence; on timeout the open, MERGEABLE PR is handed off (no agent re-run).
  const ciAwait =
    getConfig(config, "afk.merge.ci_aware") === "true"
      ? {
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          intervalMs: 10_000,
          maxPolls: Math.max(1, Math.ceil(resolveCiTimeoutSeconds(process.env) / 10)),
        }
      : undefined;

  // PR review gate (ADR 0064 §10, #749). Default off → AFK keeps fast-merging
  // every tier. When enabled, a NON-mechanical attempt (classified tier at/above
  // `afk.review_gate.threshold`) gets `ready-for-review` on its PR and holds the
  // merge for a fresh-agent review; mechanical/trivial work fast-merges as today.
  const reviewGate = resolveReviewGate(config);

  // Landing-mode flag (ADR 0030 amended, #842), decoupled from the lock. Default
  // true → the attempt lands via an admin-merged PR into the resolved base; false
  // → a direct merge into that base (offline, no PR). The lock only resolves the
  // base (ADR 0031). Honours the namespaced + legacy fallback via loadConfig.
  const worktreeLaunchesPr = getConfig(config, "afk.worktree_launches_pull_request") !== "false";

  // Intra-attempt notes-loop (Track C, #924). Default OFF → exactly one agent
  // call. When enabled, processIssue wraps the inner invocation in a bounded
  // outer loop carrying an accumulated `notes.md` between iterations.
  const notesLoop = resolveNotesLoopConfig(config);

  const backpressureCommands = readBackpressure(config);
  const mergedBackpressureCommands =
    inlineVerifyCommand && inlineVerifyCommand.trim() !== ""
      ? [...backpressureCommands, inlineVerifyCommand.trim()]
      : backpressureCommands;

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
      // Trust-gate provenance (#621): author + ready-for-agent label actor, read
      // from the issue timeline. Consulted at claim time only when an allowlist
      // is configured (plugins.dev.afk.trust-gate.allowlist) or the repo fails
      // closed (public + no allowlist, #1101).
      issueTrust: (issue) => ghx.issueTrust(ghCtx, issue),
      // Repository visibility (#1101): folds into the trust policy so a PUBLIC
      // repo with no allowlist fails closed while a private one stays permissive.
      repoVisibility: () => ghx.repoVisibility(ghCtx),
      // Dynamic-base trust signals (write-access / CODEOWNERS) for the fail-closed
      // default's author + promoter maintainer check (#1101, reusing #747).
      actorTrustSignals: (actor) => ghx.actorTrustSignals(ghCtx, actor),
      // HITL decision card (#935, S11a): post/update the card on escalation.
      // Best-effort: errors are caught in routeRecovery so they never block
      // the recovery path. Runs in the worktree root so gh resolves the repo.
      renderDecisionCard: async (issue) => {
        const { hitlCardCommand } = await import("./hitl-card.js");
        await hitlCardCommand(["render", `--issue=${issue}`, `--root=${ctx.root}`]);
      },
      findMainRedRepairIssue: () => ghx.findMainRedRepairIssue(ghCtx),
      createMainRedRepairIssue: (spec) => ghx.createMainRedRepairIssue(ghCtx, spec),
      updateMainRedRepairIssue: (issue, spec) => ghx.updateMainRedRepairIssue(ghCtx, issue, spec),
      closeMainRedRepairIssue: (issue, closeComment) => ghx.closeMainRedRepairIssue(ghCtx, issue, closeComment),
    },
    claimGh: {
      // ADR 0066: the atomic GitHub-native claim arbiter. Numeric comment ids
      // (via `gh api`) are the cross-host total order.
      postClaim: (issue, body) => ghx.postClaimComment(ghCtx, issue, body),
      listClaims: (issue) => ghx.listClaimComments(ghCtx, issue),
      concede: async (issue, body) => {
        try {
          await ghx.postClaimComment(ghCtx, issue, body);
        } catch {
          // best-effort: a failed concede ages out via the staleness predicate.
        }
      },
      // One human-visible audit comment when we recover a stale cross-host claim
      // (#627). Best-effort: a failed audit never abandons the won claim.
      audit: async (issue, body) => {
        try {
          await ghx.comment(ghCtx, issue, body);
        } catch {
          // best-effort observability; the claim is already won.
        }
      },
    },
    // Cross-host stale-claim recovery (#627, ADR 0066): a claim whose owner
    // stopped refreshing past `cadence × (tolerance + 1)` is presumed dead and
    // released by this sweep. The clock is sampled once per issue at deps build;
    // the policy comes from RED_AFK_CLAIM_REFRESH_S / RED_AFK_CLAIM_STALE_TOLERANCE.
    claimStale: makeStaleClaimPredicate(
      Math.floor(Date.now() / 1000),
      resolveClaimStalenessConfig(process.env),
    ),
    // AFK runner improvement (Pattern 5 — make the diagnostic actionable): when
    // a stale-claim recovery releases a SAME-HOST predecessor, read its
    // process-safety diagnostic log and surface the death cause in the recovery
    // audit comment. The self identity only needs the host for the same-host
    // gate (a cross-host predecessor's log isn't on this filesystem).
    recoveredWorkerDeathCause: (recoveredWorker) =>
      deathCauseForRecoveredWorker(paths.tmpDir, recoveredWorker, hostFingerprintPrefix()),
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
      prepareFreshWorkerBranch: (input) =>
        gitx.prepareFreshWorkerBranch(gitCtx, { ...input, remote: ctx.remote }),
    },
    mergeExec: gitx.mergeExec(gitCtx),
    remoteGit: gitx.gitExec(gitCtx),
    // Commit-leftovers salvage: when the inner agent emits DONE / exits without
    // committing (observed with codex), commit its dirty worktree onto the worker
    // branch so the feedback gate + landing see the work instead of an empty
    // merge. No-op when the worktree is clean. Best-effort.
    salvageUncommitted: (branch) => gitx.salvageUncommitted(gitCtx, branch, ctx.remote),
    // ADR 0083 §4 exit barrier (DONE tracer, #1020): the single owner of the DONE
    // path's terminal exit — salvage-commit dirty worktree paths, push the branch
    // to origin (retry once), and return the auditable receipt. Bound over the same
    // GitContext: salvage reuses `salvageUncommitted`, push uses `pushBranch`, and
    // the head sha is read from the pushed local ref.
    exitBarrier: (branch) =>
      passExitBarrier(
        {
          salvage: (b) => gitx.salvageUncommitted(gitCtx, b, ctx.remote),
          push: (b) => gitx.pushBranch(gitCtx, b, ctx.remote),
          headSha: async (b) => (await gitx.branchHead(gitCtx, b)) ?? "",
          nowIso: () => new Date().toISOString(),
        },
        branch,
      ),
    // ADR 0083 §4 exit barrier (every-terminal, #1021): the FAILURE-terminal
    // crossing bound over the SAME GitContext as the DONE barrier — guard abort,
    // stall-kill, crash teardown, and (via reconcile) the no-agent lane all pass
    // through it. Unlike the DONE barrier it never throws; a rejected push is
    // recorded in the receipt (`pushed:false`) so the failing attempt still
    // terminates but the branch state is reported truthfully.
    terminalExitBarrier: (branch) =>
      passTerminalBarrier(
        {
          salvage: (b) => gitx.salvageUncommitted(gitCtx, b, ctx.remote),
          push: (b) => gitx.pushBranch(gitCtx, b, ctx.remote),
          headSha: async (b) => (await gitx.branchHead(gitCtx, b)) ?? "",
          nowIso: () => new Date().toISOString(),
        },
        branch,
      ),
    // Feedback runs against a checkout of the worker branch — the feedback
    // worktree manager materialises it and rebases pnpm/layout onto it.
    pnpm: feedback.pnpm,
    layout: feedback.layout,
    // Backpressure gate (#430, PRD #429): operator-declared `afk.backpressure`
    // shell commands run against the same worker-branch checkout after feedback.
    backpressure: feedback.backpressure,
    backpressureCommands: mergedBackpressureCommands,
    // Non-blocking backpressure evidence review (#1279): render the executed
    // backpressure checks as ONE aggregated `event: COMMENT` review on the PR.
    // Reuses ReviewGh.postReview (COMMENT-only, no APPROVE/REQUEST_CHANGES) with
    // no inline comments — purely a top-level evidence ledger. Observability only;
    // it never touches the merge/park decision.
    postBackpressureReview: (pr, body) =>
      buildReviewGh(ghCtx).postReview(pr, { summary: body, comments: [] }),
    goVerifyRetries,
    // Post-attempt-format step (#1015): operator-declared `afk.post_attempt_format`
    // commands run BEFORE the feedback gate and auto-commit any formatting delta.
    postAttemptFormat: feedback.postAttemptFormat,
    postAttemptFormatCommands: readPostAttemptFormat(config),
    // #908: thread the resolved budget + a LIVE usage probe off this attempt's
    // activity meter (late-bound — `activityMeter` is reassigned per attempt dir,
    // and `peek()` returns a superset of AttemptBudgetUsage). makeRunAgent only
    // wires it when the progress guard is armed.
    runAgent: makeRunAgent(
      sandbox,
      process.env,
      maxIterations,
      attemptTimeoutSeconds,
      laneIdle,
      attemptBudget,
      () => activityMeter.peek(),
    ),
    sandboxMode: sandbox,
    sandboxAvailable: async (mode) => {
      const run = exec ?? execTool;
      return (await run("sh", ["-c", `command -v ${mode}`], { cwd: ctx.root })).code === 0;
    },
    model,
    classifyIssue: makeIssueClassifier(config, runner, ctx.root, exec),
    resolveTier: (activeRunner, taskClass = "think") => resolveTier(config, activeRunner, taskClass, process.env),
    fallbackRunner,
    waitForReview,
    ciAwait,
    worktreeLaunchesPr,
    reviewGate,
    reviewGateLabel: LABEL_READY_FOR_REVIEW,
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
    // Isolated worker-branch worktree for the PR path's pre-merge rebase (#1006):
    // fetch base + rebase the branch + force-push run here, never the primary.
    makeRebaseWorktree: async (branch: string) => {
      const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
      const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
      const dest = join(paths.tmpDir, "rebase", `${slug}-${slot}`);
      await gitx.worktreeRemove(gitCtx, dest);
      const ok = await gitx.worktreeAdd(gitCtx, dest, branch);
      return ok ? dest : null;
    },
    removeRebaseWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
    hooks: {
      config,
      resolveOptions,
      exec: makeHookExec(ctx.root),
      env: hookEnv(ctx.repo, ctx.root, parseSlot(process.env.RED_AFK_SLOT), runner),
    },
    lookups: {
      base: {
        readLockedBranch: () => readLockedBranch(lockPath),
        configLockedBranch: getConfig(config, "dev.lock.branch") || undefined,
        configTrunk: getConfig(config, "dev.trunk") || undefined,
        fetchIssueBody: (n) => ghx.issueBody(ghCtx, n),
      },
      isLocked: () => isLocked(lockPath),
      // Source-trust classification for the guidance channel (issue #1100): each
      // comment's author is resolved through the `resolveActorTrust` primitive so
      // only a trusted-source directive can become authoritative `<human-guidance>`.
      comments: (issue) =>
        ghx.issueComments(ghCtx, issue, (actor) =>
          resolveActorTrust(trustPolicy, actor, (login) => ghx.actorTrustSignals(ghCtx, login)),
        ),
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
      // Goal predicate own-merge signal (ADR 0057): true iff the worker branch
      // already landed in <base>, distinguishing own-merge close (done) from a
      // foreign close (claim-lost) when the guard observes the issue CLOSED.
      branchMerged: (branch, base) => gitx.branchMergedInto(gitCtx, branch, base),
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
      // Raw stdout lines (sandcastle 0.11.0 verbose stream `{type:"raw"}`) are
      // noisy per-line output, not assistant turns. Fan them to the FIREHOSE only
      // so a stuck/silent agent stays diagnosable, while the clean agent lane keeps
      // its one-record-per-turn invariant. Not a liveness/activity unit, so skip
      // the meter + iteration markers. Returning here also narrows `event` to the
      // non-raw variants for the rest of the handler.
      if (event.type === "raw") {
        void appendRecord(join(current.attemptDir, "log.jsonl"), "raw", event.line, {
          ts,
          fields: { extra: { kind: "raw", iteration: String(event.iteration) } },
        }).catch(() => {});
        return;
      }
      if (event.type === "sessionId") {
        void appendRecord(join(current.attemptDir, "log.jsonl"), "session", `session ${event.sessionId}`, {
          ts,
          fields: {
            extra: {
              kind: "sessionId",
              iteration: String(event.iteration),
              session_id: event.sessionId,
            },
          },
        }).catch(() => {});
        return;
      }
      // Agentic-iteration boundary markers (synthetic — afk.log + firehose, NEVER
      // the agent lane). Emit "iteration N ended" + "iteration N+1 started" when
      // sandcastle's re-invocation count advances, so a run burning through
      // iterations (re-validating instead of emitting DONE) is visible.
      const dir0 = current.attemptDir;
      if (dir0 !== lastIterDir) {
        lastIterDir = dir0;
        lastIter = 0; // new attempt → fresh iteration count
      }
      // New attempt → fresh activity meter (counts must not bleed across attempts).
      if (dir0 !== activityMeterDir) {
        activityMeterDir = dir0;
        activityMeter = createActivityMeter();
      }
      // New attempt → reset peak diff (peaks are per-attempt, not per-worker).
      if (dir0 !== peakLocDir) {
        peakLocDir = dir0;
        peakLocAdded = 0;
        peakLocRemoved = 0;
      }
      if (
        event.type === "text" ||
        event.type === "toolCall" ||
        event.type === "reasoning" ||
        event.type === "usage"
      ) {
        activityMeter.record(event);
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
      const msg =
        event.type === "text"
          ? event.message
          : event.type === "reasoning"
            ? `🧠 reasoning${
                event.tokens ? ` (${event.tokens} tok)` : event.message ? `: ${event.message.slice(0, 80)}` : ""
              }`
            : event.type === "usage"
              ? `💰 usage (in:${event.inputTokens} out:${event.outputTokens}${
                  event.reasoningTokens ? ` reason:${event.reasoningTokens}` : ""
                })`
              : event.type === "result"
                ? `result: ${event.result}`
                : `→ ${event.name} ${event.formattedArgs}`;
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
      // The plaintext `[agent] …` mirror into afk.log is intentionally gone:
      // red-castle's file-log now points at the SAME afk.log (process-issue.ts), so
      // it already renders agent text + tool calls there — re-appending here would
      // double every turn. The structured per-event record stays in agent.log.jsonl
      // + the firehose above, where the rich reasoning/usage glyphs live.
      // Advance the monitor's state view on recognised tool-call transitions
      // (bounded write rate vs every text chunk — the lane mtime above is the
      // stall-detector's liveness signal; this is the dashboard's stage/last).
      // `last_event_at` (the honest liveness clock, ADR 0065) is stamped on every
      // DISCRETE event — tool/reasoning/usage/result, not per-text-chunk — so it advances
      // every few seconds for an active worker even between commits.
      const stage = deriveStage(event);
      const discrete =
        event.type === "toolCall" ||
        event.type === "reasoning" ||
        event.type === "usage" ||
        event.type === "result";
      // A `usage` event is the only carrier of the cost group, and for claude it
      // arrives exactly ONCE — on the terminal result line, AFTER the last
      // heartbeat poll and just before the agent exits. The ~60s heartbeat is
      // what normally folds the meter's cost into state, but it never fires again
      // once the agent completes, so a single-iteration claude run persisted
      // cost_usd=0 despite real token spend. Flush the cumulative cost from the
      // meter the instant a usage event lands (ADR 0065). Idempotent: codex emits
      // many usage events and each just re-stamps the running total.
      const costPatch =
        event.type === "usage"
          ? {
              "current.input_tokens": activityMeter.peek().inputTokens,
              "current.output_tokens": activityMeter.peek().outputTokens,
              "current.cost_usd": activityMeter.peek().costUsd,
            }
          : {};
      if (stage || discrete) {
        void updateState(join(current.attemptDir, "afk.state.json"), {
          ...(stage ? { "current.stage": stage, "current.last_stream_line": msg.slice(0, 200) } : {}),
          // Any inner-agent stream activity means we are in the macro `coding`
          // phase (collapses explore/impl/tests/commit — the fine stage lives in
          // the description, so the title never flickers, issue #811). Idempotent:
          // re-stamping `coding` each event is a no-op write.
          "current.phase": "coding",
          "current.last_event_at": ts,
          ...costPatch,
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
        // Fall back to the configured Trunk (ADR 0083), not a literal "main".
        const baseRef = info.base
          ? `origin/${info.base}`
          : `origin/${getConfig(config, "dev.trunk") || "main"}`;
        // Writer-side LOC ownership (#1210 Part B): the render paths no longer
        // shell out to `git diff --shortstat`, so this heartbeat is the runner-
        // agnostic owner that stamps loc_added/loc_removed for ALL runners (codex
        // included). The COMMITTED delta is EXPENSIVE but stable between commits,
        // so memoize it against the current HEAD sha in the attempt dir — computed
        // at most once per commit; while HEAD is unchanged the memoized volume is
        // served without spawning git. The UNCOMMITTED working-tree delta is
        // recomputed every tick and added on top (#1224 Part A): a codex worker
        // never commits, so its HEAD sha is frozen and ONLY the working-tree diff
        // reflects its work — memoizing the combined volume on HEAD sha would
        // freeze the first tick's `+0 -0` for the whole attempt. The claude
        // incremental path is unaffected: a new commit moves the delta into the
        // sha-keyed committed memo. Render stays git-free either way.
        const memoPath = locMemoPath(current.attemptDir, "/");
        const { added, removed } = await resolveAttemptLoc({
          headSha: head,
          compute: () =>
            gitx.diffstatCommitted({ cwd: worktree }, baseRef).catch(() => ({ added: 0, removed: 0 })),
          computeUncommitted: () =>
            gitx.diffstatUncommitted({ cwd: worktree }).catch(() => ({ added: 0, removed: 0 })),
          readMemo: () => {
            try {
              const m = JSON.parse(readFileSync(memoPath, "utf8")) as Partial<LocMemo>;
              return { sha: String(m.sha ?? ""), added: Number(m.added ?? 0), removed: Number(m.removed ?? 0) };
            } catch {
              return null;
            }
          },
          writeMemo: (m) => {
            try {
              writeFileSync(memoPath, JSON.stringify(m), "utf8");
            } catch {
              // best-effort, like the surrounding heartbeat writes
            }
          },
        });
        // Remember the volume for the on_heartbeat vitals provider (#832).
        lastHeartbeatDiff = { added, removed };
        // Update the per-attempt peak diff (only grows; never decreases).
        if (added > peakLocAdded) peakLocAdded = added;
        if (removed > peakLocRemoved) peakLocRemoved = removed;
        // Close this heartbeat window on the meter — derives the waiting count
        // (a window with no new stream events) and snapshots the cumulative
        // tool/text counts to fold into the record + state.
        const activity = activityMeter.snapshotWindow();
        const hb = buildProgressHeartbeat({
          secsSinceProgress: secs,
          lastProgressAt,
          head,
          added,
          removed,
          activity,
        });
        await appendRecord(join(current.attemptDir, "log.jsonl"), "heartbeat", hb.msg, {
          ts,
          fields: { extra: hb.extra },
        }).catch(() => {});
        await fsx.appendLine(join(current.attemptDir, "afk.log"), `[heartbeat] ${hb.msg}`);
        await updateState(join(current.attemptDir, "afk.state.json"), {
          ...hb.statePatch,
          "current.loc_peak_added": peakLocAdded,
          "current.loc_peak_removed": peakLocRemoved,
          "current.worktree": worktree,
          ...(info.base ? { "current.base": info.base } : {}),
        }).catch(() => {});
      })();
    },
    // Worker-vitals provider for the on_heartbeat hook context (ADR 0065/#832):
    // the live cumulative activity counters from the attempt's meter plus the
    // last-observed diff volume, under their canonical WorkerVitals names. Read
    // each attempt-guard poll right before the on_heartbeat hook fires.
    heartbeatVitals: () => {
      const a = activityMeter.peek();
      return {
        tools_called_count: a.toolsCalled,
        text_chunk_count: a.textChunks,
        reasoning_events: a.reasoningCount,
        reasoning_tokens: a.reasoningTokens,
        waiting_count: a.waiting,
        input_tokens: a.inputTokens,
        output_tokens: a.outputTokens,
        cost_usd: a.costUsd,
        loc_added: lastHeartbeatDiff.added,
        loc_removed: lastHeartbeatDiff.removed,
      };
    },
    // Intra-attempt notes-loop (Track C, #924). `notesLoop` is the resolved
    // `afk.notes_loop.*` config (default OFF). `writeNotes` persists the loop's
    // carried `notes.md` at the attempt dir — outside the worker branch's
    // worktree, so it is never committed. Best-effort: a write failure must never
    // fail the attempt.
    notesLoop,
    writeNotes: (path, content) => {
      try {
        writeFileSync(path, content, "utf8");
      } catch {
        /* best-effort: notes are also carried in-process */
      }
    },
    // Macro-lifecycle phase stamp (issue #811): processIssue calls this at the
    // orchestrator-owned points the agent stream can't see — `validating` at the
    // feedback gate, `merging` at landing. Best-effort, swallowed; the calm title
    // signal must never fail the run.
    markPhase: (phase) => {
      void updateState(join(current.attemptDir, "afk.state.json"), {
        "current.phase": phase,
      }).catch(() => {});
    },
    markState: (patch) => {
      void updateState(join(current.attemptDir, "afk.state.json"), patch).catch(() => {});
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
    recordOutcomeEvent: makeRecordOutcomeEvent(ctx.root, current, exec),
    // Spec cascade rebase (issue #1007): after a successful DONE landing, rebase
    // every open sibling branch (same spec:N, not held by a live worker) onto the
    // new base HEAD. Best-effort — failures log a warning, never fail the close.
    // Gated by `afk.landing.cascade_rebase` (default "true", checked in core).
    cascadeRebase: {
      async listAFKBranches() {
        const refs = await gitx.listRemoteBranches(gitCtx, "afk/");
        return refs.map((r) => r.branch);
      },
      isWorkerLive(workerId: string): boolean {
        try {
          const pidPath = workerPidFile(paths.tmpDir, workerId);
          const content = readFileSync(pidPath, "utf8").trim();
          if (!/^[1-9][0-9]*$/.test(content)) return false;
          process.kill(Number(content), 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "EPERM";
        }
      },
      async rebaseAndPush(repoDir: string, branch: string, newBase: string) {
        const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
        const dest = join(paths.tmpDir, "cascade-rebase", `${slug}-${slot}`);
        try {
          await gitx.worktreeRemove(gitCtx, dest);
          const ok = await gitx.worktreeAdd(gitCtx, dest, branch);
          if (!ok) {
            return { ok: false, warn: `failed to create worktree for ${branch}` };
          }
          const run = exec ?? (await import("../runtime/exec.js")).execTool;
          const rebaseR = await run("git", ["rebase", `origin/${newBase}`], { cwd: dest });
          if (rebaseR.code !== 0) {
            await run("git", ["rebase", "--abort"], { cwd: dest }).catch(() => {});
            return {
              ok: false,
              warn: `rebase of ${branch} onto ${newBase} conflicted: ${rebaseR.stderr.slice(0, 200)}`,
            };
          }
          const pushR = await run(
            "git",
            ["push", "origin", `HEAD:refs/heads/${branch}`, "--force-with-lease"],
            { cwd: dest },
          );
          if (pushR.code !== 0) {
            return {
              ok: false,
              warn: `--force-with-lease push rejected for ${branch}: ${pushR.stderr.slice(0, 200)}`,
            };
          }
          return { ok: true };
        } finally {
          await gitx.worktreeRemove(gitCtx, dest).catch(() => {});
        }
      },
    },
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

function makeRecordOutcomeEvent(
  gitRoot: string,
  current: CurrentAttempt,
  exec?: ExecFn,
): (event: OutcomeEvent) => Promise<void> {
  return async (event: OutcomeEvent): Promise<void> => {
    try {
      const configPath = join(gitRoot, ".red", "config.yaml");
      const configText = readFileSync(configPath, "utf8");
      if (!pluginEnabledInConfig(configText, "brain")) return;
      const env = { ...process.env, BRAIN_REPO_ROOT: process.env.BRAIN_REPO_ROOT ?? gitRoot };
      const brainCli = resolveBrainCli(gitRoot, env);
      if (!brainCli) return;
      const dir = current.attemptDir || gitRoot;
      await fsx.ensureDir(dir);
      const json = JSON.stringify(event);
      await writeFile(join(dir, `brain-outcome-event-${event.context?.issueNumber ?? "unknown"}-a${event.context?.attemptNumber ?? "unknown"}.json`), json, "utf8");
      const run = exec ?? (await import("../runtime/exec.js")).execTool;
      const [cmd, ...head] = brainCli;
      await run(cmd, [...head, "outcome-event", "record", "--root", gitRoot], {
        cwd: gitRoot,
        env,
        input: json,
      });
    } catch (err) {
      process.stderr.write(`[afk] brain outcome-event skipped (best-effort): ${String(err)}\n`);
    }
  };
}

function resolveBrainCli(gitRoot: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const override = env.RED_BRAIN_CLI;
  if (override) return existsSync(override) ? ["node", override] : undefined;
  const pathHit = findOnPath("brain", env.PATH);
  if (pathHit) return ["brain"];
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? env.CODEX_PLUGIN_ROOT;
  if (pluginRoot) {
    const sibling = join(pluginRoot, "..", "brain", "dist", "cli.js");
    if (existsSync(sibling)) return ["node", sibling];
  }
  const inRepo = join(gitRoot, "plugins", "brain", "dist", "cli.js");
  if (existsSync(inRepo)) return ["node", inRepo];
  return undefined;
}

function findOnPath(bin: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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
 * can run inside the synchronous `buildProcessInput`. Namespace-blind: walks
 * every worker-lane namespace (`workers`, `go-workers`, `scout-workers`) with
 * readdirSync and feeds the pure `highestAttempt`, so the same issue retried
 * across lanes never reuses an attempt number. The next attempt is the highest
 * existing attempt for the issue + 1 (1 when none). Junk dirs never bump the
 * counter; a missing namespace tree contributes nothing. */
function nextAttemptSync(tmpDir: string, issue: number): number {
  const entries: AttemptDirEntry[] = [];
  for (const namespace of WORKER_NAMESPACES) {
    let workers: string[];
    try {
      workers = readdirSync(join(tmpDir, namespace));
    } catch {
      continue; // namespace dir absent → no attempts from this lane
    }
    for (const worker of workers) {
      if (!isValidWorkerId(worker)) continue;
      try {
        entries.push({ worker, basenames: readdirSync(join(tmpDir, namespace, worker)) });
      } catch {
        // not a directory / unreadable
      }
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

  // Boot guard (#1027): refuse to start if a fleet supervisor is already live.
  // Supervisor-dispatched paths bypass this: --reconcile-issue workers are
  // spawned by the running supervisor; RED_AFK_SWEEPS_DONE=1 workers are
  // fleet-owned and the supervisor already holds the pid. A `/go`/`--scout`
  // dispatch (#1087) is exempt too: its isolated namespace/lane/origin can
  // never collide with the fleet, so it must boot whether or not a fleet is up.
  if (flags.reconcileIssue === undefined && process.env.RED_AFK_SWEEPS_DONE !== "1") {
    const pidFile = join(paths.tmpDir, "afk-supervisor.pid");
    const exempt = isNamespacedDispatch({ origin: flags.origin, lane: flags.lane });
    const guard = await checkBootGuard(pidFile, flags.force, process.stdout, isLivePid, exempt);
    if (guard === "refused") return 1;
  }

  // Worker id — probe the workers root for collisions.
  const existing = new Set((await collectMonitorInputs(cwd)).workers.map((w) => w.state.worker_id));
  const workerId = genWorkerId(Math.random, (id) => existing.has(id));
  const pidStartTime = readPidStartTime(process.pid) ?? "";
  // Emit the per-slot boot-stamp immediately so the supervisor's slot log
  // captures this worker's ID before any failure. The circuit-trip sweep
  // (sweepParkedSlot) parses `[afk] worker: wXXXX` lines from the slot log
  // to resolve all workers that ran in a parked slot — this stamp must appear
  // even when the worker fast-dies before writing worker.pid.
  process.stdout.write(`[afk] worker: ${workerId}\n`);

  // AFK runner improvement — Pattern 5 diagnostic: every spike worker died
  // post-commit + vitest with no exit code / signal / stack trace. Install
  // process-level death detectors that record every fatal event to a
  // per-worker diagnostic log at `.red/tmp/diagnostics/<id>.log`. The next
  // session (or a human running `cat` on the log) can then correlate
  // "agent idle for 1 minute → process absent" with the actual cause.
  // Opt-out via RED_AFK_NO_PROCESS_SAFETY=1 for environments where the
  // file IO itself is the suspected cause of the death.
  if (process.env.RED_AFK_NO_PROCESS_SAFETY !== "1") {
    installProcessSafety(
      fileSafetyLogger(safetyLogPath(paths.tmpDir, workerId)),
      { workerId, pid: process.pid },
    );
  }

  // Supervisor-dispatched reconcile worker: bypass the normal boot+session and
  // validate-and-land the specific parked branch for `--reconcile-issue <n>`.
  if (flags.reconcileIssue !== undefined) {
    return runReconcileWorker(flags.reconcileIssue, runner, ctx, paths, workerId);
  }

  const facts = await collectPrecheckFacts(ctx);
  const nowS = Math.floor(Date.now() / 1000);

  // Fleet supervisor owns the boot (#623): a worker spawned by the supervisor
  // carries RED_AFK_SWEEPS_DONE, signalling the shared sweeps already ran once
  // pre-spawn. Such a worker boots bootstrap+claim only — it skips every sweep
  // (cheap respawns; no race over `.red/tmp`). A solo `run` has no marker and
  // runs the full sweep suite exactly as before.
  const sweepsDone = process.env.RED_AFK_SWEEPS_DONE === "1";

  const sessionCtx: SessionContext = {
    runner,
    workerId,
    iterCap: flags.iterCap,
    once: flags.once,
    filter: flags.filter,
    alternate: flags.alternate,
    bootOnly: flags.bootOnly,
    // Reported by the --boot-only line so the dry-run states whether this worker
    // ran the sweeps or inherited them from the supervisor.
    sweepsSkipped: sweepsDone,
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
    if (sweepsDone) {
      // Supervisor-owned boot (#623): skip the expensive discovery (branch
      // listings, orphan walk, unblock-candidate + parked-mechanical gh probes)
      // AND the sweep work itself. The minimal options carry empty sweep inputs
      // + skipSweeps:true; the minimal deps wire only the bootstrap fs calls.
      bootOptions = {
        precheck: facts,
        bootstrap,
        orphans: [],
        attemptCap: { byIssue: new Map() },
        branches: { snapshotRefs: [], remoteLiveRefs: [], localLiveRefs: [] },
        unblockCandidates: [],
        skipSweeps: true,
      };
      bootDeps = buildMinimalBootDeps(ctx, nowS);
    } else {
      bootOptions = await collectBootOptions(ctx, facts, bootstrap, nowS);
      bootDeps = await buildBootDeps(ctx, bootOptions, nowS);
    }
  } catch (err) {
    await recordBootError(bootstrap.workerDir, "boot-error", err).catch(() => {
      process.stderr.write(`[afk] boot-error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return 1;
  }

  // Feedback worktree manager — checks out the worker branch for the gate.
  // AFK runner improvement (Pattern 2): `feedbackRebaseBase` is set only when
  // the `afk.feedback.rebase_on_base` flag is on; undefined → no rebase
  // (default behaviour unchanged).
  const feedback = makeFeedbackWorktree(ctx.root, join(paths.tmpDir, "feedback"), undefined, {
    rebaseOnto: settings.feedbackRebaseBase,
  });

  // Wire the boot reconcile runner into bootDeps (step 7, ADR 0055). A
  // supervisor-owned boot skips every sweep (including reconcile) and the fleet
  // dispatches reconcile per-tick instead, so the runner is wired only on the
  // solo / sweep-running path.
  if (!sweepsDone) {
    bootDeps = { ...bootDeps, reconcileRunner: makeBootReconcileRunner(ctx, paths, workerId, runner, feedback) };
  }

  // Per-issue mutable attempt context the process deps' envelope/iter-log close
  // over; buildProcessInput resets it before each processIssue call.
  const current: CurrentAttempt = { attemptDir: "" };

  // --request/-r special block, threaded into the handoff the agent reads.
  const requestBlock = specialUserRequestBlock(flags.request);

  const deps: SessionDeps = {
    gh: { listCandidates: () => ghx.listCandidates(ghCtx, flags.lane) },
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
      if (await fsx.pathExists(sp)) await updateState(sp, { pid: 0 }, { allowPidReset: true }).catch(() => {});
      return result;
    },
    processDeps: buildProcessDeps(
      ctx,
      settings.model,
      settings.sandbox,
      feedback,
      current,
      flags.fallbackRunner,
      runner,
      undefined,
      settings.maxIterations,
      settings.attemptTimeoutSeconds,
      settings.laneIdle,
      settings.attemptBudget,
      flags.verifyCommand,
      flags.goVerifyRetries,
    ),
    // Session-scoped lifecycle hooks (PRD #207): compose the same config /
    // resolver / exec / env the process deps use, so session + per-issue points
    // share one dispatcher rather than duplicating the wiring.
    hooks: {
      config: loadConfig(afkPaths(ctx.root).configPath, { warn: () => undefined }),
      resolveOptions: makeHookResolveOptions(ctx.root),
      exec: makeHookExec(ctx.root),
      env: hookEnv(ctx.repo, ctx.root, parseSlot(process.env.RED_AFK_SLOT), runner),
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
      // marks it not-live (pid:0) on terminal.
      //
      // SYNCHRONOUS on purpose: the agent-event sink + heartbeat fire async
      // `updateState` read-modify-writes against this same path. A fire-and-forget
      // async seed here raced them — a sink write that read the file before the
      // seed landed got the schema DEFAULT (pid 0, number "", worker_id ""),
      // patched only its vitals, and wrote that back, stranding the worker with
      // vitals but NO identity (rendered as a pid-0 `?`/idle ghost in monitor /
      // statusline). Seeding synchronously guarantees the identity exists before
      // any updateState runs, so every later read preserves it.
      const statePath = join(attemptDir, "afk.state.json");
      const startedAt = new Date().toISOString();
      try {
        initStateSync(statePath, {
          worker_id: c.workerId,
          pid: process.pid,
          pid_start_time: pidStartTime,
          runner: c.runner,
          // Spawn-time provenance (issue #930): stamped once here, never mutated.
          // The entry point (`/afk`, `/go`, `/urgent`) passes `--origin <label>`.
          origin: flags.origin ?? "",
          log: join(attemptDir, "afk.log"),
          started_at: startedAt,
          "current.number": candidate.number,
          "current.title": candidate.title,
          "current.worktree": join(attemptDir, "worktree"),
          "current.handoff": join(attemptDir, "handoff.md"),
          "current.started_at": startedAt,
          "current.runner": c.runner,
          "current.model": c.issueTemplate.model ?? "",
          "current.effort": settings.effort ?? "",
          "current.stage": "setup",
          // Macro-lifecycle phase seed (issue #811): the calm signal the
          // task-mirror title surfaces. `coding` is stamped on the first inner-
          // agent stream event; `validating`/`merging` by the orchestrator at the
          // gate/landing steps (deps.markPhase).
          "current.phase": "setup",
        });
        // Durable write-once identity sidecar (issue #1219): the immutable
        // worker_id/runner/origin/number/started_at the isolation fallback in
        // readWorkerState reads so a live isolation worker whose host-side
        // afk.state.json is still zeroed renders its real identity instead of the
        // `?  run=-  00:00:00` ghost. Never clobbered by vitals updateState writes.
        writeIdentitySync(attemptDir, {
          worker_id: c.workerId,
          runner: c.runner,
          origin: flags.origin ?? "",
          number: candidate.number,
          started_at: startedAt,
        });
      } catch {
        // Best-effort — a failed seed must never block the worker's actual work.
      }
      // Append the --request block into the handoff body so the inner agent
      // (which reads handoff.md as its prompt) sees the special request.
      const body = requestBlock ? `${candidate.body}\n\n${requestBlock}` : candidate.body;
      return {
        issue: candidate.number,
        title: candidate.title,
        body,
        runner: c.runner,
        workerId: c.workerId,
        // ADR 0066 claimant identity: `host:worker_id`, unique per worker process
        // per host so the GitHub-native claim never collides across machines. The
        // host half is a fingerprint, never the raw name — it lands in public
        // issue comments (#1327).
        claimant: workerIdentity(c.workerId),
        tmpDir: c.issueTemplate.tmpDir,
        attempt,
        attemptDir,
        repo: c.issueTemplate.repo,
        repoDir: c.issueTemplate.repoDir,
        remote: c.issueTemplate.remote,
        baseInput: { issueBody: candidate.body },
        runMode: runModeForCandidate(candidate, flags.runMode),
        // Lane-aware claim preflight (#1045): the pre-claim state-validity recheck
        // must validate against the label this issue was SELECTED under (the
        // `--lane` value), not a hardcoded `ready-for-agent`. `flags.lane` is
        // undefined for `/afk` (→ defaults to `ready-for-agent` in processIssue)
        // and `lane:go`/`lane:scout` for the isolated `/go`/scout lanes.
        laneLabel: flags.lane,
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
