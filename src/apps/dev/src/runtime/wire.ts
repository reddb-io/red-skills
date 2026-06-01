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

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getConfig } from "../core/config.js";
import type { SandboxMode } from "../core/execution.js";
import type { RunAgentInput, RunAgentResult } from "../core/execution.js";
// Value import (pure, no sandcastle pull — the providers load lazily via
// defaultSandcastleDeps' dynamic import) so resolveRunSettings can parse the
// max-iterations knob from env/config without importing the runtime.
import { parseMaxIterations } from "../core/execution.js";
import type { BranchRef } from "../core/branch-cleanup.js";
import { isRunner, type Runner } from "../types/runner.js";
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
  /**
   * Sandcastle re-invocation ceiling (issue #322), resolved with precedence
   * RED_AFK_MAX_ITERATIONS env > `afk.max_iterations` config > undefined. When
   * undefined, buildRunOptions applies DEFAULT_MAX_ITERATIONS.
   */
  maxIterations?: number;
}

const SANDBOX_MODES: readonly SandboxMode[] = ["none", "docker", "podman"];

function defaultModelForRunner(runner: string): string {
  return runner === "codex" ? "gpt-5.5" : "claude-opus-4-8";
}

export function resolveRunSettings(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  runner?: Runner,
): RunSettings {
  const paths = afkPaths(root);
  const cfg = loadConfig(paths.configPath, { warn: () => undefined });
  // Precedence: RED_AFK_SANDBOX env override > afk.sandbox config > "none".
  // The env knob lets an E2E/CI run pick the isolation backend without mutating
  // the target repo's .red/config.yaml, consistent with the other RED_AFK_* knobs.
  const envSandbox = (env.RED_AFK_SANDBOX ?? "").trim();
  const rawSandbox = (SANDBOX_MODES as readonly string[]).includes(envSandbox)
    ? envSandbox
    : getConfig(cfg, "afk.sandbox");
  const sandbox = (SANDBOX_MODES as readonly string[]).includes(rawSandbox)
    ? (rawSandbox as SandboxMode)
    : "none";
  const defaultRunner = getConfig(cfg, "afk.default_runner") || "claude";
  const activeRunner = runner ?? (isRunner(defaultRunner) ? defaultRunner : "claude");
  const model =
    getConfig(cfg, `afk.models.${activeRunner}`) ||
    getConfig(cfg, "afk.model") ||
    defaultModelForRunner(activeRunner);
  // Precedence: RED_AFK_MAX_ITERATIONS env > afk.max_iterations config >
  // undefined (→ DEFAULT_MAX_ITERATIONS). parseMaxIterations rejects a
  // non-numeric / zero / negative value from EITHER source, so a typo in the
  // env or the config can never disable the cap or pin the agent to 1 iteration.
  const maxIterations =
    parseMaxIterations(env.RED_AFK_MAX_ITERATIONS) ?? parseMaxIterations(getConfig(cfg, "afk.max_iterations"));
  return { sandbox, defaultRunner, model, maxIterations };
}

// ---------- lazy sandcastle runAgent binding ----------

/**
 * Build the `runAgent` port bound to the real sandcastle providers. The
 * provider import is deferred until the FIRST agent run, so a monitor / reap /
 * empty-queue path never imports sandcastle. The sandbox mode is fixed from
 * config at construction time.
 */
export function makeRunAgent(
  sandbox: SandboxMode,
  env: NodeJS.ProcessEnv = process.env,
  maxIterations?: number,
): (input: RunAgentInput) => Promise<RunAgentResult> {
  let depsPromise: Promise<import("../core/execution.js").SandcastleDeps> | null = null;
  return async (input: RunAgentInput): Promise<RunAgentResult> => {
    const { runAgent, defaultSandcastleDeps, parseIdleTimeout } = await import("../core/execution.js");
    if (!depsPromise) depsPromise = defaultSandcastleDeps();
    const deps = await depsPromise;
    // Sandcastle re-invocation ceiling (issue #322). Precedence: per-call
    // input.maxIterations > the resolved `maxIterations` (RED_AFK_MAX_ITERATIONS
    // env > afk.max_iterations config, computed by resolveRunSettings) > a direct
    // env read for any caller that constructed this without a resolved value. A
    // missing / non-numeric / non-positive value parses to undefined so a typo
    // can't disable the cap — buildRunOptions then applies DEFAULT_MAX_ITERATIONS.
    // RED_AFK_IDLE_TIMEOUT_S overrides the per-iteration idle watchdog (FIX G),
    // same typo-safe contract.
    const envIdleTimeout = parseIdleTimeout(env.RED_AFK_IDLE_TIMEOUT_S);
    return runAgent(deps, {
      ...input,
      sandboxMode: input.sandboxMode ?? sandbox,
      maxIterations: input.maxIterations ?? maxIterations ?? parseMaxIterations(env.RED_AFK_MAX_ITERATIONS),
      idleTimeoutSeconds: input.idleTimeoutSeconds ?? envIdleTimeout,
    });
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

// ---------- statusline inputs ----------

import type { AfkInput } from "../core/statusline.js";

/** The TTL (seconds) of the GitHub-derived queue/human counts cache, matching
 * statusline.sh's 60 s window. */
export const STATUSLINE_CACHE_TTL_S = 60;

interface StatuslineCache {
  queue: number;
  human: number;
  ts: number;
}

function readStatuslineCache(path: string): StatuslineCache | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StatuslineCache>;
    return {
      queue: Number(parsed.queue ?? 0),
      human: Number(parsed.human ?? 0),
      ts: Number(parsed.ts ?? 0),
    };
  } catch {
    return null;
  }
}

