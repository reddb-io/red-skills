import { resolveProvider, } from "./extract-conversation.js";
const PROVIDER_MODES = [
    "openai-compat",
    "openai-native",
    "anthropic-native",
];
/** Env var name RedDB itself reads to override the persisted provider mode. */
export const PROVIDER_MODE_ENV = "REDDB_AI_PROVIDER_MODE";
export class ProviderBridge {
    store;
    resolved;
    constructor(store, opts = {}) {
        this.store = store;
        const env = opts.env ?? process.env;
        const config = opts.config ? applyEnvOverride(opts.config, env) : null;
        this.resolved = config ? resolveProvider(config) : null;
    }
    /**
     * Chat completion routed through RedDB's `ASK`. The engine resolves which
     * provider/model handles the call from `red.config.ai`; we just hand it a
     * flattened prompt. Errors retain the upstream provider's message.
     */
    async chat(messages) {
        if (messages.length === 0) {
            throw new Error("ProviderBridge.chat: messages array must not be empty");
        }
        const prompt = formatChatPrompt(messages);
        try {
            const { answer } = await this.store.ask(prompt);
            return answer;
        }
        catch (err) {
            throw new Error(surfaceUpstreamMessage(err));
        }
    }
    /**
     * Text embedding routed through RedDB's `EMBED` SQL function. The engine
     * picks the embedding provider/model from `red.config.ai`; failures keep
     * the upstream provider's `error.message`.
     */
    async embed(text) {
        if (!text || !text.trim()) {
            throw new Error("ProviderBridge.embed: text must not be empty");
        }
        let result;
        try {
            result = await this.store.raw.query("SELECT EMBED(?) AS embedding", [text]);
        }
        catch (err) {
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
function formatChatPrompt(messages) {
    return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}
function applyEnvOverride(config, env) {
    const override = env[PROVIDER_MODE_ENV];
    if (!override)
        return config;
    if (!PROVIDER_MODES.includes(override)) {
        throw new Error(`${PROVIDER_MODE_ENV}=${override} is not a valid provider mode (expected one of ${PROVIDER_MODES.join(", ")})`);
    }
    return { ...config, mode: override };
}
/**
 * Pull the upstream provider's `error.message` out of whatever the engine
 * surfaced. Engines typically rethrow with a JSON body somewhere in the
 * message (`{"error":{"message":"..."}}` for OpenAI-shaped responses,
 * `{"message":"..."}` for Anthropic-shaped); when no JSON is embedded we
 * return the raw message as-is rather than swallowing it.
 */
export function surfaceUpstreamMessage(err) {
    if (err == null)
        return "unknown provider error";
    const raw = err instanceof Error ? err.message : String(err);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const message = pickErrorMessage(parsed);
            if (message)
                return message;
        }
        catch {
            /* fall through to raw */
        }
    }
    return raw;
}
function pickErrorMessage(value) {
    if (!value || typeof value !== "object")
        return null;
    const v = value;
    const errField = v.error;
    if (errField && typeof errField === "object") {
        const m = errField.message;
        if (typeof m === "string" && m.trim())
            return m;
    }
    if (typeof errField === "string" && errField.trim())
        return errField;
    if (typeof v.message === "string" && v.message.trim())
        return v.message;
    return null;
}
function coerceVector(value) {
    if (Array.isArray(value)) {
        const out = [];
        for (const n of value) {
            const num = typeof n === "number" ? n : Number(n);
            if (!Number.isFinite(num))
                return null;
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
            if (Array.isArray(parsed))
                return coerceVector(parsed);
        }
        catch {
            /* not JSON */
        }
    }
    return null;
}
