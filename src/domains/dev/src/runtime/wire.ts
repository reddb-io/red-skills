// runtime/wire.ts — assemble the real dep closures the orchestrators consume.
//
// This is the seam between the pure core/* orchestrators (which only ever see
// injected IO) and the real process/fs world (runtime/exec|gh|git|fs). It builds
// the BootDeps / SessionDeps for `run`, the inputs the `monitor` and `reap`
// commands render from, and the lazy sandcastle binding for the agent.
//
// The sandcastle providers are imported LAZILY (only constructed when an agent
// actually runs), so `monitor`, `reap`, and an empty `run` never pull the
// provider subpaths.

import { join } from "node:path";
import { loadConfig, getConfig } from "../core/config.js";
import type { SandboxMode } from "../core/execution.js";
import type { RunAgentInput, RunAgentResult } from "../core/execution.js";
import type { BranchRef } from "../core/branch-cleanup.js";
import * as ghx from "./gh.js";
import * as gitx from "./git.js";
import * as fsx from "./fs.js";

// ---------- repo resolution ----------

export interface RepoContext {
  /** Primary checkout dir. */
  root: string;
  /** owner/repo slug for gh, or "" when unresolved. */
  repo: string;
  /** Remote name (always "origin" for AFK). */
  remote: string;
}

/** Resolve owner/repo from `gh repo view`, best-effort (empty when unavailable). */
export async function resolveRepoSlug(root: string): Promise<string> {
  const { gh } = await import("./exec.js");
  const r = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : "";
}

export async function resolveRepoContext(root = process.cwd()): Promise<RepoContext> {
  const repo = await resolveRepoSlug(root);
  return { root, repo, remote: "origin" };
}

// ---------- standard paths ----------

export interface AfkPaths {
  tmpDir: string;
  stateDir: string;
  workersRoot: string;
  historyPath: string;
  gitignorePath: string;
  configPath: string;
}

export function afkPaths(root: string): AfkPaths {
  const tmpDir = join(root, ".red", "tmp");
  const stateDir = join(root, ".red", "state");
  return {
    tmpDir,
    stateDir,
    workersRoot: join(tmpDir, "workers"),
    historyPath: join(stateDir, "afk-history.jsonl"),
    gitignorePath: join(root, ".gitignore"),
    configPath: join(root, ".red", "config.yaml"),
  };
}

// ---------- config-derived run settings ----------

export interface RunSettings {
  sandbox: SandboxMode;
  defaultRunner: string;
  model: string;
}

const SANDBOX_MODES: readonly SandboxMode[] = ["none", "docker", "podman"];

export function resolveRunSettings(root: string): RunSettings {
  const paths = afkPaths(root);
  const cfg = loadConfig(paths.configPath, { warn: () => undefined });
  const rawSandbox = getConfig(cfg, "afk.sandbox");
  const sandbox = (SANDBOX_MODES as readonly string[]).includes(rawSandbox)
    ? (rawSandbox as SandboxMode)
    : "none";
  const defaultRunner = getConfig(cfg, "afk.default_runner") || "claude";
  const model = getConfig(cfg, "afk.model") || "claude-opus-4-8";
  return { sandbox, defaultRunner, model };
}

// ---------- lazy sandcastle runAgent binding ----------

/**
 * Build the `runAgent` port bound to the real sandcastle providers. The
 * provider import is deferred until the FIRST agent run, so a monitor / reap /
 * empty-queue path never imports sandcastle. The sandbox mode is fixed from
 * config at construction time.
 */
export function makeRunAgent(sandbox: SandboxMode): (input: RunAgentInput) => Promise<RunAgentResult> {
  let depsPromise: Promise<import("../core/execution.js").SandcastleDeps> | null = null;
  return async (input: RunAgentInput): Promise<RunAgentResult> => {
    const { runAgent, defaultSandcastleDeps } = await import("../core/execution.js");
    if (!depsPromise) depsPromise = defaultSandcastleDeps();
    const deps = await depsPromise;
    return runAgent(deps, { ...input, sandboxMode: input.sandboxMode ?? sandbox });
  };
}

// ---------- monitor inputs ----------

