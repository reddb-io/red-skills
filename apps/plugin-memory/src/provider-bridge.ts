import type { MemoryStore } from "./graph-store.js";
import {
  type AiProviderConfig,
  type ProviderMode,
  type ResolvedProvider,
  resolveProvider,
} from "./extract-conversation.js";

/**
 * Thin bridge module that routes every LLM call the memory plugin needs —
 * chat completion (extraction, `memory ask`) and text embeddings (vector
 * indexing, recall) — through RedDB's engine-side `red.config.ai.provider`
 * layer. RedDB already normalizes the provider families
 * (`openai-native`, `anthropic-native`, `openai-compat`, `bedrock`) behind a
 * single `ASK`/SQL surface, so the plugin never imports an LLM SDK directly.
 *
 * Configuration mirrors RedDB itself:
 *   - the provider config object (mirroring the engine's `red.config.ai`)
 *   - the `REDDB_AI_PROVIDER_MODE` env var as a runtime override (matching
 *     the engine's own behaviour — env wins over persisted config)
 *
 * Errors from the upstream provider are surfaced with their original
 * `error.message` (or raw body if the body was not JSON) rather than
 * swallowed; callers decide whether to degrade.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** The slice of `MemoryStore` the bridge touches — easy to fake in tests. */
export interface ProviderBridgeStore {
  ask(question: string): Promise<{ answer: string }>;
  raw: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
}

export interface ProviderBridgeOptions {
  /** Persisted `red.config.ai.provider` shape. Optional — when absent,
   *  the bridge runs in "no-provider" mode and every call throws. */
  config?: AiProviderConfig;
  /** Environment to read overrides from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const PROVIDER_MODES: readonly ProviderMode[] = [
  "openai-compat",
  "openai-native",
  "anthropic-native",
  "bedrock",
];

/** Env var name RedDB itself reads to override the persisted provider mode. */
export const PROVIDER_MODE_ENV = "REDDB_AI_PROVIDER_MODE";

export class ProviderBridge {
  readonly resolved: ResolvedProvider | null;

  constructor(
    private readonly store: ProviderBridgeStore,
    opts: ProviderBridgeOptions = {},
  ) {
    const env = opts.env ?? process.env;
    const config = opts.config ? applyEnvOverride(opts.config, env) : null;
    this.resolved = config ? resolveProvider(config) : null;
  }

  /**
   * Chat completion routed through RedDB's `ASK`. The engine resolves which
   * provider/model handles the call from `red.config.ai`; we just hand it a
   * flattened prompt. Errors retain the upstream provider's message.
   */
  async chat(messages: ChatMessage[]): Promise<string> {
    if (messages.length === 0) {
      throw new Error("ProviderBridge.chat: messages array must not be empty");
    }
    const prompt = formatChatPrompt(messages);
    try {
      const { answer } = await this.store.ask(prompt);
      return answer;
    } catch (err) {
      throw new Error(surfaceUpstreamMessage(err));
    }
  }

  /**
   * Text embedding routed through RedDB's `EMBED` SQL function. The engine
   * picks the embedding provider/model from `red.config.ai`; failures keep
   * the upstream provider's `error.message`.
   */
  async embed(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error("ProviderBridge.embed: text must not be empty");
    }
    let result: { rows: Array<Record<string, unknown>> };
    try {
      result = await this.store.raw.query("SELECT EMBED(?) AS embedding", [text]);
    } catch (err) {
      throw new Error(surfaceUpstreamMessage(err));
    }
    const row = result.rows?.[0];
    const value = row?.embedding;
    const vector = coerceVector(value);
    if (!vector) {
      throw new Error("ProviderBridge.embed: engine returned no embedding vector");
    }
    return vector;
  }
}

function formatChatPrompt(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

function applyEnvOverride(
  config: AiProviderConfig,
  env: NodeJS.ProcessEnv,
): AiProviderConfig {
  const override = env[PROVIDER_MODE_ENV];
  if (!override) return config;
  if (!PROVIDER_MODES.includes(override as ProviderMode)) {
    throw new Error(
      `${PROVIDER_MODE_ENV}=${override} is not a valid provider mode (expected one of ${PROVIDER_MODES.join(", ")})`,
    );
  }
  return { ...config, mode: override as ProviderMode };
}

/**
 * Pull the upstream provider's `error.message` out of whatever the engine
 * surfaced. Engines typically rethrow with a JSON body somewhere in the
 * message (`{"error":{"message":"..."}}` for OpenAI-shaped responses,
 * `{"message":"..."}` for Anthropic-shaped); when no JSON is embedded we
 * return the raw message as-is rather than swallowing it.
 */
export function surfaceUpstreamMessage(err: unknown): string {
  if (err == null) return "unknown provider error";
  const raw = err instanceof Error ? err.message : String(err);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      const message = pickErrorMessage(parsed);
      if (message) return message;
    } catch {
      /* fall through to raw */
    }
  }
  return raw;
}

function pickErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const errField = v.error;
  if (errField && typeof errField === "object") {
    const m = (errField as Record<string, unknown>).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  if (typeof errField === "string" && errField.trim()) return errField;
  if (typeof v.message === "string" && v.message.trim()) return v.message;
  return null;
}

function coerceVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const out: number[] = [];
    for (const n of value) {
      const num = typeof n === "number" ? n : Number(n);
      if (!Number.isFinite(num)) return null;
      out.push(num);
    }
    return out;
  }
  if (value instanceof Float32Array || value instanceof Float64Array) {
    return Array.from(value);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return coerceVector(parsed);
    } catch {
      /* not JSON */
    }
  }
  return null;
}