function writeStatuslineCacheAtomic(path: string, cache: StatuslineCache): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort, like the bash `|| true`
  }
}

/**
 * Aggregate the live /afk workers under the workers root into the statusline's
 * block-4 input, exactly like statusline.sh's per-state loop: count live
 * workers, sum blocked + diffstat (falling back to a worktree `git diff
 * --shortstat origin/main` when the state file's diff fields are both 0), and
 * collect the in-progress issue numbers in directory order. Returns null when
 * there are no live workers, so the caller drops the whole AFK block.
 *
 * The 📋 ready-for-agent / 🆘 ready-for-human counts are GitHub-derived and
 * cached for {@link STATUSLINE_CACHE_TTL_S} seconds in
 * `.red/tmp/statusline-cache.json`: a cold cache refreshes synchronously, a
 * fresh cache is read as-is, and a stale cache is read AND refreshed in the
 * background (the bash `( refresh_cache ) &`), so the render stays fast.
 */
export async function collectStatuslineAfk(ctx: RepoContext): Promise<AfkInput | null> {
  const paths = afkPaths(ctx.root);
  const stateFiles = await fsx.globWorkerStates(paths.workersRoot);
  const gitCtx: gitx.GitContext = { cwd: ctx.root };

  let workers = 0;
  let blocked = 0;
  let added = 0;
  let removed = 0;
  const issues: Array<number | string> = [];

  for (const file of stateFiles) {
    const text = await fsx.readText(file);
    if (text === null) continue;
    let state;
    try {
      state = parseState(JSON.parse(text));
    } catch {
      continue;
    }
    if (!isStateLive(state)) continue;

    workers += 1;
    blocked += state.blocked;

    let a = state.current.diff_added;
    let r = state.current.diff_removed;
    if (a === 0 && r === 0 && state.current.worktree) {
      // Fallback: compute the diffstat from the worktree like statusline.sh.
      const stat = await gitx.diffstatShortstat({ cwd: state.current.worktree }, "origin/main");
      a = stat.added;
      r = stat.removed;
    }
    added += a;
    removed += r;

    const number = state.current.number;
    if (number !== "" && number !== undefined && number !== null) issues.push(number);
  }

  if (workers <= 0) return null;

  // GitHub-derived counts with a 60 s cache.
  const cachePath = join(paths.tmpDir, "statusline-cache.json");
  const nowS = Math.floor(Date.now() / 1000);
  const cached = readStatuslineCache(cachePath);
  let queue = cached?.queue ?? 0;
  let human = cached?.human ?? 0;

  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const refresh = async (): Promise<void> => {
    const [q, h] = await Promise.all([
      ghx.countReadyForAgent(ghCtx),
      ghx.countReadyForHuman(ghCtx),
    ]);
    queue = q;
    human = h;
    writeStatuslineCacheAtomic(cachePath, { queue: q, human: h, ts: nowS });
  };

  if (!cached) {
    // Cold cache: refresh synchronously so the first render is correct.
    await refresh();
  } else if (nowS - cached.ts >= STATUSLINE_CACHE_TTL_S) {
    // Stale: use the cached numbers now, refresh in the background.
    void refresh().catch(() => undefined);
  }

  return { workers, queue, human, blocked, added, removed, issues };
}

// ---------- reap inputs ----------

import { issueMeta, listIssueStates, type GhContext } from "./gh.js";
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
  // ONE batched issue-state fetch replaces the per-issue `gh issue view` storm.
  // A map miss (issue beyond the --limit window / just-created / transient list
  // failure) falls back to the live `issueMeta` so closedAt-grace stays exact.
  const states = await listIssueStates(ghCtx);
  const cache = new Map<number, IssueMeta | null | undefined>();
  for (const n of issues) {
    const row = states.get(n);
    if (row) cache.set(n, { state: row.state, closedAt: row.closedAt });
    else cache.set(n, await issueMeta(ghCtx, n));
  }

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

  // Branch namespaces for the three reapers, the unblock-candidate listing, and
  // the stale claim-lock / pre-cutover work-* sweeps are mutually independent
  // reads — run them concurrently. (Stale-claim + legacy-work both probe pid
  // liveness at discovery so boot's orphan step stays a pure removal, #252.)
  const [snapshotRefs, remoteLiveRefs, localAll, checkedOut, unblockCandidates, staleClaimDirs, legacyWorkDirs] =
    await Promise.all([
      gitx.listRemoteBranches(gitCtx, "afk-attempts/"),
      gitx.listRemoteBranches(gitCtx, "afk/"),
      gitx.listLocalBranches(gitCtx, "afk/*"),
      gitx.checkedOutBranches(gitCtx),
      ghx.listUnblockCandidates(ghCtx),
      fsx.listStaleClaimDirs(paths.tmpDir),
      fsx.listLegacyWorkDirs(paths.tmpDir),
    ]);
  const localLiveRefs = localAll.filter((b) => !checkedOut.has(b)).map((b) => ({ branch: b }));

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
  const [ghInstalled, ghAuthenticated, isRepo, remoteUrls, hasMain, currentBranch, pnpmProbe] = await Promise.all([
    ghx.ghInstalled(ghCtx),
    ghx.ghAuthenticated(ghCtx),
    gitx.isGitRepo(gitCtx),
    gitx.remoteUrls(gitCtx),
    gitx.hasMainBranch(gitCtx),
    gitx.currentBranch(gitCtx),
    import("./exec.js").then((m) => m.pnpm(["--version"], { cwd: ctx.root })),
  ]);
  const pnpmInstalled = pnpmProbe.code !== 127;
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
