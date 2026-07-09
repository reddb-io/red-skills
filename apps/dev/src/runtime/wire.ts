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

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostFingerprintPrefix } from "../core/host-identity.js";
import { loadConfig, getConfig, resolveTier } from "../core/config.js";
import type { SandboxMode } from "../core/execution.js";
import type { AgentEffort, RunAgentInput, RunAgentResult, AttemptBudget, AttemptBudgetUsage } from "../core/execution.js";
// Value import (pure, no sandcastle pull — the providers load lazily via
// defaultSandcastleDeps' dynamic import) so resolveRunSettings can parse the
// max-iterations knob from env/config without importing the runtime.
import { parseAttemptTimeout, parseMaxIterations } from "../core/execution.js";
import { resolveLaneIdleStallConfig, type LaneIdleStallConfig } from "../core/lane-idle-reaper.js";
import { inspectProcessTreeNative } from "./proc-tree.js";
import { statSync } from "node:fs";
import {
  evaluateLiveness,
  resolveLivenessCrossCheckArming,
  createProcessDescendantProbe,
  parseLivenessRecords,
  LIVENESS_LANE_FILENAME,
  type LivenessVerdict,
} from "@reddb-io/red-castle";
import { liveIssueFromBranch, type BranchRef } from "../core/branch-cleanup.js";
import { isRunner, type Runner } from "../types/runner.js";
import * as ghx from "./gh.js";
import * as gitx from "./git.js";
import * as fsx from "./fs.js";
import { collectLogLineCounts } from "./log-cursor.js";
import { isLivePid } from "./kill-tree.js";

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
  monitorLogCursorPath: string;
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
    monitorLogCursorPath: join(tmpDir, "monitor-log-cursors.json"),
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
  /**
   * AFK runner improvement (Pattern 2): the base branch the feedback gate
   * rebases a freshly materialised worker worktree onto, or `undefined` when
   * the rebase is OFF. Resolved from `afk.feedback.rebase_on_base` (default
   * false → undefined) AND the config-locked branch (`dev.lock.branch`,
   * falling back to "main"). Left undefined when the flag is off, so the
   * default behaviour — no rebase — is unchanged. The file-level branch lock
   * (`.red/tmp/branch-lock.yaml`) is NOT consulted here: it pins the agent's
   * interactive checkout, not the AFK base, which resolveBase derives
   * per-issue. This session-level base is the common-case trunk; per-issue
   * pinned bases are exactly why the flag defaults off.
   */
  feedbackRebaseBase?: string;
  /**
   * Per-attempt resource budget (#908): the optional token / cost / tool-call /
   * waiting-window ceilings the attempt guard enforces. Every field is optional;
   * an all-undefined budget is inert (today's behaviour). The #788 antidote —
   * the proxy ceilings (tool-calls / waiting-windows) fire live even for
   * claude/minimax, which stream 0 token usage on the wire.
   */
  attemptBudget?: AttemptBudget;
}

const SANDBOX_MODES: readonly SandboxMode[] = ["none", "docker", "podman"];

/** Parse a positive number (int or float) for a budget ceiling; undefined when
 * unset / non-numeric / non-positive, so a typo can never silently set a 0 cap
 * that aborts every attempt instantly. */
