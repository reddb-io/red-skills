import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getConfig, resolveTier } from "../../core/config.js";
import type { SandboxMode } from "../../core/execution.js";
import type { AgentEffort, RunAgentInput, RunAgentResult, AttemptBudgetUsage } from "../../core/execution.js";
import { parseMaxIterations } from "../../core/execution.js";
import { resolveLaneIdleStallConfig, type LaneIdleStallConfig } from "../../core/lane-idle-reaper.js";
import { resolveSandboxImageName } from "../../core/execution/sandbox-image.js";
import { inspectProcessTreeNative } from "../proc-tree.js";
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
  return {
    sandbox,
    sandboxImage,
    defaultRunner,
    model: tier.model,
    effort: tier.effort,
    maxIterations,
    laneIdle,
    feedbackRebaseBase,
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
    return evaluateLiveness({ laneRecencyMs, now: Date.now(), laneIdleMs, laneHardIdleMs, crossCheckArmed, hasLiveDescendants });
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
  budgetUsage?: () => AttemptBudgetUsage,
  sandboxImage?: string,
): (input: RunAgentInput) => Promise<RunAgentResult> {
  let depsPromise: Promise<import("../../core/execution.js").SandcastleDeps> | null = null;
  return async (input: RunAgentInput): Promise<RunAgentResult> => {
    const {
      runAgent,
      defaultSandcastleDeps,
      parseIdleTimeout,
      DEFAULT_ATTEMPT_TIMEOUT_S,
      DEFAULT_ATTEMPT_HARD_CAP_S,
    } = await import("../../core/execution.js");
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
      DEFAULT_ATTEMPT_TIMEOUT_S;
    // Commit-anchored hard cap (issue #637): bounds how long the edit-signal
    // below may keep extending the soft deadline. Never below the soft cap, so
    // a low override cannot make the hard cap fire before plain ADR 0044 would.
    const attemptHardCap = Math.max(
      input.attemptHardCapSeconds ?? DEFAULT_ATTEMPT_HARD_CAP_S,
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
      // Stable container image (#2340). Per-call input wins (the untrusted-author
      // policy resolves its own), else the boot-resolved repo-level tag.
      ...(input.sandboxImage ?? sandboxImage ? { sandboxImage: input.sandboxImage ?? sandboxImage } : {}),
      maxIterations: input.maxIterations ?? maxIterations ?? parseMaxIterations(env.RED_AFK_MAX_ITERATIONS),
      idleTimeoutSeconds: input.idleTimeoutSeconds ?? envIdleTimeout,
      ...(guardArmed
        ? {
            attemptTimeoutSeconds: attemptTimeout,
            attemptHardCapSeconds: attemptHardCap,
            headProbe: () => resolveAttemptHead({ cwd: input.cwd ?? process.cwd() }, input.branch),
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
      // Live activity counters are wired whenever the progress guard is armed so
      // tool/text progress can extend the soft stall deadline.
      ...(guardArmed && budgetUsage ? { budgetUsage } : {}),
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
              ),
            // Inner-agent tree is a descendant of this worker process; the native
            // inspector is safe-by-default (a failed ps reports busy, never reaps).
            inspectTree: () => inspectProcessTreeNative(process.pid),
          }
        : {}),
    });
  };
}
