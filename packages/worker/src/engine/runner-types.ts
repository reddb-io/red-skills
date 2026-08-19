export const runners = ["claude", "codex", "hermes", "opencode", "claude-minimax"] as const;
export type Runner = (typeof runners)[number];

export type AgentRunner = "claude" | "codex" | "opencode" | "claude-minimax";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type RunnerDetectionMethod =
  | "flag"
  | "env-var"
  | "process"
  | "path"
  | "env-fallback";

export interface RunnerDetection {
  runner: Runner;
  method: RunnerDetectionMethod;
  detail?: string;
}

export function isRunner(value: string): value is Runner {
  return (runners as readonly string[]).includes(value);
}