function parsePositive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the per-attempt budget (#908) from env overrides then `.red/config.yaml`
 * `plugins.dev.afk.attempt.*` (folded to `afk.attempt.*`). Returns `undefined`
 * when NO ceiling is set, so makeRunAgent can skip wiring the probe entirely and
 * the guard stays at today's behaviour.
 */
export function resolveAttemptBudget(
  env: NodeJS.ProcessEnv,
  getCfg: (key: string) => string,
): AttemptBudget | undefined {
  const budget: AttemptBudget = {
    maxTotalTokens: parsePositive(env.RED_AFK_ATTEMPT_MAX_TOKENS) ?? parsePositive(getCfg("afk.attempt.max_tokens")),
    maxCostUsd: parsePositive(env.RED_AFK_ATTEMPT_MAX_COST_USD) ?? parsePositive(getCfg("afk.attempt.max_cost_usd")),
    maxToolCalls:
      parsePositive(env.RED_AFK_ATTEMPT_MAX_TOOL_CALLS) ?? parsePositive(getCfg("afk.attempt.max_tool_calls")),
    maxWaitingWindows:
      parsePositive(env.RED_AFK_ATTEMPT_MAX_WAITING_WINDOWS) ?? parsePositive(getCfg("afk.attempt.max_waiting_windows")),
  };
  const anySet =
    budget.maxTotalTokens !== undefined ||
    budget.maxCostUsd !== undefined ||
    budget.maxToolCalls !== undefined ||
    budget.maxWaitingWindows !== undefined;
  return anySet ? budget : undefined;
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
  // Pass env so the RED_AFK_MODEL/RED_AFK_EFFORT runtime override (the --model /
  // --effort flags pre-set them) wins over the file, mirroring the sandbox knob.
  const tier = resolveTier(cfg, activeRunner, "think", env);
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
  // Feedback-gate base rebase (Pattern 2). Only resolves to a base branch when
  // the opt-in flag is on; the base is the config-locked branch or the Trunk
  // (`dev.trunk`, ADR 0083 — defaults to "main").
  // A RED_AFK_FEEDBACK_REBASE env knob lets an E2E/CI run force it without
  // mutating .red/config.yaml, mirroring the other RED_AFK_* overrides.
  const rebaseFlag =
    (env.RED_AFK_FEEDBACK_REBASE ?? "").trim() === "1" ||
    getConfig(cfg, "afk.feedback.rebase_on_base") === "true";
  const feedbackRebaseBase = rebaseFlag
    ? getConfig(cfg, "dev.lock.branch") || getConfig(cfg, "dev.trunk") || "main"
    : undefined;
  // Per-attempt resource budget (#908) — env > `afk.attempt.*` config; undefined
  // when no ceiling is set (inert).
  const attemptBudget = resolveAttemptBudget(env, (key) => getConfig(cfg, key));
  return {
    sandbox,
    defaultRunner,
    model: tier.model,
    effort: tier.effort,
    maxIterations,
    attemptTimeoutSeconds,
    laneIdle,
    feedbackRebaseBase,
    attemptBudget,
  };
}

/**
 * Red-castle liveness evaluator verdict for the solo attempt's liveness lane
 * (`liveness.lane.jsonl`). Reads and parses the lane synchronously, then calls
 * `evaluateLiveness` with the configured idle threshold and a process cross-check
 * (no-sandbox only, matching the fleet path). Returns null on any read failure
 * (lane not yet written degrades gracefully to null → not-candidate this tick).
 *
 * Replaces the old `agentLaneMtimeSeconds` firehose-mtime probe (#1022): the
 * liveness lane is the un-poisonable signal that the substrate's own control
 * flow refreshes — never afk.log / agent.log.jsonl / the heartbeat (#243).
 */
export function agentLivenessVerdictSync(
  attemptDir: string,
  laneIdleMs: number,
): LivenessVerdict | null {
  const lanePath = join(attemptDir, LIVENESS_LANE_FILENAME);
  let laneRecencyMs: number | undefined;
  try {
    const raw = readFileSync(lanePath, "utf-8");
    const records = parseLivenessRecords(raw);
    if (records.length > 0) {
      laneRecencyMs = records.reduce((max, r) => (r.at > max ? r.at : max), records[0]!.at);
    }
  } catch {
    // Lane absent or unreadable → laneRecencyMs stays undefined.
  }
  const { crossCheckArmed } = resolveLivenessCrossCheckArming({ sandboxTag: "none" });
  const hasLiveDescendants = crossCheckArmed
    ? createProcessDescendantProbe({ agentPid: process.pid })
    : undefined;
  try {
    return evaluateLiveness({ laneRecencyMs, now: Date.now(), laneIdleMs, crossCheckArmed, hasLiveDescendants });
  } catch {
    return null;
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
  // Per-attempt budget (#908): the resolved ceilings + a live usage probe (the
  // attempt's activity meter `peek()`). Both must be present to arm the cap; it
  // rides the existing progress guard, so it is only active when that guard is.
  attemptBudget?: AttemptBudget,
  budgetUsage?: () => AttemptBudgetUsage,
): (input: RunAgentInput) => Promise<RunAgentResult> {
  let depsPromise: Promise<import("../core/execution.js").SandcastleDeps> | null = null;
  return async (input: RunAgentInput): Promise<RunAgentResult> => {
    const {
      runAgent,
      defaultSandcastleDeps,
      parseIdleTimeout,
      DEFAULT_ATTEMPT_TIMEOUT_S,
      DEFAULT_ATTEMPT_HARD_CAP_S,
      parseAttemptHardCap,
    } = await import("../core/execution.js");
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
    // Commit-anchored hard cap (issue #637): bounds how long the edit-signal
    // below may keep extending the soft deadline. Never below the soft cap, so
    // a low override cannot make the hard cap fire before plain ADR 0044 would.
    const attemptHardCap = Math.max(
      input.attemptHardCapSeconds ?? parseAttemptHardCap(env.RED_AFK_ATTEMPT_HARD_CAP_S) ?? DEFAULT_ATTEMPT_HARD_CAP_S,
      attemptTimeout,
    );
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
            attemptHardCapSeconds: attemptHardCap,
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
              const baseRef = input.base ? `origin/${input.base}` : "origin/main";
              const { added, removed } = await gitx.diffstatShortstat({ cwd: worktree }, baseRef);
              return added + removed;
            },
          }
        : {}),
      // Per-attempt budget (#908): only wired when the progress guard is armed
      // (the budget check rides its poll) AND a budget + live usage probe exist.
      ...(guardArmed && attemptBudget && budgetUsage ? { budget: attemptBudget, budgetUsage } : {}),
      ...(laneArmed && laneAttemptDir
        ? {
            laneIdleThresholdSeconds: laneIdleCfg.stallThresholdS,
            laneIdleKillThresholdSeconds: laneIdleCfg.stallKillThresholdS,
            laneIdlePollSeconds: laneIdleCfg.stallPollS,
            // Clean liveness signal: the evaluator over the attempt's
            // liveness.lane.jsonl — the un-poisonable lane (#1022, ADR 0083 §3).
            livenessVerdictProbe: () =>
              agentLivenessVerdictSync(laneAttemptDir, laneIdleCfg.stallThresholdS * 1000),
            // Inner-agent tree is a descendant of this worker process; the native
            // inspector is safe-by-default (a failed ps reports busy, never reaps).
            inspectTree: () => inspectProcessTreeNative(process.pid),
          }
        : {}),
    });
  };
}

// ---------- monitor inputs ----------

import type { CompactWorker, FleetState, SlotDetail } from "../core/monitor.js";
import {
  readWorkerState,
  readAllWorkerStates,
  currentRenderableWorkerRecords,
  type WorkerStateRecord,
} from "../core/worker-state-reader.js";
import { planLivenessReclaim, type LivenessReclaimInput } from "../core/reclaim.js";
import type { WorkerVitals } from "../types/state.js";
import { parseHistoryLines, type HistoryRecord } from "../core/history.js";

export interface MonitorInputs {
  workers: CompactWorker[];
  events: Array<Pick<HistoryRecord, "event" | "epoch">>;
  fleet: FleetState | null;
  /** GitHub queue/human counts read passively from the statusline TTL cache.
   * Absent when the cache file has never been written (no statusline run yet). */
  remoteQueue?: number;
  remoteHuman?: number;
  /** Age of the statusline cache in seconds. Undefined when no cache file exists.
   * The monitor render shows a stale marker when this exceeds the resolved
   * statusline cache TTL ({@link resolveStatuslineCacheTtl}). */
  remoteCacheAgeS?: number;
}

const SLOT_STATUSES = new Set<SlotDetail["status"]>(["open", "half-open", "idle-parked"]);

