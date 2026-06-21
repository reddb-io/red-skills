/**
 * minimax-env.ts — Pure auth-env resolver for the `claude-minimax` runner.
 *
 * The `claude-minimax` lane (PRD #788) reuses the unchanged `claude-code`
 * red-castle provider but points it at MiniMax's Anthropic-compatible endpoint
 * instead of real Anthropic. The Claude Code CLI dispatches to whatever
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` it finds in its own environment, so
 * AFK's whole job here is to surface the MiniMax subscription key under those
 * two Anthropic var names in the INNER agent's spawn env — never the
 * orchestrator's own env, which keeps its real-Anthropic auth.
 *
 * Mirrors `opencode-env.ts`: a single pure function reads the key off an
 * injected `env` (so tests exercise every branch without touching
 * `process.env`) and returns the inner-spawn env block, or `undefined` when the
 * key is absent (the lane is then unusable — the provider spawns without an auth
 * block and Claude Code surfaces its own auth error through the normal failure
 * path).
 */

/** The env-var carrying the MiniMax subscription key. */
export const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";

/**
 * MiniMax's Anthropic-compatible endpoint. Hardcoded for the spike (PRD #788);
 * a later slice can make it configurable. The Claude Code CLI talks the
 * Anthropic Messages protocol against this base when `ANTHROPIC_BASE_URL` points
 * here.
 */
export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";

/** The model id the `claude-minimax` lane forces, regardless of resolved tier. */
export const MINIMAX_M3_MODEL = "MiniMax-M3";

/**
 * Forces the Claude Code CLI down its API-key auth path instead of resolving a
 * host OAuth/keychain session. Without it, a host already logged into a real
 * Claude account would send that OAuth token to the MiniMax base URL — which
 * MiniMax rejects (401), or worse, silently routes the inner agent to real
 * Anthropic. `CLAUDE_CODE_SIMPLE=1` makes the injected `ANTHROPIC_API_KEY` the
 * sole credential, so the lane is deterministic regardless of host login state.
 */
export const CLAUDE_CODE_SIMPLE_ENV = "1";

/**
 * The inner-spawn env block delivered to the claude-code provider: the MiniMax
 * key under Anthropic's `ANTHROPIC_API_KEY`, the hardcoded MiniMax
 * `ANTHROPIC_BASE_URL`, and `CLAUDE_CODE_SIMPLE=1` to pin the API-key auth path.
 */
export type MiniMaxClaudeEnv = {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  CLAUDE_CODE_SIMPLE: string;
};

/**
 * Map `MINIMAX_API_KEY` → `{ ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
 * CLAUDE_CODE_SIMPLE }` for the inner claude-code spawn, or `undefined` when no
 * key is set (lane unusable). Pure — the env is injected. An empty-string value
 * counts as unset (operators sometimes export an empty placeholder in shared rc
 * files; we never want to spawn against MiniMax with no real key).
 */
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
