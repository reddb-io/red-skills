import type { AgentEffort, AgentRunner } from "./execution.js";
import type { Runner } from "../types/runner.js";
import { MINIMAX_M3_MODEL, resolveMiniMaxClaudeEnv } from "./minimax-env.js";
import { openCodeAuthEnv, resolveOpenCodeAuth } from "./opencode-env.js";

/**
 * The reasoning-effort values each provider's option type accepts. codex tops
 * out at "xhigh" (no "max"); claude accepts the full union (see the sandcastle
 * AgentProvider d.ts — CodexOptions.effort vs ClaudeCodeOptions.effort).
 *
 * claude-minimax is a special case: MiniMax-M3 thinking is off by default and
 * only accepts thinking:{type:"adaptive"} — it rejects thinking:{type:"enabled",
 * budget} that Claude Code emits at effort > "low". Only "low" is safe.
 */
export const CODEX_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh"];
export const CLAUDE_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const MINIMAX_EFFORTS: readonly AgentEffort[] = ["low"];

/**
 * The single per-runner provider policy table (issue #823). One {@link RunnerSpec}
 * row per {@link AgentRunner} — "add a runner = one row". `buildAgent` and
 * `effortForProvider` read this table instead of `if (runner === …)` chains, so
 * model/effort/variant/auth resolution lives in exactly one place.
 */
export interface RunnerSpec {
  /** The reasoning-effort values this runner's provider option accepts. */
  efforts: readonly AgentEffort[];
  /**
   * How AFK's effort reaches the provider:
   * - `"effort"` — the numeric `effort` option (claude / codex / claude-minimax),
   *   gated against {@link efforts}.
   * - `"variant"` — OpenCode's free-form reasoning string (opencode), NOT gated:
   *   any AgentEffort maps straight through.
   */
  channel: "effort" | "variant";
  /** Which injected sandcastle factory builds this runner's provider. */
  factory: "claudeCode" | "codex" | "opencode";
  /**
   * When set, the resolved tier model is DISCARDED and this model is forced
   * (claude-minimax → MiniMax-M3).
   */
  forcedModel?: string;
  /**
   * When set, an absent or out-of-range effort falls to this value and is ALWAYS
   * passed explicitly (claude-minimax → "low", so the inner spawn never
   * auto-selects a thinking tier). When unset, a dropped effort degrades to the
   * provider default (no effort option passed at all).
   */
  defaultEffort?: AgentEffort;
  /**
   * Resolve the provider auth env passthrough from the process env, or
   * `undefined` when none applies / none is set. The key rides in on the
   * provider option's `env` seam; the orchestrator's own env is never touched.
   */
  resolveAuthEnv?: (env: NodeJS.ProcessEnv) => Record<string, string> | undefined;
  /**
   * Native structured-output support (ADR 0090, #932). When `true`, this runner
   * emits + validates the red-castle `AgentOutput` schema as its terminal signal:
   * the exit protocol instructs it to emit an `<agent-output>` JSON block, and a
   * `done` outcome is REJECTED (→ `no-sentinel`) unless a valid `AgentOutput` is
   * present. When absent/false, the runner keeps the text sentinel
   * (`<promise>DONE</promise>`) as its sole terminal signal — the coexist
   * fallback for runners without native schema support. Rolled out claude-first;
   * deprecate the sentinel runner-by-runner as each flips this on.
   */
  structuredOutput?: boolean;
}

export const RUNNER_SPECS: Record<AgentRunner, RunnerSpec> = {
  claude: {
    efforts: CLAUDE_EFFORTS,
    channel: "effort",
    factory: "claudeCode",
    // claude-first structured-output rollout (ADR 0090, #932): claude emits +
    // validates the AgentOutput schema natively; the sentinel stays as a coexist
    // fallback for the other runners below until each flips this on.
    structuredOutput: true,
  },
  codex: {
    efforts: CODEX_EFFORTS,
    channel: "effort",
    factory: "codex",
  },
  // opencode (ADR 0059) routes <provider>/<model> slugs itself; AFK's effort is
  // its free-form `variant` (no gating), and the auth key — OPENAI > MINIMAX >
  // OPENROUTER precedence — is delivered through OpenCodeOptions.env.
  opencode: {
    // OpenCode accepts any AgentEffort as a variant — kept here only so the row
    // is complete; gating is bypassed for the variant channel.
    efforts: CLAUDE_EFFORTS,
    channel: "variant",
    factory: "opencode",
    resolveAuthEnv: (env) => openCodeAuthEnv(resolveOpenCodeAuth(env)),
  },
  // claude-minimax (PRD #788 / #794) reuses the unchanged claude-code provider
  // but forces MiniMax-M3, caps effort to "low" (MiniMax-M3 rejects the
  // thinking:{type:"enabled"} that higher tiers emit), and injects the MiniMax
  // Anthropic-compat auth env into the inner spawn only.
  "claude-minimax": {
    efforts: MINIMAX_EFFORTS,
    channel: "effort",
    factory: "claudeCode",
    forcedModel: MINIMAX_M3_MODEL,
    defaultEffort: "low",
    resolveAuthEnv: resolveMiniMaxClaudeEnv,
  },
};

/**
 * Project the orchestrator {@link Runner} (which includes the provider-less
 * `hermes`) onto the provider-backed {@link AgentRunner} set: a runner with its
 * own row in {@link RUNNER_SPECS} passes through, and any provider-less runner
 * collapses to `claude` so the spawn always has a real agent. This is the single
 * source of truth for the coercion `process-issue.ts` and `config.ts` both need.
 */
export function toAgentRunner(r: Runner): AgentRunner {
  return r === "codex" || r === "opencode" || r === "claude-minimax" ? r : "claude";
}

/**
 * True when a runner natively emits + validates the red-castle `AgentOutput`
 * schema as its terminal signal (ADR 0090, #932). The single seam both the exit
 * protocol (emit) and {@link enforceStructuredOutput} (validate) read, so
 * flipping a runner onto the schema is a one-line {@link RUNNER_SPECS} change.
 */
export function runnerSupportsStructuredOutput(runner: AgentRunner): boolean {
  return RUNNER_SPECS[runner].structuredOutput === true;
}
