import type { AgentEffort, AgentRunner, Runner } from "./runner-types.js";
import { MINIMAX_M3_MODEL, resolveMiniMaxClaudeEnv } from "./minimax-env.js";
import { openCodeAuthEnv, resolveOpenCodeAuth } from "./opencode-env.js";

export const CODEX_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh"];
export const CLAUDE_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const MINIMAX_EFFORTS: readonly AgentEffort[] = ["low"];

export interface RunnerSpec {
  efforts: readonly AgentEffort[];
  channel: "effort" | "variant";
  factory: "claudeCode" | "codex" | "opencode";
  forcedModel?: string;
  defaultEffort?: AgentEffort;
  resolveAuthEnv?: (env: NodeJS.ProcessEnv) => Record<string, string> | undefined;
  structuredOutput?: boolean;
  /**
   * Model-slug families this runner's CLI can dispatch. A runner with a
   * `forcedModel` accepts that slug only; a runner with no families listed
   * accepts any slug. Consulted by callers that must resolve runner+model as a
   * coherent PAIR before spawning — pinning a codex slug on the claude CLI is
   * not a degraded run, it is an immediate non-zero exit.
   */
  modelFamilies?: readonly RegExp[];
}

export const RUNNER_SPECS: Record<AgentRunner, RunnerSpec> = {
  claude: {
    efforts: CLAUDE_EFFORTS,
    channel: "effort",
    factory: "claudeCode",
    structuredOutput: true,
    // Full ids (`claude-opus-4-8`, `us.anthropic.claude-…`) plus the CLI's own
    // short aliases.
    modelFamilies: [/claude/i, /^(opus|sonnet|haiku|opusplan|default)$/i],
  },
  codex: {
    efforts: CODEX_EFFORTS,
    channel: "effort",
    factory: "codex",
    modelFamilies: [/^gpt-/i, /^o\d/i, /^codex/i],
  },
  opencode: {
    efforts: CLAUDE_EFFORTS,
    channel: "variant",
    factory: "opencode",
    resolveAuthEnv: (env) => openCodeAuthEnv(resolveOpenCodeAuth(env)),
    // `<provider>/<model>` — the leading segment routes the endpoint (ADR 0059).
    modelFamilies: [/^[^/\s]+\/.+$/],
  },
  "claude-minimax": {
    efforts: MINIMAX_EFFORTS,
    channel: "effort",
    factory: "claudeCode",
    forcedModel: MINIMAX_M3_MODEL,
    defaultEffort: "low",
    resolveAuthEnv: resolveMiniMaxClaudeEnv,
  },
};

export function toAgentRunner(r: Runner): AgentRunner {
  return r === "codex" || r === "opencode" || r === "claude-minimax" ? r : "claude";
}

export function runnerSupportsStructuredOutput(runner: AgentRunner): boolean {
  return RUNNER_SPECS[runner].structuredOutput === true;
}

/**
 * Can `runner`'s CLI actually dispatch `model`? A blank slug is never runnable;
 * a `forcedModel` runner accepts only that slug; a runner without declared
 * families accepts anything. This is the registry seam for resolving a
 * runner/model PAIR, so an operator's cross-runner model pin is substituted
 * before spawn instead of exiting non-zero at run time.
 */
export function runnerSupportsModel(runner: AgentRunner, model: string): boolean {
  const spec = RUNNER_SPECS[runner];
  const slug = model.trim();
  if (slug.length === 0) return false;
  if (spec.forcedModel) return slug === spec.forcedModel;
  if (!spec.modelFamilies || spec.modelFamilies.length === 0) return true;
  return spec.modelFamilies.some((family) => family.test(slug));
}
