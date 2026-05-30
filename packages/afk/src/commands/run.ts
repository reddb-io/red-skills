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
import { runBoot, type BootDeps, type BootOptions } from "../core/boot.js";
import { processIssue, type ProcessIssueDeps, type ProcessIssueInput } from "../core/process-issue.js";
import { isRunner, type Runner } from "../types/runner.js";
import {
  afkPaths,
  collectPrecheckFacts,
  collectMonitorInputs,
  makeRunAgent,
  resolveRepoContext,
  resolveRunSettings,
  type RepoContext,
} from "../runtime/wire.js";
import { workerDir as workerDirPath, workerPidFile } from "../core/worker-paths.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import * as fsx from "../runtime/fs.js";
import type { GhContext } from "../runtime/gh.js";
import type { GitContext } from "../runtime/git.js";

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

/** Parse the `run` flags: --prd N / --issues a,b,c / -n N / --once / --request / --runner. */
export function parseRunFlags(args: readonly string[]): ParsedRunFlags {
  let filter: SelectionFilter = { kind: "all" };
  let iterCap: number | undefined;
  let once = false;
  let runnerFlag: string | undefined;
  let request: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const take = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === "--prd") {
      filter = { kind: "prd", prd: Number(take()) };
    } else if (arg.startsWith("--prd=")) {
      filter = { kind: "prd", prd: Number(arg.slice("--prd=".length)) };
    } else if (arg === "--issues") {
      filter = { kind: "issues", numbers: take().split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n)) };
    } else if (arg.startsWith("--issues=")) {
      filter = { kind: "issues", numbers: arg.slice("--issues=".length).split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n)) };
    } else if (arg === "-n") {
      iterCap = Number(take());
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--runner") {
      runnerFlag = take();
    } else if (arg.startsWith("--runner=")) {
      runnerFlag = arg.slice("--runner=".length);
    } else if (arg === "--request" || arg === "-r") {
      request = take();
    } else if (arg.startsWith("--request=")) {
      request = arg.slice("--request=".length);
    }
  }

  return { filter, iterCap, once, runnerFlag, request };
}

/** Empty BootOptions step inputs — boot's discovery work (orphan dirs, attempt
 * cap groups, branch refs, unblock candidates) is left empty for the native run
 * cutover; the precheck + bootstrap steps are the load-bearing ones here. */
function emptyBootOptions(facts: Awaited<ReturnType<typeof collectPrecheckFacts>>, paths: ReturnType<typeof afkPaths>, workerId: string, root: string): BootOptions {
  return {
    precheck: facts,
    bootstrap: {
      tmpDir: paths.tmpDir,
      stateDir: paths.stateDir,
      gitignorePath: paths.gitignorePath,
      workerDir: workerDirPath(paths.tmpDir, workerId),
      workerPidFile: workerPidFile(paths.tmpDir, workerId),
      workerPid: process.pid,
    },
    orphans: [],
    attemptCap: { byIssue: new Map() },
    branches: { snapshotRefs: [], remoteLiveRefs: [], localLiveRefs: [] },
    unblockCandidates: [],
  };
}

function buildBootDeps(ctx: RepoContext): BootDeps {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: GitContext = { cwd: ctx.root };
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
      orphanState: async () => ({ ghOk: true, state: "OPEN", label: null, envelopePosted: false }),
      branchIssue: () => undefined,
      blockerState: async () => undefined,
      straggler: {
        unlabeled: async () => 0,
        needsTriage: async () => 0,
        needsInfo: async () => 0,
      },
    },
    nowS: Math.floor(Date.now() / 1000),
  };
}

function buildProcessDeps(ctx: RepoContext, model: string, sandbox: ReturnType<typeof resolveRunSettings>["sandbox"]): ProcessIssueDeps {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: GitContext = { cwd: ctx.root };
  const paths = afkPaths(ctx.root);

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
    pnpm: async (args) => {
      const { pnpm } = await import("../runtime/exec.js");
      const head = args[0] === "pnpm" ? args.slice(1) : args;
      const r = await pnpm(head, { cwd: ctx.root });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    },
    layout: {
      hasPackage: (scope) => {
        try {
          require("node:fs").accessSync(`${ctx.root}/${scope === "." ? "" : `${scope}/`}package.json`);
          return true;
        } catch {
          return false;
        }
      },
      hasScript: () => false,
    },
    runAgent: makeRunAgent(sandbox),
    model,
    hooks: {
      config: {},
      resolveOptions: { defaultCommand: () => undefined },
      exec: async () => ({ code: 0, stdout: "" }),
      env: {},
    },
    lookups: {
      base: {
        readLockedBranch: async () => undefined,
        fetchIssueBody: (n) => ghx.issueBody(ghCtx, n),
      },
      isLocked: async () => false,
      comments: async () => [],
      issueUrl: (issue) => ghx.issueUrl(ghCtx, issue),
      priorAttemptContext: async () => undefined,
      changedFiles: (branch, base) => gitx.changedFiles(gitCtx, branch, base),
      diffstat: (branch, base) => gitx.diffstat(gitCtx, branch, base),
    },
    envelope: {
      git: gitx.gitExec(gitCtx),
      poster: async (issue, body) => {
        await ghx.comment(ghCtx, issue, body);
        return true;
      },
      writeMarkers: async () => undefined,
      writePosted: async () => undefined,
    },
    nowEpoch: () => Math.floor(Date.now() / 1000),
    nowIso: () => new Date().toISOString(),
    appendIterLog: () => undefined,
    historyPath: paths.historyPath,
    historyClock: { ts: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000) },
  };
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

  const deps: SessionDeps = {
    gh: { listCandidates: () => ghx.listCandidates(ghCtx) },
    runBoot,
    bootDeps: buildBootDeps(ctx),
    bootOptions: emptyBootOptions(facts, paths, workerId, cwd),
    processIssue,
    processDeps: buildProcessDeps(ctx, settings.model, settings.sandbox),
    buildProcessInput: (candidate: IssueCandidate, c: SessionContext): ProcessIssueInput => ({
      issue: candidate.number,
      title: candidate.title,
      body: candidate.body,
      runner: c.runner,
      workerId: c.workerId,
      tmpDir: c.issueTemplate.tmpDir,
      attempt: 1,
      attemptDir: `${c.issueTemplate.tmpDir}/workers/${c.workerId}/${candidate.number}-a1`,
      repo: c.issueTemplate.repo,
      repoDir: c.issueTemplate.repoDir,
      remote: c.issueTemplate.remote,
      baseInput: { issueBody: candidate.body },
    }),
    emit: (line: string) => process.stdout.write(`${line}\n`),
  };

  const summary = await runSession(deps, sessionCtx);

  if (!summary.boot.precheck.ok) {
    const failed = summary.boot.precheck.failed;
    process.stderr.write(`[afk] precheck failed: ${failed}\n`);
    return 1;
  }

  return 0;
}
