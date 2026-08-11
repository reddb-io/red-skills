import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getConfig, resolveTier } from "../../core/config.js";
import type { SandboxMode } from "../../core/execution.js";
import type { AgentEffort, RunAgentInput, RunAgentResult } from "../../core/execution.js";
import { parseMaxIterations } from "../../core/execution.js";
import { resolveLaneIdleStallConfig, type LaneIdleStallConfig } from "../../core/lane-idle-reaper.js";
import { resolveSandboxImageName } from "../../core/execution/sandbox-image.js";
import { inspectProcessTreeNative } from "../proc-tree.js";
import { readWorkerState } from "../../core/worker-state-reader.js";
import { workerStatePath } from "../../core/state.js";
import {
  evaluateLiveness,
  resolveLivenessCrossCheckArming,
  createProcessDescendantProbe,
  parseLivenessRecords,
  LIVENESS_LANE_FILENAME,
  type LivenessVerdict,
} from "@reddb-io/red-castle";
import { isRunner, type Runner } from "../../types/runner.js";
import * as gitx from "../git.js";
import { afkPaths } from "./paths.js";
import { runWithQuiescentWorkerLogTrim } from "../worker-log-retention.js";

export interface RunSettings {
  sandbox: SandboxMode;
  /**
   * Container image the docker/podman sandbox runs (issue #2340). Resolved with
   * precedence RED_AFK_SANDBOX_IMAGE env > `afk.sandbox_image` config >
   * `sandcastle:<repo-dir>`. Always repo-root-derived, never derived from the
   * per-attempt worktree — that produced an unbuildable `sandcastle:<issue>`
   * tag and crashed every forced-isolation attempt.
   */
  sandboxImage: string;
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
   * Solo-path lane-idle stall reaper config (issue #363), resolved + validated
   * at boot via resolveLaneIdleStallConfig (RED_AFK_STALL_THRESHOLD_S /
   * RED_AFK_STALL_KILL_THRESHOLD_S / RED_AFK_STALL_POLL_S, fleet defaults
   * 600 / 1800 / 30). A kill ≤ soft threshold THROWS here, so a misconfigured
   * solo run fails fast at boot — the same invariant the supervisor enforces.
   * Complementary to the fixed progress guard: this cuts an idle hang at the
   * stall threshold; the progress guard caps the whole attempt on no-commit.
   */
  laneIdle: LaneIdleStallConfig;
}

const SANDBOX_MODES: readonly SandboxMode[] = ["none", "docker", "podman"];

/** Parse a positive number (int or float) for a budget ceiling; undefined when
 * unset / non-numeric / non-positive, so a typo can never silently set a 0 cap
 * that aborts every attempt instantly. */
export function parsePositive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function resolveRunSettings(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  runner?: Runner,
): RunSettings {
  const paths = afkPaths(root);
  const cfg = loadConfig(paths.configPath);
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
  // Stable container image (#2340). Same precedence shape as the sandbox knob,
  // resolved off `root` — the repo checkout — so every worker/issue/attempt asks
  // for the SAME tag and an operator can build it once.
  const sandboxImage = resolveSandboxImageName({
    repoRoot: root,
    configured: getConfig(cfg, "afk.sandbox_image"),
    envOverride: env.RED_AFK_SANDBOX_IMAGE,
  });
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
  // Solo lane-idle reaper thresholds (issue #363), env-driven with fleet
  // defaults and the same boot invariant (kill > soft) — throws here on a `<=`
  // config so the run fails fast before claiming an issue.
  const laneIdle = resolveLaneIdleStallConfig(env);
  return {
    sandbox,
    sandboxImage,
    defaultRunner,
    model: tier.model,
    effort: tier.effort,
    maxIterations,
    laneIdle,
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
 * flow refreshes — never afk.log / agent.log.toonl / the heartbeat (#243).
 */
export function agentLivenessVerdictSync(
  attemptDir: string,
  laneIdleMs: number,
  laneHardIdleMs?: number,
  issueWallClockMaxMs?: number,
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
  // Claim epoch for the wall-clock ceiling (#2286). An absent/unparseable stamp
  // leaves it undefined, which disables the ceiling rather than guessing an age.
  let issueClaimedAtMs: number | undefined;
  try {
    const rec = readWorkerState(workerStatePath(attemptDir));
    const raw = rec === null ? "" : rec.state.current.started_at || rec.state.started_at;
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isNaN(parsed)) issueClaimedAtMs = parsed;
  } catch {
    // best-effort
  }
  try {
    return evaluateLiveness({ laneRecencyMs, now: Date.now(), laneIdleMs, laneHardIdleMs, issueClaimedAtMs, issueWallClockMaxMs, crossCheckArmed, hasLiveDescendants });
  } catch {
    return null;
  }
}

// ---------- attempt probe arming policy (pure) ----------

/** What an attempt run arms, decided from sandbox mode + available signals. */
export interface AttemptProbeArming {
  /**
   * Wire the worker-branch head probe that stamps each vitals heartbeat. True
   * for EVERY sandbox mode once a worker branch exists (issue #405): under
   * docker/podman sandcastle's bind-mount providers host-create the worktree and
   * bind-mount it + the shared `.git` into the container, so the worker branch's
   * commits are host-visible mid-run. (The attempt-progress guard this flag once
   * armed is gone — ADR 0103.)
   */
  headProbeArmed: boolean;
  /**
   * Arm the lane-idle stall reaper (issue #363). NO-SANDBOX only: its
   * busy-predicate inspects the HOST process tree, which cannot see the inner
   * agent inside a container — under docker/podman it would read every container
   * as "not busy" and could reap a genuinely-busy worker.
   */
  laneArmed: boolean;
}

/**
 * Decide what an attempt run arms, given the resolved sandbox mode and the
 * presence of a worker branch / attempt dir. Pure so the isolated-mode arming
 * decision is unit-testable without sandcastle or git.
 */
export function resolveAttemptProbeArming(opts: {
  sandbox: SandboxMode;
  branch: string | undefined;
  attemptDir: string | undefined;
}): AttemptProbeArming {
  const headProbeArmed = !!opts.branch;
  const laneArmed = opts.sandbox === "none" && headProbeArmed && !!opts.attemptDir;
  return { headProbeArmed, laneArmed };
}

export async function resolveAttemptHead(ctx: gitx.GitContext, branch: string): Promise<string | undefined> {
  const worktree = await gitx.worktreePathForBranch(ctx, branch);
  if (worktree) {
    const head = await gitx.headSha({ ...ctx, cwd: worktree });
    if (head) return head;
  }
  return gitx.branchHead(ctx, branch);
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
  laneIdle?: LaneIdleStallConfig,
  sandboxImage?: string,
): (input: RunAgentInput) => Promise<RunAgentResult> {
  let depsPromise: Promise<import("../../core/execution.js").SandcastleDeps> | null = null;
  return async (input: RunAgentInput): Promise<RunAgentResult> => {
    const { runAgent, defaultSandcastleDeps, parseIdleTimeout } = await import("../../core/execution.js");
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
    // Worker-branch head probe for the vitals heartbeat. Wired for EVERY sandbox
    // mode (issue #405): under docker/podman sandcastle's bind-mount providers
    // host-create the worktree and bind-mount it + the shared `.git` into the
    // container, and #405 additionally bind-mounts the attempt dir
    // (buildRunOptions), so `branchHead` sees HEAD advance under isolation. The
    // lane-idle reaper stays no-sandbox only (its host process-tree
    // busy-predicate is blind to a containerized agent);
    // resolveAttemptProbeArming decouples the two.
    // Resolved lane-idle config is threaded from resolveRunSettings (validated at
    // boot); a caller that constructed makeRunAgent without one falls back to the
    // env-resolved config.
    const laneIdleCfg = laneIdle ?? resolveLaneIdleStallConfig(env);
    const laneAttemptDir = input.cwd;
    const { headProbeArmed, laneArmed } = resolveAttemptProbeArming({
      sandbox: effectiveSandbox,
      branch: input.branch,
      attemptDir: laneAttemptDir,
    });
    return runWithQuiescentWorkerLogTrim(input.logPath, () => runAgent(deps, {
      ...input,
      sandboxMode: effectiveSandbox,
      // Stable container image (#2340). Per-call input wins (the untrusted-author
      // policy resolves its own), else the boot-resolved repo-level tag.
      ...(input.sandboxImage ?? sandboxImage ? { sandboxImage: input.sandboxImage ?? sandboxImage } : {}),
      maxIterations: input.maxIterations ?? maxIterations ?? parseMaxIterations(env.RED_AFK_MAX_ITERATIONS),
      idleTimeoutSeconds: input.idleTimeoutSeconds ?? envIdleTimeout,
      ...(headProbeArmed
        ? { headProbe: () => resolveAttemptHead({ cwd: input.cwd ?? process.cwd() }, input.branch) }
        : {}),
      ...(laneArmed && laneAttemptDir
        ? {
            laneIdleThresholdSeconds: laneIdleCfg.stallThresholdS,
            laneIdleKillThresholdSeconds: laneIdleCfg.stallKillThresholdS,
            laneIdlePollSeconds: laneIdleCfg.stallPollS,
            // Clean liveness signal: the evaluator over the attempt's
            // liveness.lane.jsonl — the un-poisonable lane (#1022, ADR 0083 §3).
            livenessVerdictProbe: () =>
              agentLivenessVerdictSync(
                laneAttemptDir,
                laneIdleCfg.stallThresholdS * 1000,
                laneIdleCfg.stallKillThresholdS * 1000,
                laneIdleCfg.issueWallClockMaxS * 1000,
              ),
            // Inner-agent tree is a descendant of this worker process; the native
            // inspector is safe-by-default (a failed ps reports busy, never reaps).
            inspectTree: () => inspectProcessTreeNative(process.pid),
          }
        : {}),
    }));
  };
}
