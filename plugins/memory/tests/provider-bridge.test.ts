import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PROVIDER_MODE_ENV,
  ProviderBridge,
  type ChatMessage,
  type ProviderBridgeStore,
  surfaceUpstreamMessage,
} from "../src/provider-bridge.js";
import type { AiProviderConfig, ProviderMode } from "../src/extract-conversation.js";

/**
 * Fake store: records the prompts/queries the bridge issued, returns
 * configurable answers/rows, and can throw on demand to simulate upstream
 * provider failures. Mirrors the slice of `MemoryStore` ProviderBridge uses.
 */
function fakeStore(opts: {
  askAnswer?: string;
  askThrow?: unknown;
  embedRows?: Array<Record<string, unknown>>;
  embedThrow?: unknown;
} = {}): ProviderBridgeStore & {
  askCalls: string[];
  queryCalls: Array<{ sql: string; params?: unknown[] }>;
} {
  const askCalls: string[] = [];
  const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    askCalls,
    queryCalls,
    async ask(question: string) {
      askCalls.push(question);
      if (opts.askThrow !== undefined) throw opts.askThrow;
      return { answer: opts.askAnswer ?? "ok" };
    },
    raw: {
      async query(sql: string, params?: unknown[]) {
        queryCalls.push({ sql, params });
        if (opts.embedThrow !== undefined) throw opts.embedThrow;
        return { rows: opts.embedRows ?? [{ embedding: [0.1, 0.2, 0.3] }] };
      },
    },
  };
}

const OPENAI_COMPAT: AiProviderConfig = {
  mode: "openai-compat",
  model: "llama3.1",
  baseUrl: "http://localhost:11434/v1",
};

const OPENAI_NATIVE: AiProviderConfig = {
  mode: "openai-native",
  model: "gpt-4o-mini",
};

const ANTHROPIC_NATIVE: AiProviderConfig = {
  mode: "anthropic-native",
  model: "claude-3-haiku",
};

const BEDROCK: AiProviderConfig = {
  mode: "bedrock",
  model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  region: "us-east-1",
};

describe("ProviderBridge.chat", () => {
  test("flattens messages into a single ASK prompt and returns the answer", async () => {
    const store = fakeStore({ askAnswer: "hello there" });
    const bridge = new ProviderBridge(store, { config: OPENAI_COMPAT, env: {} });
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ];

    const out = await bridge.chat(messages);

    expect(out).toBe("hello there");
    expect(store.askCalls).toHaveLength(1);
    expect(store.askCalls[0]).toContain("system: be brief");
    expect(store.askCalls[0]).toContain("user: hi");
  });

  test.each<[ProviderMode, AiProviderConfig]>([
    ["openai-compat", OPENAI_COMPAT],
    ["openai-native", OPENAI_NATIVE],
    ["anthropic-native", ANTHROPIC_NATIVE],
    ["bedrock", BEDROCK],
  ])("succeeds in %s mode by delegating to the engine ASK surface", async (_mode, config) => {
    const store = fakeStore({ askAnswer: "answered" });
    const bridge = new ProviderBridge(store, { config, env: {} });

    await expect(bridge.chat([{ role: "user", content: "ping" }])).resolves.toBe("answered");

    expect(store.askCalls).toHaveLength(1);
    expect(bridge.resolved?.mode).toBe(config.mode);
  });

  test("rejects an empty messages array", async () => {
    const bridge = new ProviderBridge(fakeStore(), { config: OPENAI_COMPAT, env: {} });
    await expect(bridge.chat([])).rejects.toThrow(/messages array must not be empty/);
  });

  test("surfaces the upstream provider's error.message verbatim", async () => {
    const upstream = new Error(
      'ASK failed: {"error":{"message":"invalid api key","type":"authentication_error"}}',
    );
    const store = fakeStore({ askThrow: upstream });
    const bridge = new ProviderBridge(store, { config: OPENAI_NATIVE, env: {} });

    await expect(bridge.chat([{ role: "user", content: "x" }])).rejects.toThrow(
      /invalid api key/,
    );
  });

  test("falls back to the raw message body when the error is not JSON", async () => {
    const upstream = new Error("ASK failed: upstream connection reset");
    const store = fakeStore({ askThrow: upstream });
    const bridge = new ProviderBridge(store, { config: ANTHROPIC_NATIVE, env: {} });

    await expect(bridge.chat([{ role: "user", content: "x" }])).rejects.toThrow(
      /upstream connection reset/,
    );
  });
});