import type { CompactWorker } from "../core/monitor.js";
import { parseState, isStateLive } from "../core/state.js";
import { parseHistoryLines, type HistoryRecord } from "../core/history.js";

export interface MonitorInputs {
  workers: CompactWorker[];
  events: Array<Pick<HistoryRecord, "event" | "epoch">>;
}

/** Read every worker state file + the history ledger into the pure renderer's
 * inputs. No process spawn — pure disk reads. */
export async function collectMonitorInputs(root = process.cwd()): Promise<MonitorInputs> {
  const paths = afkPaths(root);
  const stateFiles = await fsx.globWorkerStates(paths.workersRoot);
  const workers: CompactWorker[] = [];
  for (const file of stateFiles) {
    const text = await fsx.readText(file);
    if (text === null) continue;
    let state;
    try {
      state = parseState(JSON.parse(text));
    } catch {
      continue;
    }
    workers.push({
      state: {
        worker_id: state.worker_id,
        pid: state.pid,
        runner: state.runner,
        started_at: state.started_at,
        total: state.total,
        done: state.done,
        blocked: state.blocked,
        failed: state.failed,
        current: {
          number: state.current.number,
          title: state.current.title,
          stage: state.current.stage,
          started_at: state.current.started_at,
        },
      },
      live: isStateLive(state),
    });
  }

  const histText = await fsx.readText(paths.historyPath);
  const events = histText === null ? [] : parseHistoryLines(histText).map((r) => ({ event: r.event, epoch: r.epoch }));
  return { workers, events };
}

// ---------- reap inputs ----------

import { issueMeta, type GhContext } from "./gh.js";
import type { IssueMeta } from "../core/branch-cleanup.js";

export interface ReapInputs {
  snapshotRefs: BranchRef[];
  remoteLiveRefs: BranchRef[];
  localLiveRefs: BranchRef[];
  /** Synchronous issue-state lookup (pre-resolved gh metadata cache). */
  lookup: (issue: number) => IssueMeta | null | undefined;
  /** git deletion closures bound to the repo. */
  deleteRemote: (branch: string) => Promise<void>;
  deleteLocal: (branch: string) => Promise<void>;
}

/**
 * List the three branch namespaces and pre-resolve every referenced issue's gh
 * state into a synchronous cache (branch-cleanup's IssueLookup is sync). Local
 * checked-out branches are excluded from the local live set.
 */
export async function collectReapInputs(ctx: RepoContext): Promise<ReapInputs> {
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  const snapshotRefs = await gitx.listRemoteBranches(gitCtx, "afk-attempts/");
  const remoteLiveRefs = await gitx.listRemoteBranches(gitCtx, "afk/");
  const localAll = await gitx.listLocalBranches(gitCtx, "afk/*");
  const checkedOut = await gitx.checkedOutBranches(gitCtx);
  const localLiveRefs: BranchRef[] = localAll
    .filter((b) => !checkedOut.has(b))
    .map((b) => ({ branch: b }));

  // Pre-resolve every issue referenced across the three sets.
  const { liveIssueFromBranch, attemptIssueFromBranch } = await import("../core/branch-cleanup.js");
  const issues = new Set<number>();
  for (const r of snapshotRefs) {
    const n = attemptIssueFromBranch(r.branch);
    if (n !== null) issues.add(n);
  }
  for (const r of [...remoteLiveRefs, ...localLiveRefs]) {
    const n = liveIssueFromBranch(r.branch);
    if (n !== null) issues.add(n);
  }
  const cache = new Map<number, IssueMeta | null | undefined>();
  for (const n of issues) cache.set(n, await issueMeta(ghCtx, n));

  return {
    snapshotRefs,
    remoteLiveRefs,
    localLiveRefs,
    lookup: (issue) => cache.get(issue),
    deleteRemote: (branch) => gitx.deleteRemoteBranch(gitCtx, branch),
    deleteLocal: (branch) => gitx.deleteLocalBranch(gitCtx, branch),
  };
}

// ---------- precheck facts ----------

