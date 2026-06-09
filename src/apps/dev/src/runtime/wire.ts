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
import { loadConfig, getConfig, resolveTier } from "../core/config.js";
import type { SandboxMode } from "../core/execution.js";
import type { AgentEffort, RunAgentInput, RunAgentResult } from "../core/execution.js";
// Value import (pure, no sandcastle pull — the providers load lazily via
// defaultSandcastleDeps' dynamic import) so resolveRunSettings can parse the
// max-iterations knob from env/config without importing the runtime.
import { parseAttemptTimeout, parseMaxIterations } from "../core/execution.js";
import { resolveLaneIdleStallConfig, type LaneIdleStallConfig } from "../core/lane-idle-reaper.js";
import { inspectProcessTreeNative } from "./proc-tree.js";
import { statSync } from "node:fs";
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
  fleetStatePath: string;
  fleetFirehosePath: string;
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
    fleetStatePath: join(tmpDir, "afk-supervisor.state.json"),
    fleetFirehosePath: join(tmpDir, "afk-supervisor.log.jsonl"),
    gitignorePath: join(root, ".gitignore"),
    configPath: join(root, ".red", "config.yaml"),
  };
}

// ---------- config-derived run settings ----------

export interface RunSettings {
  sandbox: SandboxMode;
  defaultRunner: string;
  model: string;
  effort: AgentEffort;
  /**
   * Sandcastle re-invocation ceiling (issue #322), resolved with precedence
   * RED_AFK_MAX_ITERATIONS env > `afk.max_iterations` config > undefined. When
   * undefined, buildRunOptions applies DEFAULT_MAX_ITERATIONS.
   */
  maxIterations?: number;
  /**
   * Attempt progress-guard cap (seconds), resolved with precedence
   * RED_AFK_ATTEMPT_TIMEOUT_S env > `afk.attempt_timeout` config > undefined
   * (→ DEFAULT_ATTEMPT_TIMEOUT_S). The guard aborts a run that produces no new
   * commit within the cap (proof-of-progress) → blocked:stalled / ready-for-human.
   */
  attemptTimeoutSeconds?: number;
  /**
   * Solo-path lane-idle stall reaper config (issue #363), resolved + validated
   * at boot via resolveLaneIdleStallConfig (RED_AFK_STALL_THRESHOLD_S /
   * RED_AFK_STALL_KILL_THRESHOLD_S / RED_AFK_STALL_POLL_S, fleet defaults
   * 600 / 1800 / 30). A kill ≤ soft threshold THROWS here, so a misconfigured
   * solo run fails fast at boot — the same invariant the supervisor enforces.
   * Complementary to attemptTimeoutSeconds: this cuts an idle hang at the stall
   * threshold; the progress guard caps the whole attempt on no-commit.
   */
  laneIdle: LaneIdleStallConfig;
}

const SANDBOX_MODES: readonly SandboxMode[] = ["none", "docker", "podman"];

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
  const tier = resolveTier(cfg, activeRunner, "think");
  // Precedence: RED_AFK_MAX_ITERATIONS env > afk.max_iterations config >
  // undefined (→ DEFAULT_MAX_ITERATIONS). parseMaxIterations rejects a
  // non-numeric / zero / negative value from EITHER source, so a typo in the
  // env or the config can never disable the cap or pin the agent to 1 iteration.
  const maxIterations =
    parseMaxIterations(env.RED_AFK_MAX_ITERATIONS) ?? parseMaxIterations(getConfig(cfg, "afk.max_iterations"));
  // Precedence mirrors maxIterations: RED_AFK_ATTEMPT_TIMEOUT_S env >
  // afk.attempt_timeout config > undefined (→ DEFAULT_ATTEMPT_TIMEOUT_S in
  // makeRunAgent). Typo-safe: a non-numeric / zero / negative value parses to
  // undefined from either source.
  const attemptTimeoutSeconds =
    parseAttemptTimeout(env.RED_AFK_ATTEMPT_TIMEOUT_S) ?? parseAttemptTimeout(getConfig(cfg, "afk.attempt_timeout"));
  // Solo lane-idle reaper thresholds (issue #363), env-driven with fleet
  // defaults and the same boot invariant (kill > soft) — throws here on a `<=`
  // config so the run fails fast before claiming an issue.
  const laneIdle = resolveLaneIdleStallConfig(env);
  return {
    sandbox,
    defaultRunner,
    model: tier.model,
    effort: tier.effort,
    maxIterations,
    attemptTimeoutSeconds,
    laneIdle,
  };
}

