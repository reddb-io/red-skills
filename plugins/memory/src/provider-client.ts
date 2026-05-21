import type { MemoryStore } from "./graph-store.js";
import type { ProviderClient, ProviderRequest, ResolvedProvider } from "./extract-conversation.js";

/**
 * Production `ProviderClient` — routes a completion through RedDB's engine-side
 * AI provider via `ASK`. The engine resolves which provider/model actually runs
 * (`openai-compat`, `openai-native`, `anthropic-native`) from its own config;
 * `resolveProvider` has already classified egress and any local endpoint, which
 * `applyProviderEnv` exports for the engine to pick up before the store opens.
 *
 * Tests never construct this — they inject a deterministic stub behind the same
 * `ProviderClient` interface (issue #69: "provider client mocked
 * deterministically"). This client only runs against a live engine with a
 * provider configured; without one, `ASK` degrades and extraction yields no
 * facts, exactly like the rest of the LLM surface (see `engine.ask`).
 */
export function redDbProviderClient(store: MemoryStore): ProviderClient {
  return {
    async complete(req: ProviderRequest): Promise<string> {
      // The engine-side provider has no separate "system" channel over `ASK`;
      // fold both turns into one prompt. The transcript already lives in the
      // user turn, so the model has everything it needs inline.
      const prompt = `${req.system}\n\n${req.user}`;
      const { answer } = await store.ask(prompt);
      return answer;
    },
  };
}

/**
 * Export the resolved provider's endpoint/key into the environment the embedded
 * `red` engine inherits when the SDK spawns it. The engine reads provider config
 * from its own environment; setting these before `MemoryStore.open` is how a
 * config-selected mode (local Ollama vs. a native provider) reaches the engine.
 *
 * Best-effort and idempotent: it only sets what the resolved config provides and
 * never overwrites a value the caller already exported. A `local` endpoint keeps
 * inference on the machine — nothing here points the engine at an external host.
 */
export function applyProviderEnv(resolved: ResolvedProvider, apiKeyEnv?: string): void {
  if (resolved.endpoint && !process.env.RED_AI_BASE_URL) {
    process.env.RED_AI_BASE_URL = resolved.endpoint;
  }
  if (!process.env.RED_AI_MODEL) process.env.RED_AI_MODEL = resolved.model;
  if (!process.env.RED_AI_PROVIDER) process.env.RED_AI_PROVIDER = resolved.mode;
  // The API key stays in the user-named env var; surface it under the engine's
  // expected name only if that var is actually set and the engine's is not.
  if (apiKeyEnv && process.env[apiKeyEnv] && !process.env.RED_AI_API_KEY) {
    process.env.RED_AI_API_KEY = process.env[apiKeyEnv];
  }
}
