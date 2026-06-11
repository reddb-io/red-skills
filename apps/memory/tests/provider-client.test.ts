import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyProviderEnv } from "../src/provider-client.js";
import { resolveProvider } from "../src/extract-conversation.js";

/**
 * `applyProviderEnv` exports the resolved provider into the env the embedded
 * `red` engine inherits before the store opens. It is best-effort and
 * idempotent: it only sets what the config provides and never overwrites a
 * value the caller already exported.
 */
describe("applyProviderEnv", () => {
  const TOUCHED = [
    "RED_AI_BASE_URL",
    "RED_AI_MODEL",
    "RED_AI_PROVIDER",
    "RED_AI_REGION",
    "RED_AI_API_KEY",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOUCHED) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of TOUCHED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("exports the bedrock region and the region-derived endpoint", () => {
    const resolved = resolveProvider({
      mode: "bedrock",
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      region: "us-east-1",
    });

    applyProviderEnv(resolved);

    expect(process.env.RED_AI_REGION).toBe("us-east-1");
    expect(process.env.RED_AI_PROVIDER).toBe("bedrock");
    expect(process.env.RED_AI_BASE_URL).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(process.env.RED_AI_MODEL).toBe("anthropic.claude-3-5-sonnet-20240620-v1:0");
  });

  test("never overwrites a region the caller already exported", () => {
    process.env.RED_AI_REGION = "eu-west-1";
    const resolved = resolveProvider({ mode: "bedrock", model: "m", region: "us-east-1" });

    applyProviderEnv(resolved);

    expect(process.env.RED_AI_REGION).toBe("eu-west-1");
  });

  test("non-bedrock modes carry no region, so RED_AI_REGION stays unset", () => {
    const resolved = resolveProvider({
      mode: "openai-compat",
      model: "llama3.1",
      baseUrl: "http://localhost:11434/v1",
    });

    applyProviderEnv(resolved);

    expect(process.env.RED_AI_REGION).toBeUndefined();
    expect(process.env.RED_AI_BASE_URL).toBe("http://localhost:11434/v1");
  });
});