function parseFleetState(raw: unknown): FleetState | null {
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as {
    ts?: unknown;
    epoch?: unknown;
    last_progress_epoch?: unknown;
    runner?: unknown;
    ready_for_agent?: unknown;
    slots?: { busy?: unknown; free?: unknown; total?: unknown; parked?: unknown };
    spawns_this_tick?: unknown;
    slot_details?: unknown;
  };
  const epoch = Number(rec.epoch ?? 0);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const rawProgress = Number(rec.last_progress_epoch ?? 0);

  let slotDetails: SlotDetail[] | undefined;
  if (Array.isArray(rec.slot_details)) {
    slotDetails = [];
    for (const d of rec.slot_details as unknown[]) {
      if (d === null || typeof d !== "object") continue;
      const entry = d as { index?: unknown; status?: unknown; retry_at?: unknown };
      const idx = Number(entry.index ?? -1);
      if (!Number.isFinite(idx) || idx < 0) continue;
      const status = entry.status;
      if (typeof status !== "string" || !SLOT_STATUSES.has(status as SlotDetail["status"])) continue;
      const rawRetry = entry.retry_at !== undefined ? Number(entry.retry_at) : undefined;
      const retryAt = rawRetry !== undefined && Number.isFinite(rawRetry) ? rawRetry : undefined;
      slotDetails.push({ index: idx, status: status as SlotDetail["status"], ...(retryAt !== undefined ? { retryAt } : {}) });
    }
  }

  return {
    ts: typeof rec.ts === "string" ? rec.ts : "",
    epoch,
    lastProgressEpoch: Number.isFinite(rawProgress) && rawProgress > 0 ? rawProgress : undefined,
    runner: typeof rec.runner === "string" ? rec.runner : "",
    readyForAgent: Number(rec.ready_for_agent ?? 0) || 0,
    slotsBusy: Number(rec.slots?.busy ?? 0) || 0,
    slotsFree: Number(rec.slots?.free ?? 0) || 0,
    slotsTotal: Number(rec.slots?.total ?? 0) || 0,
    slotsParked: Number(rec.slots?.parked ?? 0) || 0,
    spawnsThisTick: Number(rec.spawns_this_tick ?? 0) || 0,
    ...(slotDetails !== undefined ? { slotDetails } : {}),
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

/** Injected seams for {@link reclaimDeadWorkers} (real defaults wire gh/git/fs). */
export interface DeadWorkerSweepDeps {
  /** Raw `worker.pid` text for a worker dir. Default reads `{workerDir}/worker.pid`. */
  readWorkerPid?: (workerDir: string) => string | null;
  /** `kill -0` liveness probe. Default `process.kill(pid, 0)`. */
  killAlive?: (pid: number) => boolean;
  /** Whether an issue is in a post-mortem preservation state (blocked:* /
   * ready-for-human). Default `gh issue view --json labels`. Returns `true`
   * (conservative — keep the JSONL) whenever it cannot resolve. */
  isPreserved?: (issue: number) => Promise<boolean>;
  /** `git worktree remove --force`. Default runtime git against `root`. */
  removeWorktree?: (worktreePath: string) => Promise<void>;
  /** `rm -rf`. Default `fsx.removeDir`. */
  removeDir?: (dir: string) => Promise<void>;
  /** Path existence probe. Default `existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Read-time liveness-gated teardown (issue #1219): as workers finish/crash, take
 * them out of context — remove the heavy local `worktree/` and reclaim the
 * attempt dir immediately, without waiting for the boot TTLs (reclaim.ts). Runs
 * across the SAME namespace union the reader uses (workers/go-workers/
 * scout-workers) since it consumes {@link readAllWorkerStates} records.
 *
 * Safety rules (see {@link planLivenessReclaim}):
 *   - NEVER touch a live worker's dir — keyed on the OWNING worker's `worker.pid`
 *     (shared across a worker's attempts), so a worker live on a later attempt
 *     keeps ALL its dirs.
 *   - A dead worker's disposable `worktree/` is ALWAYS removed.
 *   - The whole attempt dir is reclaimed UNLESS the issue is preserved
 *     (blocked:* / ready-for-human), where the JSONL/handoff stay for post-mortem.
 *
 * Best-effort throughout: every fs/git/gh failure is swallowed so the sweep never
 * breaks the read it rides on. Returns the reclaimed attempt-dir paths.
 */
export async function reclaimDeadWorkers(
  root: string,
  records: ReadonlyArray<WorkerStateRecord>,
  repo = "",
  deps: DeadWorkerSweepDeps = {},
): Promise<string[]> {
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const readWorkerPid =
    deps.readWorkerPid ??
    ((workerDir: string): string | null => {
      try {
        return readFileSync(join(workerDir, "worker.pid"), "utf8");
      } catch {
        return null;
      }
    });
  const killAlive =
    deps.killAlive ??
    ((pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const isPreserved =
    deps.isPreserved ??
    (async (issue: number): Promise<boolean> => {
      try {
        const labels = await ghx.viewLabels({ cwd: root, repo }, issue);
        // Empty labels (gh failed) → conservative: keep the JSONL.
        if (labels.length === 0) return true;
        return labels.some((l) => l === LABEL_HUMAN || l.startsWith("blocked:"));
      } catch {
        return true;
      }
    });
  const removeWorktree =
    deps.removeWorktree ??
    (async (worktreePath: string): Promise<void> => {
      await gitx.worktreeRemove({ cwd: root }, worktreePath);
    });
  const removeDir = deps.removeDir ?? ((dir: string) => fsx.removeDir(dir));

  // Per-worker `worker.pid` liveness, memoized so a worker's several attempt dirs
  // resolve it once.
  const workerAliveCache = new Map<string, boolean>();
  const workerPidAlive = (workerDir: string): boolean => {
    const cached = workerAliveCache.get(workerDir);
    if (cached !== undefined) return cached;
    const raw = readWorkerPid(workerDir);
    const pid = raw ? parseInt(raw.trim(), 10) : NaN;
    // Absent/unparseable worker.pid → treat as ALIVE (never reclaim a dir we
    // cannot prove belongs to a dead worker).
    const alive = Number.isFinite(pid) && pid > 0 ? killAlive(pid) : true;
    workerAliveCache.set(workerDir, alive);
    return alive;
  };

  // Build the pure planner inputs, resolving preservation only for dead workers.
  const inputs: LivenessReclaimInput[] = [];
  for (const rec of records) {
    const attemptDir = dirname(rec.path);
    const workerDir = dirname(attemptDir);
    // A renderable-live record (or a worker still live on any attempt) is never
    // a reclaim candidate.
    const alive = rec.renderableLive || workerPidAlive(workerDir);
    const num = rec.state.current.number;
    const issue = typeof num === "number" ? num : Number.parseInt(String(num), 10);
    const preserved =
      Number.isFinite(issue) && issue > 0 ? await isPreserved(issue) : true;
    inputs.push({
      attemptDir,
      worktreePath: join(attemptDir, "worktree"),
      workerPidAlive: alive,
      preserved,
    });
  }

  const reclaimed: string[] = [];
  for (const action of planLivenessReclaim(inputs)) {
    if (action.removeWorktree && exists(action.worktreePath)) {
      await removeWorktree(action.worktreePath).catch(() => undefined);
    }
    if (action.reclaimDir) {
      await removeDir(action.attemptDir).catch(() => undefined);
      reclaimed.push(action.attemptDir);
    }
  }
  return reclaimed;
}

/** Read every worker state file + the history ledger into the pure renderer's
 * inputs, plus one `git diff --shortstat` per live worktree for the diff column
 * (small fleet → a handful of cheap git calls, like the statusline does). */
export async function collectMonitorInputs(root = process.cwd(), repo = ""): Promise<MonitorInputs> {
  const paths = afkPaths(root);
  // The ONE owner reads + normalizes + liveness-tags every worker state file
  // (core/worker-state-reader). The single source of liveness truth for all
  // surfaces is WorkerStateRecord.livenessVerdict (evaluator verdict, ADR 0083 §3).
  // Namespace-blind union: aggregate live workers across the fleet, `/go`, and
  // `--scout` lanes so a `/go`/`--scout` worker appears in the monitor/dashboard,
  // tagged distinctly by state.origin. (Not the single-lane paths.workersRoot,
  // which would render only the `.red/tmp/workers` fleet lane.)
  const records = await readAllWorkerStates(paths.tmpDir);
  // Read-time liveness-gated teardown (issue #1219): reclaim dead-worker
  // worktrees/dirs immediately, not on the boot TTL. Best-effort — a failure
  // here never blocks the render. Live-worker dirs and blocked/ready-for-human
  // post-mortem artifacts are preserved (planLivenessReclaim).
  await reclaimDeadWorkers(root, records, repo).catch(() => undefined);
  const currentRecords = currentRenderableWorkerRecords(records);
  const logPaths = currentRecords.map(({ path, state }) => state.log || join(dirname(path), "afk.log"));
  const logCounts = await collectLogLineCounts(paths.monitorLogCursorPath, logPaths);
  const workers: CompactWorker[] = [];
  for (const { path, state, active, live: pidLive, liveness, livenessVerdict } of currentRecords) {
    // The shared current-worker selector applies the `renderableLive` gate and
    // collapses retained sibling attempt dirs to one row per worker.
    // Diff volume: committed + uncommitted work for the attempt, measured from
    // the branch's merge-base with origin/main. #1210 Part B: read it from the
    // state file's writer-stamped counts only — the monitor render performs NO
    // git subprocess. The per-attempt heartbeat owns the diffstat for every
    // runner (via the commit-anchored memo), so the old live `git diff
    // --shortstat` fallback is gone. Always populated — the dashboard renders the
    // +A -R volume unconditionally (idle / zero included) and sums it into the
    // fleet header, so it is never suppressed.
    const added = state.current.loc_added;
    const removed = state.current.loc_removed;

    const logPath = state.log || join(dirname(path), "afk.log");
    const counts = logCounts.get(logPath);
    workers.push({
      state: {
        worker_id: state.worker_id,
        pid: state.pid,
        runner: state.runner,
        started_at: state.started_at,
        // Spawn-time provenance — passed through from the single state.origin
        // field so the dashboard derives per-source counts from the same source
        // as the statusline (issue #930, no independent derivation).
        origin: state.origin || undefined,
        total: state.total,
        done: state.done,
        blocked: state.blocked,
        failed: state.failed,
        current: {
          number: state.current.number,
          title: state.current.title,
          stage: state.current.stage,
          started_at: state.current.started_at,
          input_tokens: state.current.input_tokens,
          output_tokens: state.current.output_tokens,
          cost_usd: state.current.cost_usd,
          tools_called_count: state.current.tools_called_count,
          text_chunk_count: state.current.text_chunk_count,
          reasoning_events: state.current.reasoning_events,
          waiting_count: state.current.waiting_count,
        },
      },
      liveness,
      livenessVerdict,
      // active = evaluator says "alive" → [live] badge.
      // pidLive kept for backward compat with older test stubs (ignored when
      // livenessVerdict is present).
      live: active,
      pidLive,
      diffAdded: added,
      diffRemoved: removed,
      ...(counts !== undefined ? { logLines: counts.lines, logNewLines: counts.newLines } : {}),
    });
  }

  const histText = await fsx.readText(paths.historyPath);
  const events = histText === null ? [] : parseHistoryLines(histText).map((r) => ({ event: r.event, epoch: r.epoch }));
  const fleet = await readFleetState(paths.fleetStatePath);

  // Remote facts: read the statusline TTL cache passively (no refresh — the monitor
  // is read-only; the statusline owns the cache lifecycle). Include queue/human counts
  // and the cache age so the render can show a stale marker when the data is old.
  const cachePath = join(paths.tmpDir, "statusline-cache.json");
  const cached = readStatuslineCache(cachePath);
  const nowS = Math.floor(Date.now() / 1000);
  const remoteExtra = cached !== null
    ? { remoteQueue: cached.queue, remoteHuman: cached.human, remoteCacheAgeS: nowS - cached.ts }
    : {};

  return { workers, events, fleet, ...remoteExtra };
}

// ---------- statusline inputs ----------

import type { AfkInput, RepoInput } from "../core/statusline.js";

/** The DEFAULT TTL (seconds) of every EXPENSIVE FETCHED statusline number — the
 * GitHub-derived queue/human and open-PR/open-issue counts AND the repo-global
 * local diffstat. 180 s (3 min): the statusline renders on every prompt, so a
 * per-render gh/git round-trip (~5 s under load) would freeze the TUI. The
 * effective TTL is resolved by {@link resolveStatuslineCacheTtl}
 * (RED_AFK_STATUSLINE_CACHE_TTL_S env > `afk.statusline_cache_ttl` config > this
 * default) and threaded into both the writer (statusline command) and the
 * readers (monitor path + stale-marker threshold) so the network cost is paid at
 * most once per TTL, never per render (issue #1178, #1217). */
export const STATUSLINE_CACHE_TTL_S = 900;
export const STATUSLINE_REFRESH_LOCK_TTL_S = 60;

/**
 * Resolve the effective statusline cache TTL (seconds) with precedence
 * RED_AFK_STATUSLINE_CACHE_TTL_S env > `afk.statusline_cache_ttl` config >
 * {@link STATUSLINE_CACHE_TTL_S} default (180). Mirrors the resolveAttemptBudget
 * / parseAttemptTimeout precedence pattern. Typo-safe: a missing / non-numeric /
 * zero / negative value from EITHER source falls through to the next source and
 * ultimately the 180 default — never 0. A 0 TTL would make the cache always-stale
 * and refresh on every render, defeating the whole purpose. Note the FLAT config
 * key `afk.statusline_cache_ttl` — NOT nested under `afk.statusline`, which is
 * already the boolean opt-out (YAML cannot make one key both a boolean and a map).
 */
export function resolveStatuslineCacheTtl(env: NodeJS.ProcessEnv, getCfg: (key: string) => string): number {
  return (
    parsePositive(env.RED_AFK_STATUSLINE_CACHE_TTL_S) ??
    parsePositive(getCfg("afk.statusline_cache_ttl")) ??
    STATUSLINE_CACHE_TTL_S
  );
}

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

type DetachedSpawn = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv },
) => Pick<ChildProcess, "unref">;

export interface StatuslineRefreshSpawnOptions {
  spawn?: DetachedSpawn;
  nowS?: number;
  argv1?: string;
}

export function statuslineCountCachePath(root: string): string {
  return join(afkPaths(root).tmpDir, "statusline-cache.json");
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
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort, like the bash `|| true`
  }
}

export function parseGitHubRepoSlugFromRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return ssh[1] ?? "";
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https) return https[1] ?? "";
  return "";
}

function readGitFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function inferGitHubRepoSlug(root: string): string {
  const dotGit = join(root, ".git");
  const gitMarker = readGitFile(dotGit);
  const configCandidates = [join(dotGit, "config")];
  const gitDir = /^gitdir:\s*(.+)$/m.exec(gitMarker)?.[1]?.trim();
  if (gitDir) {
    const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(root, gitDir);
    configCandidates.push(join(absoluteGitDir, "config"));
    configCandidates.push(join(absoluteGitDir, "..", "..", "config"));
  }
  for (const configPath of configCandidates) {
    const config = readGitFile(configPath);
    const origin = /\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)\n/.exec(`${config}\n`)?.[1];
    const slug = origin ? parseGitHubRepoSlugFromRemoteUrl(origin) : "";
    if (slug) return slug;
  }
  return "";
}

function statuslineRefreshLockPath(cachePath: string): string {
  return `${cachePath}.refresh.lock`;
}

function releaseStatuslineRefreshLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

function acquireStatuslineRefreshLock(lockPath: string, nowS: number): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, ts: nowS });
  try {
    writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    const existing = readStatuslineCache(lockPath);
    if (existing && nowS - existing.ts < STATUSLINE_REFRESH_LOCK_TTL_S) return false;
    releaseStatuslineRefreshLock(lockPath);
    try {
      writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export function applyStatuslineCountCacheLabelDelta(
  cachePath: string,
  remove: readonly string[],
  add: readonly string[],
  nowS: number = Math.floor(Date.now() / 1000),
): boolean {
  const cached = readStatuslineCache(cachePath);
  if (!cached) return false;
  const removed = new Set(remove);
  const added = new Set(add);
  const deltaFor = (label: string): number => (added.has(label) ? 1 : 0) - (removed.has(label) ? 1 : 0);
  const queueDelta = deltaFor(LABEL_READY);
  const humanDelta = deltaFor(LABEL_HUMAN);
  if (queueDelta === 0 && humanDelta === 0) return false;
  writeStatuslineCacheAtomic(cachePath, {
    queue: Math.max(0, cached.queue + queueDelta),
    human: Math.max(0, cached.human + humanDelta),
    ts: nowS,
  });
  return true;
}

export async function editLabelsWithStatuslineCache(
  cachePath: string,
  edit: () => Promise<boolean>,
  remove: readonly string[],
  add: readonly string[],
): Promise<boolean> {
  const ok = await edit();
  if (ok) applyStatuslineCountCacheLabelDelta(cachePath, remove, add);
  return ok;
}

export async function refreshStatuslineCountCache(
  root: string,
  repo: string = inferGitHubRepoSlug(root),
  lockPath?: string,
): Promise<void> {
  try {
    const cachePath = statuslineCountCachePath(root);
    const counts = await ghx.countStatuslineQueueCounts({ cwd: root, repo });
    writeStatuslineCacheAtomic(cachePath, { ...counts, ts: Math.floor(Date.now() / 1000) });
  } finally {
    if (lockPath) releaseStatuslineRefreshLock(lockPath);
  }
}

export function startDetachedStatuslineCountRefresh(
  ctx: RepoContext,
  options: StatuslineRefreshSpawnOptions = {},
): boolean {
  const cachePath = statuslineCountCachePath(ctx.root);
  const nowS = options.nowS ?? Math.floor(Date.now() / 1000);
  const lockPath = statuslineRefreshLockPath(cachePath);
  const repo = ctx.repo || inferGitHubRepoSlug(ctx.root);
  const argv1 = options.argv1 ?? process.argv[1];
  if (!repo || !argv1) return false;
  if (!acquireStatuslineRefreshLock(lockPath, nowS)) return false;
  try {
    const child = (options.spawn ?? spawn)(process.execPath, [
      argv1,
      "statusline-refresh-counts",
      ctx.root,
      "--repo",
      repo,
      "--lock",
      lockPath,
    ], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, RED_AFK_STATUSLINE_REFRESH_CHILD: "1" },
    });
    child.unref();
    return true;
  } catch {
    releaseStatuslineRefreshLock(lockPath);
    return false;
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
 * The `rq` ready-for-agent / `rh` ready-for-human counts are GitHub-derived and
 * cached for {@link STATUSLINE_CACHE_TTL_S} seconds in
 * `.red/tmp/statusline-cache.json`. The cache refreshes on every stale or cold
 * render — awaited with a bounded deadline so a hanging gh CLI cannot block the
 * statusline process indefinitely. The refresh runs even when there are no live
 * workers so the queue/human badges stay current while the fleet is idle.
 */
export async function collectStatuslineAfk(
  ctx: RepoContext,
  cacheTtlS: number = STATUSLINE_CACHE_TTL_S,
  refreshOptions: StatuslineRefreshSpawnOptions = {},
): Promise<AfkInput | null> {
  const paths = afkPaths(ctx.root);
  // Same single owner as the monitor (core/worker-state-reader).
  const nowMs = Date.now();
  // Namespace-blind union across the fleet, `/go`, and `--scout` lanes so the
  // statusline counts a live `/go`/`--scout` worker (rendered per-origin via
  // state.origin), not only the `.red/tmp/workers` fleet lane.
  const records = currentRenderableWorkerRecords(await readAllWorkerStates(paths.tmpDir, { nowMs }));
  const gitCtx: gitx.GitContext = { cwd: ctx.root };

  let workers = 0;
  let blocked = 0;
  let added = 0;
  let removed = 0;
  let locIsPeak = false;
  let waiting = 0;
  let tokens = 0;
  let costUsd = 0;
  // `runner`/`model`/`effort` come from the first live worker (fleets are
  // single-runner in practice). `resolved` is maxed across workers since they
  // all mirror the same supervisor's done count.
  let runner = "";
  let model = "";
  let effort = "";
  let resolved = 0;
  const issues: Array<number | string> = [];
  const stages: Array<string | undefined> = [];
  const aliveMsList: number[] = [];
  const sourceMap = new Map<string, number>();

  for (const { state } of records) {
    // Shared with the monitor/per-worker statusline collectors: renderable rows
    // are already gated and collapsed to one current attempt per worker.
    workers += 1;
    blocked += state.blocked;
    if (runner === "" && state.runner) runner = state.runner;
    if (model === "" && state.current.model) model = state.current.model;
    if (effort === "" && state.current.effort) effort = state.current.effort;
    if (state.done > resolved) resolved = state.done;
    // Per-source count: read origin from the single state field (issue #930).
    if (state.origin) sourceMap.set(state.origin, (sourceMap.get(state.origin) ?? 0) + 1);
    // Alive time: elapsed ms since this worker's top-level started_at, or 0
    // when the timestamp is absent (pre-schema state files).
    const startedAt = state.started_at || state.current.started_at;
    const workerAliveMs = startedAt ? Math.max(0, nowMs - Date.parse(startedAt)) : 0;
    // Read the worker's signals through the canonical WorkerVitals contract
    // (ADR 0065) rather than ad-hoc field access — `current` satisfies it.
    const vitals: WorkerVitals = state.current;
    // Silent-agent signal: cumulative heartbeat windows with no new stream
    // event. Summed across the fleet and shown as wtN so a wedged-but-not-dead
    // worker is visible.
    waiting += vitals.waiting_count;
    // Cost group: per-worker token spend + USD, summed for the fleet.
    tokens += vitals.input_tokens + vitals.output_tokens;
    costUsd += vitals.cost_usd;

    let a = vitals.loc_added;
    let r = vitals.loc_removed;
    // #1210 Part B: the render NEVER shells out to git. LOC ownership moved to
    // the writers (the per-attempt heartbeat stamps loc_added/loc_removed for
    // ALL runners via the commit-anchored memo), so the old `git diff
    // --shortstat` render fallback is gone. When the writer's live value is 0/0
    // the sticky per-attempt peak below keeps `loc=` visible without git.
    // Sticky fallback: if the live diff is still 0 but a prior non-zero value
    // was seen this attempt, use the peak so `loc=` stays visible with a `~`
    // prefix instead of disappearing (which looks alarming even when intact).
    if (a === 0 && r === 0) {
      const pa = state.current.loc_peak_added ?? 0;
      const pr = state.current.loc_peak_removed ?? 0;
      if (pa > 0 || pr > 0) {
        a = pa;
        r = pr;
        locIsPeak = true;
      }
    }
    added += a;
    removed += r;

    const number = state.current.number;
    if (number !== "" && number !== undefined && number !== null) {
      issues.push(number);
      // Aligned by index with `issues`: stage + alive time suffix each `#N` token.
      stages.push(state.current.stage || undefined);
      aliveMsList.push(workerAliveMs);
    }
  }

  // GitHub-derived counts with a 180 s (3 min) cache (configurable, #1217) —
  // refreshed before the early-return so queue/human stay current even when the
  // fleet is idle (workers == 0).
  const cachePath = statuslineCountCachePath(ctx.root);
  const nowS = Math.floor(Date.now() / 1000);
  const cached = readStatuslineCache(cachePath);
  let queue = cached?.queue ?? 0;
  let human = cached?.human ?? 0;

  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo || inferGitHubRepoSlug(ctx.root) };
  let refreshSucceeded = false;
  const refresh = async (): Promise<void> => {
    const counts = await ghx.countStatuslineQueueCounts(ghCtx);
    queue = counts.queue;
    human = counts.human;
    refreshSucceeded = true;
    writeStatuslineCacheAtomic(cachePath, { queue, human, ts: nowS });
  };

  let cacheAgeS: number | undefined;
  if (!cached) {
    // Cold cache: refresh with a bounded deadline so a hanging gh CLI cannot
    // block the statusline render indefinitely. queue/human stay 0/0 on timeout
    // or on any gh/auth/network error.
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
  } else if (nowS - cached.ts >= cacheTtlS) {
    const staleAgeS = nowS - cached.ts;
    cacheAgeS = staleAgeS;
    startDetachedStatuslineCountRefresh(
      { ...ctx, repo: ghCtx.repo },
      { ...refreshOptions, nowS },
    );
  }

  if (workers <= 0) return null;

  // Build the per-source count array sorted by origin for a deterministic order.
  // Both statusline and monitor read from state.origin via readAllWorkerStates —
  // this is the one derived form; nothing else derives source counts independently.
  const sourceCounts =
    sourceMap.size > 0
      ? [...sourceMap.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([origin, count]) => ({ origin, count }))
      : undefined;

  return {
    workers, queue, human, blocked, added, removed,
    locIsPeak: locIsPeak || undefined,
    waiting, tokens, costUsd,
    runner, resolved, issues, stages,
    aliveMs: aliveMsList.length > 0 ? aliveMsList : undefined,
    model: model || undefined,
    effort: effort || undefined,
    sourceCounts,
    cacheAgeS,
  };
}

/**
 * Per-worker records for the themed Claude Code statusline's multi-line layout
 * (issue #1165): one {@link CompactWorker} per LIVE worker, each rendered on its
 * own line by the SAME `renderWorkerCompactLine` formatter `/afk monitor --once`
 * uses (single source of truth — the two never drift). Mirrors the liveness
 * filter of {@link collectStatuslineAfk} (only "stalled" workers are dropped) and
 * its diff-fallback (a live `git diff --shortstat` when the state file's counts
 * are both 0). Sorted by worker start for a deterministic line order. Returns []
 * when no live workers, so the styled render emits the header line alone.
 *
 * The aggregate counts (queue/human + their gh cache) stay in
 * collectStatuslineAfk — this collector is per-worker only; the command runs both
 * (each a cheap handful of file reads) and feeds the aggregate to the plain form
 * and the per-worker records to the themed form.
 */
export async function collectStatuslineWorkers(ctx: RepoContext): Promise<CompactWorker[]> {
  const paths = afkPaths(ctx.root);
  const nowMs = Date.now();
  const records = currentRenderableWorkerRecords(await readAllWorkerStates(paths.tmpDir, { nowMs }));
  const workers: CompactWorker[] = [];
  for (const { state, active, live: pidLive, liveness, livenessVerdict } of records) {
    // The shared current-worker selector applies the `renderableLive` gate and
    // collapses retained sibling attempt dirs to one row per worker.
    // #1210 Part B: no per-render git subprocess — read the writer-stamped LOC
    // straight from the state file (the heartbeat owns it for every runner).
    const added = state.current.loc_added;
    const removed = state.current.loc_removed;
    workers.push({
      state: {
        worker_id: state.worker_id,
        pid: state.pid,
        runner: state.runner,
        started_at: state.started_at,
        origin: state.origin || undefined,
        total: state.total,
        done: state.done,
        blocked: state.blocked,
        failed: state.failed,
        current: {
          number: state.current.number,
          title: state.current.title,
          stage: state.current.stage,
          started_at: state.current.started_at,
          model: state.current.model,
          effort: state.current.effort,
          input_tokens: state.current.input_tokens,
          output_tokens: state.current.output_tokens,
          cost_usd: state.current.cost_usd,
          tools_called_count: state.current.tools_called_count,
          text_chunk_count: state.current.text_chunk_count,
          reasoning_events: state.current.reasoning_events,
          waiting_count: state.current.waiting_count,
        },
      },
      liveness,
      livenessVerdict,
      live: active,
      pidLive,
      diffAdded: added,
      diffRemoved: removed,
    });
  }
  // Deterministic order: oldest worker first (by top-level start, then per-attempt).
  workers.sort((a, b) => {
    const ka = a.state.started_at || a.state.current.started_at || "";
    const kb = b.state.started_at || b.state.current.started_at || "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return workers;
}

interface RepoStatsCache {
  openPrs: number;
  todayPrs: number;
  openIssues: number;
  localAdded: number;
  localRemoved: number;
  ts: number;
}

function readRepoStatsCache(path: string): RepoStatsCache | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RepoStatsCache>;
    return {
      openPrs: Number(parsed.openPrs ?? 0),
      todayPrs: Number(parsed.todayPrs ?? 0),
      openIssues: Number(parsed.openIssues ?? 0),
      localAdded: Number(parsed.localAdded ?? 0),
      localRemoved: Number(parsed.localRemoved ?? 0),
      ts: Number(parsed.ts ?? 0),
    };
  } catch {
    return null;
  }
}

function writeRepoStatsCacheAtomic(path: string, cache: RepoStatsCache): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort, like the bash `|| true`
  }
}

