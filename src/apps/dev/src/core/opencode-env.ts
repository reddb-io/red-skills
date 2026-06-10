/**
 * opencode-env.ts — Env-precedence resolver for the OpenCode runner's auth key.
 *
 * OpenCode is endpoint-agnostic: it knows how to talk to OpenAI, OpenRouter,
 * MiniMax, and any other OpenAI-compatible endpoint, dispatching on the leading
 * segment of the `<provider>/<model>` slug it is given. AFK's job is to surface
 * the right API key in the agent's environment; OpenCode does the rest.
 *
 * Precedence (first match wins — see ADR 0059 amendment):
 *
 *   1. `OPENAI_API_KEY`     — talk to OpenAI directly
 *   2. `MINIMAX_API_KEY`    — talk to the MiniMax subscription endpoint
 *   3. `OPENROUTER_API_KEY` — talk to OpenRouter (relay to any vendor)
 *
 * Rationale: OpenAI wins because it is the most direct / lowest-friction
 * default for a public OpenAI-compatible endpoint; MiniMax wins over OpenRouter
 * because a subscription API key is preferable to a paid relay when the user
 * already has one. Set exactly one of these env vars in the worker process and
 * the corresponding `<provider>/...>` slug in the resolved tier model — OpenCode
 * routes the rest. A user with no key set is a fail-closed no-op: the agent is
 * spawned without an `env` auth block, OpenCode surfaces its own auth error, and
 * the run routes through the normal failure path.
 */

export const OPENCODE_AUTH_ENV_PRECEDENCE = ["OPENAI_API_KEY", "MINIMAX_API_KEY", "OPENROUTER_API_KEY"] as const;

export type OpenCodeAuthEnvName = (typeof OPENCODE_AUTH_ENV_PRECEDENCE)[number];

export interface OpenCodeAuth {
  envVar: OpenCodeAuthEnvName;
  keyValue: string;
}

/**
 * Inspect `env` and return the first set auth env-var (name + value), or
 * `undefined` when none of the precedence entries is set. Pure: the env is
 * injected so tests can exercise every branch without mutating `process.env`.
 *
 * An env-var counts as "set" when its value is a non-empty string. A value of
 * `""` is treated as unset — operators sometimes export an empty placeholder in
 * shared shell rc files, and we never want a leading-segment slug like
 * `openrouter/` to dispatch to OpenRouter with no actual key.
 */
export function resolveOpenCodeAuth(env: NodeJS.ProcessEnv): OpenCodeAuth | undefined {
  for (const name of OPENCODE_AUTH_ENV_PRECEDENCE) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return { envVar: name, keyValue: value };
    }
  }
  return undefined;
}

/**
 * Build the `OpenCodeOptions.env` payload — `{ [envVar]: keyValue }` when an
 * auth is resolved, or `undefined` when no env-var is set (OpenCode falls back
 * to its own default auth lookup, which will surface a clear error if no key is
 * available through any other channel). Pure.
 */
export function openCodeAuthEnv(auth: OpenCodeAuth | undefined): Record<string, string> | undefined {
  return auth ? { [auth.envVar]: auth.keyValue } : undefined;
}
