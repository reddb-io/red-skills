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
}

export const RUNNER_SPECS: Record<AgentRunner, RunnerSpec> = {
  claude: {
    efforts: CLAUDE_EFFORTS,
    channel: "effort",
    factory: "claudeCode",
    structuredOutput: true,
  },
  codex: {
    efforts: CODEX_EFFORTS,
    channel: "effort",
    factory: "codex",
  },
  opencode: {
    efforts: CLAUDE_EFFORTS,
    channel: "variant",
    factory: "opencode",
    resolveAuthEnv: (env) => openCodeAuthEnv(resolveOpenCodeAuth(env)),
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