import type { PrecheckFacts, BootOptions, BootstrapInput, OrphanDir } from "../core/boot.js";
import type { AttemptDir } from "../core/reclaim.js";
import { parseWorkerAttemptPath } from "../core/worker-paths.js";

/**
 * Discover every per-step input boot's sweeps consume, replacing the empty
 * placeholders the native cutover shipped with:
 *   - orphans: every attempt dir under the workers root with its age + issue.
 *   - attemptCap: those same dirs grouped by issue, each stat'd for mtime +
 *     liveness (live attempts are excluded from the cap).
 *   - branches: the three afk/* / afk-attempts/* ref namespaces (snapshot
 *     remote, live remote, live local minus checked-out) the reapers prune.
 *   - unblockCandidates: the `ready-for-human` issues the unblock sweep scans.
 * The straggler counts + per-issue gh state lookups are resolved lazily in the
 * boot deps (buildBootDeps), so this only gathers the disk/branch facts.
 */
export async function collectBootOptions(
  ctx: RepoContext,
  facts: PrecheckFacts,
  bootstrap: BootstrapInput,
  nowS: number,
): Promise<BootOptions> {
  const paths = afkPaths(ctx.root);
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  // Orphan dirs + the same dirs grouped by issue for the cap pass.
  const orphans = await fsx.listOrphanDirs(paths.workersRoot, nowS);
  const byIssue = new Map<number, AttemptDir[]>();
  for (const o of orphans) {
    const parsed = parseWorkerAttemptPath(o.path);
    if (!parsed) continue;
    const text = await fsx.readText(join(o.path, "afk.state.json"));
    let live = false;
    if (text !== null) {
      try {
        live = isStateLive(parseState(JSON.parse(text)));
      } catch {
        live = false;
      }
    }
    const mtimeS = nowS - o.ageS;
    const list = byIssue.get(parsed.issue) ?? [];
    list.push({ path: o.path, mtimeS, live });
    byIssue.set(parsed.issue, list);
  }

  // Branch namespaces for the three reapers.
  const [snapshotRefs, remoteLiveRefs, localAll, checkedOut] = await Promise.all([
    gitx.listRemoteBranches(gitCtx, "afk-attempts/"),
    gitx.listRemoteBranches(gitCtx, "afk/"),
    gitx.listLocalBranches(gitCtx, "afk/*"),
    gitx.checkedOutBranches(gitCtx),
  ]);
  const localLiveRefs = localAll.filter((b) => !checkedOut.has(b)).map((b) => ({ branch: b }));

  const unblockCandidates = await ghx.listUnblockCandidates(ghCtx);

  // Stale claim-lock sweep + pre-cutover work-* drain-wipe (#252). Both probe
  // pid liveness at discovery so boot's orphan step stays a pure removal.
  const [staleClaimDirs, legacyWorkDirs] = await Promise.all([
    fsx.listStaleClaimDirs(paths.tmpDir),
    fsx.listLegacyWorkDirs(paths.tmpDir),
  ]);

  return {
    precheck: facts,
    bootstrap,
    orphans: orphans as readonly OrphanDir[],
    attemptCap: { byIssue },
    branches: { snapshotRefs, remoteLiveRefs, localLiveRefs },
    unblockCandidates,
    staleClaimDirs,
    legacyWorkDirs,
  };
}

export async function collectPrecheckFacts(ctx: RepoContext): Promise<PrecheckFacts> {
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const [ghInstalled, ghAuthenticated, isRepo, remoteUrls, hasMain, currentBranch] = await Promise.all([
    ghx.ghInstalled(ghCtx),
    ghx.ghAuthenticated(ghCtx),
    gitx.isGitRepo(gitCtx),
    gitx.remoteUrls(gitCtx),
    gitx.hasMainBranch(gitCtx),
    gitx.currentBranch(gitCtx),
  ]);
  const pnpmInstalled = (await import("./exec.js").then((m) => m.pnpm(["--version"], { cwd: ctx.root }))).code !== 127;
  return {
    ghInstalled,
    ghAuthenticated,
    isGitRepo: isRepo,
    remoteUrls,
    hasMainBranch: hasMain,
    currentBranch,
    pnpmInstalled,
  };
}