/**
 * Repo-global statusline header inputs (line 1, ALWAYS rendered — unlike the
 * AFK block these show with no live workers): open-PR / open-issue counts from
 * GitHub PLUS the LOCAL branch diffstat (committed + uncommitted vs origin/main)
 * measured at the project root. All three are EXPENSIVE FETCHED numbers (gh/git
 * subprocesses), so all three are cached together for {@link
 * STATUSLINE_CACHE_TTL_S} seconds in `.red/tmp/statusline-repo-cache.json`: a
 * fresh render serves them WITHOUT any gh/git subprocess; a cold/stale render
 * pays one bounded refresh (issue #1178 — never a per-render git diff). Every
 * field is fail-open: any gh/git error leaves it 0.
 */
export async function collectStatuslineRepo(
  ctx: RepoContext,
  cacheTtlS: number = STATUSLINE_CACHE_TTL_S,
): Promise<RepoInput> {
  const paths = afkPaths(ctx.root);
  const cachePath = join(paths.tmpDir, "statusline-repo-cache.json");
  const nowS = Math.floor(Date.now() / 1000);
  const cached = readRepoStatsCache(cachePath);
  let openPrs = cached?.openPrs ?? 0;
  let todayPrs = cached?.todayPrs ?? 0;
  let openIssues = cached?.openIssues ?? 0;
  let localAdded = cached?.localAdded ?? 0;
  let localRemoved = cached?.localRemoved ?? 0;

  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  let repoRefreshSucceeded = false;
  const refresh = async (): Promise<void> => {
    // The local branch diff (committed + uncommitted) vs origin/main is folded
    // into the same refresh as the gh counts — diffstatShortstat resolves the
    // merge-base, so this counts every commit on the branch plus the dirty
    // worktree. It is a git subprocess and therefore cacheable: no per-render
    // git diff.
    const [p, t, i, diff] = await Promise.all([
      ghx.countOpenPrs(ghCtx),
      ghx.countPrsCreatedToday(ghCtx),
      ghx.countOpenIssues(ghCtx),
      gitx.diffstatShortstat({ cwd: ctx.root }, "origin/main"),
    ]);
    openPrs = p;
    todayPrs = t;
    openIssues = i;
    localAdded = diff.added;
    localRemoved = diff.removed;
    repoRefreshSucceeded = true;
    writeRepoStatsCacheAtomic(cachePath, {
      openPrs: p,
      todayPrs: t,
      openIssues: i,
      localAdded: diff.added,
      localRemoved: diff.removed,
      ts: nowS,
    });
  };
  let repoCacheAgeS: number | undefined;
  if (!cached) {
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
  } else if (nowS - cached.ts >= cacheTtlS) {
    // Stale: await a bounded refresh so the cache is rewritten before the
    // process exits. Shows the previous value on timeout (fail-open). When
    // refresh fails, mark the age so the renderer can signal staleness.
    const staleAgeS = nowS - cached.ts;
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
    if (!repoRefreshSucceeded) repoCacheAgeS = staleAgeS;
  }

  return { openPrs, todayPrs, openIssues, localAdded, localRemoved, cacheAgeS: repoCacheAgeS };
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

import type { PrecheckFacts, BootOptions, BootDeps, BootstrapInput, OrphanDir } from "../core/boot.js";
import type { AttemptDir } from "../core/reclaim.js";
import type { IssueStateRow } from "./gh.js";
import { LABEL_HUMAN, LABEL_READY, LABEL_RUNNING } from "../core/triage-labels.js";
import { parseWorkerAttemptPath } from "../core/worker-paths.js";
import { parseClaimRecords } from "../core/claim.js";

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
    // Cap-pass liveness keeps the pid-identity verdict (a live attempt is
    // excluded from the cap even when briefly quiet), read through the single
    // owner so the schema + legacy-key shim apply here too.
    const live = readWorkerState(join(o.path, "afk.state.json"))?.live ?? false;
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
  const { branchLockPath, readLockedBranch } = await import("./lock.js");
  const lockPath = branchLockPath(ctx.root);
  const [ghInstalled, ghAuthenticated, isRepo, remoteUrls, hasMain, currentBranch, pnpmProbe, lockedBranch] =
    await Promise.all([
      ghx.ghInstalled(ghCtx),
      ghx.ghAuthenticated(ghCtx),
      gitx.isGitRepo(gitCtx),
      gitx.remoteUrls(gitCtx),
      gitx.hasMainBranch(gitCtx),
      gitx.currentBranch(gitCtx),
      import("./exec.js").then((m) => m.pnpm(["--version"], { cwd: ctx.root })),
      readLockedBranch(lockPath),
    ]);
  const pnpmInstalled = pnpmProbe.code !== 127;
  return {
    ghInstalled,
    ghAuthenticated,
    isGitRepo: isRepo,
    remoteUrls,
    hasMainBranch: hasMain,
    currentBranch,
    lockedBranch,
    pnpmInstalled,
    // CI lanes (the GHA Actions lane) check out an https remote token-authed by
    // GITHUB_TOKEN — the intended setup — so the SSH-only rule must not fire there.
    allowHttpsRemote:
      process.env.RED_AFK_LANE === "actions" || process.env.GITHUB_ACTIONS === "true",
  };
}

