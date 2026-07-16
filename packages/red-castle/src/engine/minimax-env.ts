export const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_M3_MODEL = "MiniMax-M3";
export const CLAUDE_CODE_SIMPLE_ENV = "1";

export type MiniMaxClaudeEnv = {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  CLAUDE_CODE_SIMPLE: string;
};

export function resolveMiniMaxClaudeEnv(env: NodeJS.ProcessEnv): MiniMaxClaudeEnv | undefined {
  const key = env[MINIMAX_API_KEY_ENV];
  if (typeof key === "string" && key.length > 0) {
    return {
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_BASE_URL: MINIMAX_ANTHROPIC_BASE_URL,
      CLAUDE_CODE_SIMPLE: CLAUDE_CODE_SIMPLE_ENV,
    };
  }
  return undefined;
}
