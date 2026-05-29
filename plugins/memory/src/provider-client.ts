import type { MemoryStore } from "./graph-store.js";
import type {
  AiProviderConfig,
  ProviderClient,
  ProviderRequest,
  ResolvedProvider,
} from "./extract-conversation.js";
import { ProviderBridge } from "./provider-bridge.js";

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
export function redDbProviderClient(
  store: MemoryStore,
  config?: AiProviderConfig,
): ProviderClient {
  const bridge = new ProviderBridge(store, { config });
  return {
    async complete(req: ProviderRequest): Promise<string> {
      // The bridge handles error surfacing and env-override resolution; we
      // flatten the system+user request into a two-turn chat so extraction's
      // existing prompt shape (system pin + transcript-bearing user turn)
      // survives the cutover intact.
      return bridge.chat([
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ]);
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
  // Bedrock signs requests per region; surface it so the engine targets the
  // right `bedrock-runtime` host. Other modes carry no region and skip this.
  if (resolved.region && !process.env.RED_AI_REGION) {
    process.env.RED_AI_REGION = resolved.region;
  }
  // The API key stays in the user-named env var; surface it under the engine's
  // expected name only if that var is actually set and the engine's is not.
  if (apiKeyEnv && process.env[apiKeyEnv] && !process.env.RED_AI_API_KEY) {
    process.env.RED_AI_API_KEY = process.env[apiKeyEnv];
  }
}