// ---------- boot deps ----------

/** Pre-resolve the gh issue-state cache the branch-cleanup reapers + orphan
 * lookup read synchronously. Mirrors collectReapInputs' eager resolution, but
 * sources every issue's meta from the SINGLE batched `listIssueStates` map
 * instead of a per-issue `gh issue view` storm. A map miss (issue beyond the
 * --limit window / just-created / transient list failure) falls back to the
 * live `ghx.issueMeta` so closedAt-grace classification stays exact. */
async function resolveBranchIssueCache(
  ghCtx: GhContext,
  options: BootOptions,
  states: Map<number, IssueStateRow>,
): Promise<Map<number, IssueMeta | null | undefined>> {
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
  const cache = new Map<number, IssueMeta | null | undefined>();
  for (const n of issues) {
    const row = states.get(n);
    if (row) cache.set(n, { state: row.state, closedAt: row.closedAt });
    else cache.set(n, await issueMeta(ghCtx, n));
  }
  return cache;
}

/**
 * Build the real {@link BootDeps} for a full boot run — the fs/gh/git side
 * effects + per-issue lookups every sweep composes. ONE batched
 * `listIssueStates` fetch backs every per-issue boot lookup (orphan state,
 * branch state, blocker state); a map miss falls back to a live read so the
 * classification stays exact. Used by a solo `run` (sweeps run) and by the fleet
 * supervisor's pre-spawn boot (#623).
 */
