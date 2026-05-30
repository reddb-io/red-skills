import type { Runner } from "../types/runner.js";

/**
 * Capability axes probed once per iteration for the active runner.
 *
 * Mirrors `scripts/lib/capabilities.sh` (issue #202). Every axis is a boolean
 * decision; the bash lib emits `KEY=value` lines with `1`/`0`, this port keeps
 * the same axis names with native booleans.
 *
 *   nativeAgents      runner exposes first-class sub-agent dispatch AND the
 *                     production phase agents are shipped on disk
 *                     (issue-analyzer / task-executor / quality-gate).
 *   structuredOutput  runner streams structured events (claude stream-json,
 *                     codex --json JSONL).
 *   resumeSession     runner has a documented session resume / replay API.
 *   worktreeSupport   git worktree available on the host.
 *   hooksEvents       runner has a hook surface RedSkills can write to.
 *   permissionModes   runner exposes a safe-permission flag.
 *   phasedMode        codex inline-phase prompts (analyze / verify / finalize)
 *                     are shipped on disk.
 */
export interface Capabilities {
  nativeAgents: boolean;
  structuredOutput: boolean;
  resumeSession: boolean;
  worktreeSupport: boolean;
  hooksEvents: boolean;
  permissionModes: boolean;
  phasedMode: boolean;
}

/**
 * On-disk artefact probes. Thin injectable functions keep the decision logic
 * pure: production wiring checks the real filesystem, tests pass deterministic
 * stubs.
 */
export interface CapabilityProbes {
  /** True when all three claude production sub-agent files exist. */
  nativeAgentsPresent: () => boolean;
  /** True when all three codex inline-phase prompt files exist. */
  codexPhasesPresent: () => boolean;
  /** True when git worktree is available on the host. */
  worktreeAvailable: () => boolean;
}

export type RunMode =
  | "claude-native"
  | "claude-basic"
  | "codex-phased"
  | "codex-basic"
  | "hermes-fallback";

export type RunModeOverride = "native" | "basic" | "phased" | "fallback" | "auto";

export interface DetectCapabilitiesInput {
  runner: Runner | string;
  probes: CapabilityProbes;
  /**
   * Operator opt-in for a custom runner that mimics codex JSON
   * (RED_AFK_RUNNER_HAS_JSON=1). Only consulted for unknown runners.
   */
  runnerHasJson?: boolean;
}

/**
 * Probe the runner against the fixed capability axes. Pure: every disk/host
 * decision comes from the injected probes. Mirrors `capabilities_detect`.
 */
export function detectCapabilities(input: DetectCapabilitiesInput): Capabilities {
  const { runner, probes } = input;
  const worktreeSupport = probes.worktreeAvailable();

  switch (runner) {
    case "claude":
      return {
        nativeAgents: probes.nativeAgentsPresent(),
        structuredOutput: true,
        resumeSession: true,
        worktreeSupport,
        hooksEvents: true,
        permissionModes: true,
        phasedMode: false,
      };
    case "codex":
      return {
        nativeAgents: false,
        structuredOutput: true,
        // No documented session-resume primitive on Codex today.
        resumeSession: false,
        worktreeSupport,
        hooksEvents: true,
        permissionModes: true,
        phasedMode: probes.codexPhasesPresent(),
      };
    default:
      // Unknown runner — assume nothing. Structured output is the one field we
      // still flip on if the operator explicitly opted in via
      // RED_AFK_RUNNER_HAS_JSON so a custom runner that mimics codex JSON can
      // still be parsed.
      return {
        nativeAgents: false,
        structuredOutput: input.runnerHasJson === true,
        resumeSession: false,
        worktreeSupport,
        hooksEvents: false,
        permissionModes: false,
        phasedMode: false,
      };
  }
}

export interface SelectRunModeInput {
  runner: Runner | string;
  capabilities: Pick<Capabilities, "nativeAgents" | "phasedMode">;
  /** RED_AFK_RUN_MODE operator override; defaults to "auto". */
  override?: RunModeOverride;
}

function autoSelect(
  runner: Runner | string,
  caps: Pick<Capabilities, "nativeAgents" | "phasedMode">,
): RunMode {
  switch (runner) {
    case "claude":
      return caps.nativeAgents ? "claude-native" : "claude-basic";
    case "codex":
      return caps.phasedMode ? "codex-phased" : "codex-basic";
    default:
      return "hermes-fallback";
  }
}

/**
 * Select the run mode given the runner identity, the probed capabilities, and
 * an optional RED_AFK_RUN_MODE override. Pure; mirrors
 * `capabilities_select_mode`.
 *
 * Override precedence (exactly as the bash lib):
 *   - `fallback` → always hermes-fallback.
 *   - `basic`    → force the basic counterpart (claude-basic / codex-basic),
 *                  hermes-fallback for any other runner.
 *   - `native`   → claude-native ONLY when the env can satisfy it; otherwise
 *                  fall through to auto-selection.
 *   - `phased`   → codex-phased ONLY when the env can satisfy it; otherwise
 *                  fall through to auto-selection.
 *   - `auto` / unset → auto-select the best path the environment satisfies.
 *
 * Degradation is always safe: native/phased silently fall back to their basic
 * counterpart when the artefacts are missing.
 */
export function selectRunMode(input: SelectRunModeInput): RunMode {
  const { runner, capabilities } = input;
  const override = input.override ?? "auto";

  switch (override) {
    case "fallback":
      return "hermes-fallback";
    case "basic":
      if (runner === "claude") return "claude-basic";
      if (runner === "codex") return "codex-basic";
      return "hermes-fallback";
    case "native":
      if (runner === "claude" && capabilities.nativeAgents) return "claude-native";
      break;
    case "phased":
      if (runner === "codex" && capabilities.phasedMode) return "codex-phased";
      break;
    case "auto":
      break;
  }

  return autoSelect(runner, capabilities);
}

/**
 * Render the one-line dispatch summary the orchestrator prints to afk.log.
 * Mirrors `capabilities_dispatch_log`: emits the axes as `KEY=0|1` pairs in the
 * lib's wire order.
 */
export function dispatchLog(
  runner: Runner | string,
  mode: RunMode,
  capabilities: Capabilities,
): string {
  const pairs = [
    `native_agents=${capabilities.nativeAgents ? 1 : 0}`,
    `structured_output=${capabilities.structuredOutput ? 1 : 0}`,
    `resume_session=${capabilities.resumeSession ? 1 : 0}`,
    `worktree_support=${capabilities.worktreeSupport ? 1 : 0}`,
    `hooks_events=${capabilities.hooksEvents ? 1 : 0}`,
    `permission_modes=${capabilities.permissionModes ? 1 : 0}`,
    `phased_mode=${capabilities.phasedMode ? 1 : 0}`,
  ];
  return `dispatch: runner=${runner} mode=${mode} ${pairs.join(" ")}`;
}
