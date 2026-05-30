import { parseRunnerFlag, detectRunner } from "../core/runner-detection.js";
import { runLegacy } from "../platform/legacy.js";
import {
  runSession,
  type SessionContext,
  type SessionDeps,
  type SelectionFilter,
  type IssueCandidate,
} from "../core/session.js";
import { genWorkerId } from "../core/session.js";
import { runBoot, type BootDeps, type BootOptions, type BootstrapInput } from "../core/boot.js";
import { processIssue, type ProcessIssueDeps, type ProcessIssueInput } from "../core/process-issue.js";
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
} from "../runtime/wire.js";
import { workerDir as workerDirPath, workerPidFile } from "../core/worker-paths.js";
import { parseFlags, type FlagSchema } from "../../../../shared/args.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import * as fsx from "../runtime/fs.js";
import type { GhContext } from "../runtime/gh.js";
import type { GitContext } from "../runtime/git.js";
import { loadConfig } from "../core/config.js";
import { resolveHooks } from "../core/hook-config.js";
import { attemptLedgerContext, formatAttemptContext, highestAttempt, type AttemptDirEntry } from "../core/attempt-ledger.js";
import { isValidWorkerId } from "../core/worker-paths.js";
import { readdirSync } from "node:fs";
import { specialUserRequestBlock } from "../core/runner-spawn.js";
import { buildWorkerAttemptPath } from "../core/worker-paths.js";
import { branchLockPath, readLockedBranch, isLocked } from "../runtime/lock.js";
import { makeHookExec, makeHookResolveOptions, hookEnv } from "../runtime/hooks.js";
import { makeFeedbackWorktree, type FeedbackWorktree } from "../runtime/feedback-worktree.js";
import { join } from "node:path";

export interface RunOptions {
  args: string[];
  cwd?: string;
}

interface ParsedRunFlags {
  filter: SelectionFilter;
  iterCap?: number;
  once: boolean;
  runnerFlag?: string;
  request?: string;
}

/** Parse a comma-separated issue list into an ordered, finite number list. */
function parseIssueList(raw: string): number[] {
  return raw.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
}

/**
 * Flag schema for the `run` command, expressed against the shared CLI layer
 * (`src/shared/args.ts`, built over `cli-args-parser`). The coercions here
 * reproduce the exact semantics the dev suite asserts: `--prd`/`-n` map through
 * `Number`, `--issues` trims and filters to finite numbers, booleans are
 * present-or-absent, and `--request` accepts the `-r` short alias.
 */
const RUN_FLAG_SCHEMA = {
  prd: { kind: "value", coerce: (raw: string): SelectionFilter => ({ kind: "prd", prd: Number(raw) }) },
  issues: { kind: "value", coerce: (raw: string): SelectionFilter => ({ kind: "issues", numbers: parseIssueList(raw) }) },
  n: { kind: "value", coerce: (raw: string): number => Number(raw) },
  once: { kind: "boolean" },
  runner: { kind: "value", coerce: (raw: string): string => raw },
  request: { kind: "value", aliases: ["r"], coerce: (raw: string): string => raw },
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

  return {
    filter,
    iterCap: values.n as number | undefined,
    once: values.once === true,
    runnerFlag: values.runner as string | undefined,
    request: values.request as string | undefined,
  };
}

/** Pre-resolve the gh issue-state cache the branch-cleanup reapers + orphan
 * lookup read synchronously. Mirrors collectReapInputs' eager resolution. */
async function resolveBranchIssueCache(
  ghCtx: GhContext,
  options: BootOptions,
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
  for (const n of issues) cache.set(n, await ghx.issueMeta(ghCtx, n));
  return cache;
}

async function buildBootDeps(ctx: RepoContext, options: BootOptions, nowS: number): Promise<BootDeps> {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: GitContext = { cwd: ctx.root };
  const branchCache = await resolveBranchIssueCache(ghCtx, options);
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
      // Orphan state pairs gh issue state/label with the attempt dir's
      // envelope.posted flag (read from the state file, not gh).
      orphanState: async (issue) => {
        const r = await ghx.orphanState(ghCtx, issue);
        return r;
      },
      branchIssue: (issue) => branchCache.get(issue),
      blockerState: (issue) => ghx.blockerState(ghCtx, issue),
      straggler: {
        unlabeled: () => ghx.countUnlabeled(ghCtx),
        needsTriage: () => ghx.countNeedsTriage(ghCtx),
        needsInfo: () => ghx.countNeedsInfo(ghCtx),
      },
    },
    nowS,
  };
}