export async function buildBootDeps(ctx: RepoContext, options: BootOptions, nowS: number): Promise<BootDeps> {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const paths = afkPaths(ctx.root);
  const cfg = loadConfig(paths.configPath, { warn: () => undefined });
  const countCachePath = statuslineCountCachePath(ctx.root);
  // ONE batched issue-state fetch backs every per-issue boot lookup below.
  const issueStates = await ghx.listIssueStates(ghCtx);
  const branchCache = await resolveBranchIssueCache(ghCtx, options, issueStates);
  const liveBranchCommitByIssue = new Map<number, number>();
  for (const ref of options.branches.remoteLiveRefs) {
    const issue = liveIssueFromBranch(ref.branch);
    if (issue === null || !Number.isFinite(ref.commitS)) continue;
    const previous = liveBranchCommitByIssue.get(issue);
    if (previous === undefined || ref.commitS! > previous) liveBranchCommitByIssue.set(issue, ref.commitS!);
  }
  return {
    fs: {
      ensureDir: fsx.ensureDir,
      ensureGitignoreLine: fsx.ensureGitignoreLine,
      writeWorkerPid: fsx.writeWorkerPid,
      removeDir: fsx.removeDir,
    },
    gh: {
      editLabels: async (issue, remove, add) => {
        await editLabelsWithStatuslineCache(
          countCachePath,
          () => ghx.editLabels(ghCtx, issue, remove, add),
          remove,
          add,
        );
      },
      comment: (issue, body) => ghx.comment(ghCtx, issue, body),
      viewLabels: (issue) => ghx.viewLabels(ghCtx, issue),
      issueReference: (issue) => ghx.issueReference(ghCtx, issue),
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
      // Cross-host stale-claim sweep input (#627): every OPEN issue projected as
      // `running` (a held claim) with its parsed claim marker records. Derived
      // from the batched issue-state map; the claim comments are read per-issue.
      // A per-issue read failure drops that issue from the sweep (best-effort).
      claimedIssues: async () => {
        const claimed = [];
        const hostPrefix = hostFingerprintPrefix();
        for (const [issue, row] of issueStates) {
          if (row.state !== "OPEN") continue;
          if (!row.labels.includes(LABEL_RUNNING)) continue;
          try {
            const comments = await ghx.listClaimComments(ghCtx, issue);
            const records = parseClaimRecords(comments);
            const deadOwners = records
              .map((r) => r.worker)
              .filter((worker, idx, workers) => workers.indexOf(worker) === idx)
              .filter((worker) => {
                if (!worker.startsWith(hostPrefix)) return false;
                const workerId = worker.slice(hostPrefix.length);
                if (!workerId) return false;
                const pidPath = join(paths.workersRoot, workerId, "worker.pid");
                if (!existsSync(pidPath)) return true;
                const pid = Number(readFileSync(pidPath, "utf8").trim());
                return !Number.isInteger(pid) || !isLivePid(pid);
              });
            claimed.push({
              issue,
              records,
              deadOwners,
              attemptBranchCommitS: liveBranchCommitByIssue.get(issue),
            });
          } catch {
            // best-effort: skip an issue whose claim comments cannot be read.
          }
        }
        return claimed;
      },
    },
    nowS,
    config: cfg,
  };
}