describe("ProviderBridge.embed", () => {
  test("returns a numeric vector from a SELECT EMBED roundtrip", async () => {
    const store = fakeStore({ embedRows: [{ embedding: [0.5, -0.25, 0.75] }] });
    const bridge = new ProviderBridge(store, { config: OPENAI_COMPAT, env: {} });

    const vector = await bridge.embed("hello world");

    expect(vector).toEqual([0.5, -0.25, 0.75]);
    expect(store.queryCalls).toHaveLength(1);
    expect(store.queryCalls[0].sql).toMatch(/EMBED/);
    expect(store.queryCalls[0].params).toEqual(["hello world"]);
  });

  test("accepts Float32Array embeddings from the engine", async () => {
    const store = fakeStore({
      embedRows: [{ embedding: Float32Array.from([0.1, 0.2, 0.3]) }],
    });
    const bridge = new ProviderBridge(store, { config: OPENAI_NATIVE, env: {} });

    const vector = await bridge.embed("hi");

    expect(vector.length).toBe(3);
    expect(vector[0]).toBeCloseTo(0.1);
  });

  test("rejects empty text", async () => {
    const bridge = new ProviderBridge(fakeStore(), { config: OPENAI_COMPAT, env: {} });
    await expect(bridge.embed("   ")).rejects.toThrow(/must not be empty/);
  });

  test("surfaces upstream error.message on engine failure", async () => {
    const upstream = new Error(
      'engine: {"error":{"message":"model not found: foo","code":"model_not_found"}}',
    );
    const store = fakeStore({ embedThrow: upstream });
    const bridge = new ProviderBridge(store, { config: ANTHROPIC_NATIVE, env: {} });

    await expect(bridge.embed("hi")).rejects.toThrow(/model not found: foo/);
  });

  test("throws a clear error when the engine returns no vector", async () => {
    const store = fakeStore({ embedRows: [{ embedding: null }] });
    const bridge = new ProviderBridge(store, { config: OPENAI_COMPAT, env: {} });

    await expect(bridge.embed("hi")).rejects.toThrow(/no embedding vector/);
  });
});

describe("provider mode resolution", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    delete process.env[PROVIDER_MODE_ENV];
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("reads the mode from the provider config when no env override is set", () => {
    const bridge = new ProviderBridge(fakeStore(), { config: OPENAI_NATIVE, env: {} });
    expect(bridge.resolved?.mode).toBe("openai-native");
  });

  test(`${PROVIDER_MODE_ENV} overrides the config mode at runtime`, () => {
    const bridge = new ProviderBridge(fakeStore(), {
      config: OPENAI_NATIVE,
      env: { [PROVIDER_MODE_ENV]: "anthropic-native" },
    });
    expect(bridge.resolved?.mode).toBe("anthropic-native");
  });

  test(`${PROVIDER_MODE_ENV} accepts bedrock as a valid override`, () => {
    const bridge = new ProviderBridge(fakeStore(), {
      // region present so the override to bedrock resolves cleanly
      config: { ...OPENAI_NATIVE, region: "us-east-1" },
      env: { [PROVIDER_MODE_ENV]: "bedrock" },
    });
    expect(bridge.resolved?.mode).toBe("bedrock");
    expect(bridge.resolved?.region).toBe("us-east-1");
  });

  test(`${PROVIDER_MODE_ENV} with an unknown value is rejected, not silently ignored`, () => {
    expect(
      () =>
        new ProviderBridge(fakeStore(), {
          config: OPENAI_NATIVE,
          env: { [PROVIDER_MODE_ENV]: "ollama-rest" },
        }),
    ).toThrow(/not a valid provider mode/);
  });

  test("without a config, resolved is null and chat/embed cannot leak default credentials", () => {
    const bridge = new ProviderBridge(fakeStore(), { env: {} });
    expect(bridge.resolved).toBeNull();
  });

  test("defaults to process.env when no env override is provided", () => {
    process.env[PROVIDER_MODE_ENV] = "anthropic-native";
    const bridge = new ProviderBridge(fakeStore(), { config: OPENAI_COMPAT });
    expect(bridge.resolved?.mode).toBe("anthropic-native");
  });
});

describe("surfaceUpstreamMessage", () => {
  test("extracts OpenAI-shaped error.message", () => {
    const m = surfaceUpstreamMessage(
      new Error('failed: {"error":{"message":"rate limit","type":"rate_limit_error"}}'),
    );
    expect(m).toBe("rate limit");
  });

  test("extracts Anthropic-shaped message", () => {
    const m = surfaceUpstreamMessage(
      new Error('failed: {"type":"error","message":"overloaded"}'),
    );
    expect(m).toBe("overloaded");
  });

  test("returns raw body when not JSON", () => {
    const m = surfaceUpstreamMessage(new Error("upstream connection reset"));
    expect(m).toBe("upstream connection reset");
  });

  test("never swallows null/undefined", () => {
    expect(surfaceUpstreamMessage(null)).toBe("unknown provider error");
    expect(surfaceUpstreamMessage(undefined)).toBe("unknown provider error");
  });
});

describe("no LLM SDK imports", () => {
  test("plugins/memory/src/ has no openai/anthropic/litellm imports (AC1)", async () => {
    const { glob } = await import("fast-glob");
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(here, "../src");
    const files = await glob("**/*.ts", { cwd: srcDir, absolute: true });
    const forbidden = /from\s+["'](?:openai|@anthropic-ai\/sdk|anthropic|litellm)["']/;
    const offenders: string[] = [];
    for (const file of files) {
      const body = await readFile(file, "utf8");
      if (forbidden.test(body)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