function buildProcessDeps(
  ctx: RepoContext,
  model: string,
  sandbox: ReturnType<typeof resolveRunSettings>["sandbox"],
  feedback: FeedbackWorktree,
  current: CurrentAttempt,
): ProcessIssueDeps {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: GitContext = { cwd: ctx.root };
  const paths = afkPaths(ctx.root);
  const lockPath = branchLockPath(ctx.root);

  // ---- lifecycle hooks: load config + resolve built-in defaults + real exec ----
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const resolveOptions = makeHookResolveOptions(ctx.root);
  // resolveHooks runs once here to surface a malformed-hook-name error early;
  // process-issue re-resolves per run from the same config + options.
  resolveHooks(config, resolveOptions);

  return {
    gh: {
      viewLabels: (issue) => ghx.viewLabels(ghCtx, issue),
      editLabels: (issue, remove, add) => ghx.editLabels(ghCtx, issue, remove, add),
      comment: (issue, body) => ghx.comment(ghCtx, issue, body),
      close: (issue) => ghx.closeIssue(ghCtx, issue),
    },
    claimLock: {
      acquire: async (issue) => {
        const dir = `${paths.tmpDir}/claims/${issue}`;
        if (await fsx.pathExists(dir)) return false;
        await fsx.ensureDir(dir);
        return true;
      },
      release: async (issue) => {
        await fsx.removeDir(`${paths.tmpDir}/claims/${issue}`);
      },
    },
    fs: {
      ensureAttemptDir: (dir) => fsx.ensureDir(dir),
      writeHandoff: (path, content) => fsx.writeHandoff(path, content),
      completionSweep: (issue) => fsx.completionSweep(paths.workersRoot, issue),
    },
    git: {
      headShortSha: () => gitx.headShortSha(gitCtx),
      deleteLocalBranch: (branch) => gitx.deleteLocalBranch(gitCtx, branch),
    },
    mergeExec: gitx.mergeExec(gitCtx),
    remoteGit: gitx.gitExec(gitCtx),
    // Feedback runs against a checkout of the worker branch — the feedback
    // worktree manager materialises it and rebases pnpm/layout onto it.
    pnpm: feedback.pnpm,
    layout: feedback.layout,
    runAgent: makeRunAgent(sandbox),
    model,
    hooks: {
      config,
      resolveOptions,
      exec: makeHookExec(ctx.root),
      env: hookEnv(ctx.repo, ctx.root),
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
    historyPath: paths.historyPath,
    historyClock: { ts: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000) },
  };
}

/** Per-issue mutable context the session-scoped process deps close over — the
 * attempt dir the envelope markers / iter-log write into. buildProcessInput
 * resets it before each processIssue call. */
interface CurrentAttempt {
  attemptDir: string;
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

  if (process.env.RED_AFK_LEGACY === "1") {
    if (!process.env.RED_AFK_TS_QUIET_BOOT) {
      process.stderr.write("[afk-ts] RED_AFK_LEGACY=1 — delegating orchestration to scripts/afk.sh\n");
    }
    return runLegacy("afk", options.args, cwd);
  }

  const flags = parseRunFlags(options.args);
  const detection = detectRunner({ flag: flags.runnerFlag ?? parseRunnerFlag(options.args), scriptPath: process.argv[1] });
  const runner: Runner = isRunner(detection.runner) ? detection.runner : "claude";

  const ctx = await resolveRepoContext(cwd);
  const settings = resolveRunSettings(cwd);
  const paths = afkPaths(cwd);

  // Worker id — probe the workers root for collisions.
  const existing = new Set((await collectMonitorInputs(cwd)).workers.map((w) => w.state.worker_id));
  const workerId = genWorkerId(Math.random, (id) => existing.has(id));

  const facts = await collectPrecheckFacts(ctx);
  const nowS = Math.floor(Date.now() / 1000);

  const sessionCtx: SessionContext = {
    runner,
    workerId,
    iterCap: flags.iterCap,
    once: flags.once,
    filter: flags.filter,
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
  const bootOptions = await collectBootOptions(ctx, facts, bootstrap, nowS);
  const bootDeps = await buildBootDeps(ctx, bootOptions, nowS);

  // Feedback worktree manager — checks out the worker branch for the gate.
  const feedback = makeFeedbackWorktree(ctx.root, join(paths.tmpDir, "feedback"));

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
    processIssue,
    processDeps: buildProcessDeps(ctx, settings.model, settings.sandbox, feedback, current),
    buildProcessInput: (candidate: IssueCandidate, c: SessionContext): ProcessIssueInput => {
      const attempt = nextAttemptSync(c.issueTemplate.tmpDir, candidate.number);
      const attemptDir = buildWorkerAttemptPath(c.issueTemplate.tmpDir, c.workerId, candidate.number, attempt);
      // Point the session-scoped envelope/iter-log closures at this attempt.
      current.attemptDir = attemptDir;
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
  } finally {
    await feedback.cleanup();
  }

  if (!summary.boot.precheck.ok) {
    const failed = summary.boot.precheck.failed;
    process.stderr.write(`[afk] precheck failed: ${failed}\n`);
    return 1;
  }

  return 0;
}