/**
 * Build a MINIMAL {@link BootDeps} for a supervised worker whose boot skips
 * every shared sweep (#623, `RED_AFK_SWEEPS_DONE`). `runBoot` with
 * `skipSweeps:true` touches only `deps.fs` (the bootstrap mkdir / gitignore /
 * worker.pid writes) and `deps.nowS` before returning, so the gh/git/lookup
 * closures are never reached — they are present only to satisfy the type and
 * throw if ever called, which would surface a regression that let a skip-boot
 * fall through into a sweep. This deliberately AVOIDS the batched
 * `listIssueStates` + branch-cache resolution {@link buildBootDeps} pays, which
 * is the whole point: a respawned worker's boot must be cheap.
 */
export function buildMinimalBootDeps(ctx: RepoContext, nowS: number): BootDeps {
  const unreachable = (): never => {
    throw new Error("buildMinimalBootDeps: sweep IO invoked on a skip-sweeps boot (#623)");
  };
  return {
    fs: {
      ensureDir: fsx.ensureDir,
      ensureGitignoreLine: fsx.ensureGitignoreLine,
      writeWorkerPid: fsx.writeWorkerPid,
      removeDir: fsx.removeDir,
    },
    gh: {
      editLabels: async () => unreachable(),
      comment: async () => unreachable(),
      viewLabels: async () => unreachable(),
    },
    git: {
      deleteRemoteBranch: async () => unreachable(),
      deleteLocalBranch: async () => unreachable(),
    },
    lookups: {
      orphanState: async () => unreachable(),
      branchIssue: () => unreachable(),
      blockerState: async () => unreachable(),
      straggler: {
        unlabeled: async () => unreachable(),
        needsTriage: async () => unreachable(),
        needsInfo: async () => unreachable(),
      },
    },
    nowS,
  };
}