/** mtime of the solo attempt's agent lane (`agent.log.jsonl`) in whole epoch
 * seconds, 0 when the lane does not exist yet / cannot be stat'd. The clean
 * liveness signal the solo lane-idle reaper keys off — mirrors the fleet
 * `agentLaneMtimeFor` stat, but resolved directly from the attempt dir the solo
 * worker already holds (no slot-pid round-trip). Best-effort: any stat failure
 * degrades to 0 (no lane observed), which computeStalled never flags. */
export function agentLaneMtimeSeconds(lanePath: string): number {
  try {
    return Math.floor(statSync(lanePath).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

// ---------- attempt-guard arming policy (pure) ----------

/** What an attempt run arms, decided from sandbox mode + available signals. */
export interface AttemptGuardArming {
  /**
   * Arm the attempt progress guard (ADR 0044) + externalized heartbeat
   * (ADR 0045). True for EVERY sandbox mode once a worker branch exists
   * (issue #405): under docker/podman sandcastle's bind-mount providers
   * host-create the worktree and bind-mount it + the shared `.git` into the
   * container, and #405 additionally bind-mounts the attempt dir — so the worker
   * branch's commits + worktree edits are host-visible mid-run and the
   * commit/volume probes no longer false-fire. (ADR 0044's "isolated copy"
   * premise described a copy-isolated sandbox; sandcastle 0.6.x bind-mounts.)
   */
  guardArmed: boolean;
  /**
   * Arm the lane-idle stall reaper (issue #363). NO-SANDBOX only: its
   * busy-predicate inspects the HOST process tree, which cannot see the inner
   * agent inside a container — under docker/podman it would read every container
   * as "not busy" and could reap a genuinely-busy worker. Decoupled from
   * `guardArmed` (#405) so arming the guard under isolation never drags the
   * host-blind reaper along with it.
   */
  laneArmed: boolean;
}

/**
 * Decide what an attempt run arms, given the resolved sandbox mode and the
 * presence of a worker branch / attempt dir. Pure so the isolated-mode arming
 * decision is unit-testable without sandcastle or git.
 */
export function resolveAttemptGuardArming(opts: {
  sandbox: SandboxMode;
  branch: string | undefined;
  attemptDir: string | undefined;
}): AttemptGuardArming {
  const guardArmed = !!opts.branch;
  const laneArmed = opts.sandbox === "none" && guardArmed && !!opts.attemptDir;
  return { guardArmed, laneArmed };
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
  attemptTimeoutSeconds?: number,
  laneIdle?: LaneIdleStallConfig,
): (input: RunAgentInput) => Promise<RunAgentResult> {
  let depsPromise: Promise<import("../core/execution.js").SandcastleDeps> | null = null;
  return async (input: RunAgentInput): Promise<RunAgentResult> => {
    const { runAgent, defaultSandcastleDeps, parseIdleTimeout, DEFAULT_ATTEMPT_TIMEOUT_S } = await import(
      "../core/execution.js"
    );
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
    const effectiveSandbox = input.sandboxMode ?? sandbox;
    // Attempt progress guard (proof-of-progress) + externalized heartbeat. Armed
    // for EVERY sandbox mode now (issue #405): under docker/podman sandcastle's
    // bind-mount providers host-create the worktree and bind-mount it + the
    // shared `.git` into the container, and #405 additionally bind-mounts the
    // attempt dir (buildRunOptions), so `branchHead` sees HEAD advance and the
    // worktree diffstat reflects in-container edits — the commit/volume probes no
    // longer false-fire under isolation. The lane-idle reaper stays no-sandbox
    // only (its host process-tree busy-predicate is blind to a containerized
    // agent); resolveAttemptGuardArming decouples the two.
    const attemptTimeout =
      input.attemptTimeoutSeconds ??
      attemptTimeoutSeconds ??
      parseAttemptTimeout(env.RED_AFK_ATTEMPT_TIMEOUT_S) ??
      DEFAULT_ATTEMPT_TIMEOUT_S;
    // Resolved lane-idle config is threaded from resolveRunSettings (validated at
    // boot); a caller that constructed makeRunAgent without one falls back to the
    // env-resolved config.
    const laneIdleCfg = laneIdle ?? resolveLaneIdleStallConfig(env);
    const laneAttemptDir = input.cwd;
    const { guardArmed, laneArmed } = resolveAttemptGuardArming({
      sandbox: effectiveSandbox,
      branch: input.branch,
      attemptDir: laneAttemptDir,
    });
    return runAgent(deps, {
      ...input,
      sandboxMode: effectiveSandbox,
      maxIterations: input.maxIterations ?? maxIterations ?? parseMaxIterations(env.RED_AFK_MAX_ITERATIONS),
      idleTimeoutSeconds: input.idleTimeoutSeconds ?? envIdleTimeout,
      ...(guardArmed
        ? {
            attemptTimeoutSeconds: attemptTimeout,
            headProbe: () => gitx.branchHead({ cwd: input.cwd ?? process.cwd() }, input.branch),
            // Edit signal (ADR 0051): the changed-line volume of the agent's real
            // worktree (committed + uncommitted). A change between polls resets
            // the deadline, so a runner that edits without committing (codex) is
            // not falsely stalled. Resolve the worktree off the worker branch, and
            // return undefined on any failure (guard degrades to commit-anchored).
            progressProbe: async () => {
              const gitCtx = { cwd: input.cwd ?? process.cwd() };
              const worktree = await gitx.worktreePathForBranch(gitCtx, input.branch);
              if (!worktree) return undefined;
              const { added, removed } = await gitx.diffstatShortstat({ cwd: worktree }, "origin/main");
              return added + removed;
            },
          }
        : {}),
      ...(laneArmed && laneAttemptDir
        ? {
            laneIdleThresholdSeconds: laneIdleCfg.stallThresholdS,
            laneIdleKillThresholdSeconds: laneIdleCfg.stallKillThresholdS,
            laneIdlePollSeconds: laneIdleCfg.stallPollS,
            // Clean liveness signal: the attempt's agent.log.jsonl mtime in whole
            // seconds, 0 when absent — NEVER afk.log / the firehose (#243).
            laneMtimeProbe: () => agentLaneMtimeSeconds(`${laneAttemptDir}/agent.log.jsonl`),
            // Inner-agent tree is a descendant of this worker process; the native
            // inspector is safe-by-default (a failed ps reports busy, never reaps).
            inspectTree: () => inspectProcessTreeNative(process.pid),
          }
        : {}),
    });
  };
}

// ---------- monitor inputs ----------

import type { CompactWorker, FleetState } from "../core/monitor.js";
import { parseState, isStateLive } from "../core/state.js";
import { parseHistoryLines, type HistoryRecord } from "../core/history.js";

export interface MonitorInputs {
  workers: CompactWorker[];
  events: Array<Pick<HistoryRecord, "event" | "epoch">>;
  fleet: FleetState | null;
}

function parseFleetState(raw: unknown): FleetState | null {
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as {
    ts?: unknown;
    epoch?: unknown;
    runner?: unknown;
    ready_for_agent?: unknown;
    slots?: { busy?: unknown; free?: unknown; total?: unknown; parked?: unknown };
    spawns_this_tick?: unknown;
  };
  const epoch = Number(rec.epoch ?? 0);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return {
    ts: typeof rec.ts === "string" ? rec.ts : "",
    epoch,
    runner: typeof rec.runner === "string" ? rec.runner : "",
    readyForAgent: Number(rec.ready_for_agent ?? 0) || 0,
    slotsBusy: Number(rec.slots?.busy ?? 0) || 0,
    slotsFree: Number(rec.slots?.free ?? 0) || 0,
    slotsTotal: Number(rec.slots?.total ?? 0) || 0,
    slotsParked: Number(rec.slots?.parked ?? 0) || 0,
    spawnsThisTick: Number(rec.spawns_this_tick ?? 0) || 0,
  };
}

export async function readFleetState(path: string): Promise<FleetState | null> {
  const text = await fsx.readText(path);
  if (text === null) return null;
  try {
    return parseFleetState(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Read every worker state file + the history ledger into the pure renderer's
 * inputs, plus one `git diff --shortstat` per live worktree for the diff column
 * (small fleet → a handful of cheap git calls, like the statusline does). */
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
    // Diff volume: committed + uncommitted work for the attempt, measured from
    // the branch's merge-base with origin/main. Prefer the state file's persisted
    // counts; fall back to a live `git diff --shortstat` of the worktree when both
    // are 0 (same logic as collectStatuslineAfk). Always populated — the dashboard
    // renders the +A -R volume unconditionally (idle / zero included) and sums it
    // into the fleet header, so it is never suppressed.
    let added = state.current.diff_added;
    let removed = state.current.diff_removed;
    if (added === 0 && removed === 0 && state.current.worktree) {
      const stat = await gitx.diffstatShortstat({ cwd: state.current.worktree }, "origin/main");
      added = stat.added;
      removed = stat.removed;
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
      diffAdded: added,
      diffRemoved: removed,
    });
  }

  const histText = await fsx.readText(paths.historyPath);
  const events = histText === null ? [] : parseHistoryLines(histText).map((r) => ({ event: r.event, epoch: r.epoch }));
  const fleet = await readFleetState(paths.fleetStatePath);
  return { workers, events, fleet };
}

// ---------- statusline inputs ----------

import type { AfkInput } from "../core/statusline.js";

/** The TTL (seconds) of the GitHub-derived queue/human counts cache, matching
 * statusline.sh's 60 s window. */
export const STATUSLINE_CACHE_TTL_S = 60;

/** Maximum milliseconds to wait for a cold-cache gh count refresh. If the gh
 * CLI hangs (network stall, rate-limit backoff) the statusline falls back to
 * 0/0 rather than blocking the render indefinitely. */
export const STATUSLINE_GH_COLD_TIMEOUT_MS = 5000;

/**
 * Race `promise` against a deadline. If the deadline fires first, resolves
 * with `fallback` immediately; the original promise is left to settle on its
 * own (no cancel). If the promise settles first, clears the timer and resolves
 * with its value.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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
    // Cold cache: refresh with a bounded deadline so a hanging gh CLI cannot
    // block the statusline render indefinitely. queue/human stay 0/0 on timeout
    // or on any gh/auth/network error.
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
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
 *   - unblockCandidates: the `blocked:dependency` issues the unblock sweep scans.
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
  const [snapshotRefs, remoteLiveRefs, localAll, checkedOut, unblockCandidates, staleClaimDirs, legacyWorkDirs, reconcileSweepCandidates] =
    await Promise.all([
      gitx.listRemoteBranches(gitCtx, "afk-attempts/"),
      gitx.listRemoteBranches(gitCtx, "afk/"),
      gitx.listLocalBranches(gitCtx, "afk/*"),
      gitx.checkedOutBranches(gitCtx),
      ghx.listUnblockCandidates(ghCtx),
      fsx.listStaleClaimDirs(paths.tmpDir),
      fsx.listLegacyWorkDirs(paths.tmpDir),
      ghx.listParkedMechanicalCandidates(ghCtx),
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
    reconcileSweepCandidates,
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
