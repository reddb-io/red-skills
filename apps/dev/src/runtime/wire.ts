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
import { dirname, join } from "node:path";
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
import type { BranchRef } from "../core/branch-cleanup.js";
import { isRunner, type Runner } from "../types/runner.js";
import * as ghx from "./gh.js";
import * as gitx from "./git.js";
import * as fsx from "./fs.js";
import { collectLogLineCounts } from "./log-cursor.js";

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
import { readWorkerState, readAllWorkerStates } from "../core/worker-state-reader.js";
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
   * The monitor render shows a stale marker when this exceeds STATUSLINE_CACHE_TTL_S. */
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

/** Read every worker state file + the history ledger into the pure renderer's
 * inputs, plus one `git diff --shortstat` per live worktree for the diff column
 * (small fleet → a handful of cheap git calls, like the statusline does). */
export async function collectMonitorInputs(root = process.cwd()): Promise<MonitorInputs> {
  const paths = afkPaths(root);
  // The ONE owner reads + normalizes + liveness-tags every worker state file
  // (core/worker-state-reader). The single source of liveness truth for all
  // surfaces is WorkerStateRecord.livenessVerdict (evaluator verdict, ADR 0083 §3).
  // Namespace-blind union: aggregate live workers across the fleet, `/go`, and
  // `--scout` lanes so a `/go`/`--scout` worker appears in the monitor/dashboard,
  // tagged distinctly by state.origin. (Not the single-lane paths.workersRoot,
  // which would render only the `.red/tmp/workers` fleet lane.)
  const records = await readAllWorkerStates(paths.tmpDir);
  const logPaths = records.map(({ path, state }) => state.log || join(dirname(path), "afk.log"));
  const logCounts = await collectLogLineCounts(paths.monitorLogCursorPath, logPaths);
  const workers: CompactWorker[] = [];
  for (const { path, state, active, live: pidLive, liveness, livenessVerdict } of records) {
    // Diff volume: committed + uncommitted work for the attempt, measured from
    // the branch's merge-base with origin/main. Prefer the state file's persisted
    // counts; fall back to a live `git diff --shortstat` of the worktree when both
    // are 0 (same logic as collectStatuslineAfk). Always populated — the dashboard
    // renders the +A -R volume unconditionally (idle / zero included) and sums it
    // into the fleet header, so it is never suppressed.
    let added = state.current.loc_added;
    let removed = state.current.loc_removed;
    if (added === 0 && removed === 0) {
      const attemptDir = dirname(path);
      const baseRef = state.current.base ? `origin/${state.current.base}` : "origin/main";
      // Resolve the real worktree path: the state file carries it after the first
      // heartbeat tick. Before that (or for sandcastle where the initial seed is the
      // legacy {attemptDir}/worktree path that never exists), fall back to
      // worktreePathUnder which probes `git worktree list --porcelain` and resolves
      // the sandcastle layout ({attemptDir}/.sandcastle/worktrees/{slug}) even before
      // the heartbeat has had a chance to persist the resolved path.
      const worktreePath =
        state.current.worktree ||
        (await gitx.worktreePathUnder({ cwd: attemptDir }, attemptDir).catch(() => undefined));
      if (worktreePath) {
        const stat = await gitx.diffstatShortstat({ cwd: worktreePath }, baseRef);
        added = stat.added;
        removed = stat.removed;
      }
    }

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

/** The TTL (seconds) of every EXPENSIVE FETCHED statusline number — the
 * GitHub-derived queue/human and open-PR/open-issue counts AND the repo-global
 * local diffstat. 240 s (4 min): the statusline renders on every prompt, so a
 * per-render gh/git round-trip (~5 s under load) would freeze the TUI. A single
 * named constant referenced by both the writer (statusline command) and the
 * readers (monitor path + stale-marker threshold) so the network cost is paid at
 * most once per 4 minutes, never per render (issue #1178). */
export const STATUSLINE_CACHE_TTL_S = 240;

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
 * The `rq` ready-for-agent / `rh` ready-for-human counts are GitHub-derived and
 * cached for {@link STATUSLINE_CACHE_TTL_S} seconds in
 * `.red/tmp/statusline-cache.json`. The cache refreshes on every stale or cold
 * render — awaited with a bounded deadline so a hanging gh CLI cannot block the
 * statusline process indefinitely. The refresh runs even when there are no live
 * workers so the queue/human badges stay current while the fleet is idle.
 */
export async function collectStatuslineAfk(ctx: RepoContext): Promise<AfkInput | null> {
  const paths = afkPaths(ctx.root);
  // Same single owner as the monitor (core/worker-state-reader).
  const nowMs = Date.now();
  // Namespace-blind union across the fleet, `/go`, and `--scout` lanes so the
  // statusline counts a live `/go`/`--scout` worker (rendered per-origin via
  // state.origin), not only the `.red/tmp/workers` fleet lane.
  const records = await readAllWorkerStates(paths.tmpDir, { nowMs });
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

  for (const { state, livenessVerdict, pidIdentityLive, hostPidLive } of records) {
    // Statusline counts workers the evaluator does not consider stalled. A busy
    // worker with live agent descendants shows as "alive" even when the liveness
    // lane is silent (wedged-substrate guard in the evaluator), so a long
    // build/gate wait no longer makes the AFK block vanish. "unknown" (container
    // workers) is treated conservatively as live. Only "stalled" (stale lane AND
    // no live descendants) is excluded.
    if (livenessVerdict.status === "stalled") continue;
    // But the statusline shows ONLY genuinely-live workers (issue #1177). A
    // finished/retained attempt is stamped `pid: 0` and kept for post-mortem;
    // its per-attempt lane can still read fresh during that window, so the
    // "not stalled" gate alone would render it as a phantom live line beside the
    // same worker's live successor attempt. Require the state's OWN pid to be
    // alive (or, for isolation workers, the host-side worker.pid) so a pid-0
    // sibling is always dropped.
    if (!pidIdentityLive && !hostPidLive) continue;

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
    if (a === 0 && r === 0 && state.current.worktree) {
      // Fallback: compute the diffstat from the worktree like statusline.sh.
      const baseRef = state.current.base ? `origin/${state.current.base}` : "origin/main";
      const stat = await gitx.diffstatShortstat({ cwd: state.current.worktree }, baseRef);
      a = stat.added;
      r = stat.removed;
    }
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

  // GitHub-derived counts with a 240 s (4 min) cache — refreshed before the
  // early-return so queue/human stay current even when the fleet is idle
  // (workers == 0).
  const cachePath = join(paths.tmpDir, "statusline-cache.json");
  const nowS = Math.floor(Date.now() / 1000);
  const cached = readStatuslineCache(cachePath);
  let queue = cached?.queue ?? 0;
  let human = cached?.human ?? 0;

  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  let refreshSucceeded = false;
  const refresh = async (): Promise<void> => {
    const [q, h] = await Promise.all([
      ghx.countReadyForAgent(ghCtx),
      ghx.countReadyForHuman(ghCtx),
    ]);
    queue = q;
    human = h;
    refreshSucceeded = true;
    writeStatuslineCacheAtomic(cachePath, { queue: q, human: h, ts: nowS });
  };

  let cacheAgeS: number | undefined;
  if (!cached) {
    // Cold cache: refresh with a bounded deadline so a hanging gh CLI cannot
    // block the statusline render indefinitely. queue/human stay 0/0 on timeout
    // or on any gh/auth/network error.
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
  } else if (nowS - cached.ts >= STATUSLINE_CACHE_TTL_S) {
    // Stale: await a bounded refresh so the cache is rewritten before the
    // process exits. Shows the previous value on timeout (fail-open). When
    // refresh fails, mark the age so the renderer can signal staleness.
    const staleAgeS = nowS - cached.ts;
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
    if (!refreshSucceeded) cacheAgeS = staleAgeS;
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
  const records = await readAllWorkerStates(paths.tmpDir, { nowMs });
  const workers: CompactWorker[] = [];
  for (const { state, active, live: pidLive, liveness, livenessVerdict, pidIdentityLive, hostPidLive } of records) {
    // Same rule as the aggregate collector: count everything the evaluator does
    // not consider stalled (a long build/gate wait stays "alive"; "unknown"
    // container workers count conservatively). Only "stalled" is excluded.
    if (livenessVerdict.status === "stalled") continue;
    // Statusline shows ONLY genuinely-live workers (issue #1177): a
    // finished/retained attempt keeps its dir with `pid: 0` and a possibly-fresh
    // lane during the post-mortem window, so require its OWN pid to be alive (or
    // the isolation host pid) — a pid-0 sibling of a live successor is dropped.
    if (!pidIdentityLive && !hostPidLive) continue;
    let added = state.current.loc_added;
    let removed = state.current.loc_removed;
    if (added === 0 && removed === 0 && state.current.worktree) {
      const baseRef = state.current.base ? `origin/${state.current.base}` : "origin/main";
      const stat = await gitx.diffstatShortstat({ cwd: state.current.worktree }, baseRef);
      added = stat.added;
      removed = stat.removed;
    }
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
export async function collectStatuslineRepo(ctx: RepoContext): Promise<RepoInput> {
  const paths = afkPaths(ctx.root);
  const cachePath = join(paths.tmpDir, "statusline-repo-cache.json");
  const nowS = Math.floor(Date.now() / 1000);
  const cached = readRepoStatsCache(cachePath);
  let openPrs = cached?.openPrs ?? 0;
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
    const [p, i, diff] = await Promise.all([
      ghx.countOpenPrs(ghCtx),
      ghx.countOpenIssues(ghCtx),
      gitx.diffstatShortstat({ cwd: ctx.root }, "origin/main"),
    ]);
    openPrs = p;
    openIssues = i;
    localAdded = diff.added;
    localRemoved = diff.removed;
    repoRefreshSucceeded = true;
    writeRepoStatsCacheAtomic(cachePath, {
      openPrs: p,
      openIssues: i,
      localAdded: diff.added,
      localRemoved: diff.removed,
      ts: nowS,
    });
  };
  let repoCacheAgeS: number | undefined;
  if (!cached) {
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
  } else if (nowS - cached.ts >= STATUSLINE_CACHE_TTL_S) {
    // Stale: await a bounded refresh so the cache is rewritten before the
    // process exits. Shows the previous value on timeout (fail-open). When
    // refresh fails, mark the age so the renderer can signal staleness.
    const staleAgeS = nowS - cached.ts;
    await withTimeout(refresh(), STATUSLINE_GH_COLD_TIMEOUT_MS, undefined).catch(() => undefined);
    if (!repoRefreshSucceeded) repoCacheAgeS = staleAgeS;
  }

  return { openPrs, openIssues, localAdded, localRemoved, cacheAgeS: repoCacheAgeS };
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
import { LABEL_HUMAN, LABEL_RUNNING } from "../core/triage-labels.js";
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
      viewLabels: (issue) => ghx.viewLabels(ghCtx, issue),
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
        for (const [issue, row] of issueStates) {
          if (row.state !== "OPEN") continue;
          if (!row.labels.includes(LABEL_RUNNING)) continue;
          try {
            const comments = await ghx.listClaimComments(ghCtx, issue);
            claimed.push({ issue, records: parseClaimRecords(comments) });
          } catch {
            // best-effort: skip an issue whose claim comments cannot be read.
          }
        }
        return claimed;
      },
    },
    nowS,
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
