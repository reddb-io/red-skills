/**
 * Tests for `provider-block.ts` — the Slice 1 pure module. Every test
 * injects `env` and `configText` so the function is exercised in
 * isolation (no `process.env`, no filesystem).
 */
import { describe, expect, it } from "vitest";
import {
  buildProviderBlock,
  DEFAULT_MODEL_SLUG,
  ENV_PRECEDENCE,
  isDevPluginEnabled,
  pickAuthPrecedence,
  PROVIDER_ENTRIES,
  readOpencodeModelFromConfig,
} from "../src/provider-block.js";

const ENABLED_YAML = `plugins:\n  dev:\n    enabled: true\n`;
const DISABLED_YAML = `plugins:\n  dev:\n    enabled: false\n`;
const NO_BLOCK_YAML = `# nothing here\n`;
/** Enabled + per-tier model override, structured the way `.red/config.yaml`
 *  is actually authored: `afk` lives under `dev`, `models` under `afk`, and
 *  each tier under `models.opencode`. The shared constrained-subset yaml
 *  parser reconstructs dotted paths from indentation, so the structure has
 *  to mirror the real shape. */
const ENABLED_YAML_WITH_TIER = `plugins:
  dev:
    enabled: true
    afk:
      models:
        opencode:
          think:
            model: minimax/MiniMax-M3
`;

describe("PROVIDER_ENTRIES", () => {
  it("freezes the three endpoints ADR 0059 covers", () => {
    expect(Object.keys(PROVIDER_ENTRIES).sort()).toEqual(["minimax", "openai", "openrouter"]);
    expect(PROVIDER_ENTRIES.openrouter?.npm).toBe("@openrouter/ai-sdk-provider");
    expect(PROVIDER_ENTRIES.minimax?.options?.baseURL).toBe("https://api.minimax.chat/v1");
    expect(PROVIDER_ENTRIES.openai?.npm).toBe("@ai-sdk/openai");
  });
});

describe("ENV_PRECEDENCE", () => {
  it("locks the documented ADR 0059 Amendment 1 order", () => {
    expect(ENV_PRECEDENCE.map((s) => s.env)).toEqual([
      "OPENAI_API_KEY",
      "MINIMAX_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    expect(ENV_PRECEDENCE.map((s) => s.provider)).toEqual([
      "openai",
      "minimax",
      "openrouter",
    ]);
  });
});

describe("pickAuthPrecedence", () => {
  it("returns undefined when no precedence slot is set", () => {
    expect(pickAuthPrecedence({})).toBeUndefined();
    expect(pickAuthPrecedence({ SOME_OTHER: "x" })).toBeUndefined();
  });

  it("wins OPENAI_API_KEY when only it is set", () => {
    expect(pickAuthPrecedence({ OPENAI_API_KEY: "sk-…" })).toBe("openai");
  });

  it("wins MINIMAX_API_KEY when only it is set", () => {
    expect(pickAuthPrecedence({ MINIMAX_API_KEY: "mn-…" })).toBe("minimax");
  });

  it("wins OPENROUTER_API_KEY when only it is set (back-compat with #626)", () => {
    expect(pickAuthPrecedence({ OPENROUTER_API_KEY: "sk-or-…" })).toBe("openrouter");
  });

  it("wins the documented order when multiple are set (OPENAI > MINIMAX > OPENROUTER)", () => {
    expect(
      pickAuthPrecedence({
        OPENAI_API_KEY: "sk-…",
        MINIMAX_API_KEY: "mn-…",
        OPENROUTER_API_KEY: "sk-or-…",
      }),
    ).toBe("openai");
    expect(
      pickAuthPrecedence({ MINIMAX_API_KEY: "mn-…", OPENROUTER_API_KEY: "sk-or-…" }),
    ).toBe("minimax");
  });

  it("treats an empty string as unset", () => {
    expect(pickAuthPrecedence({ OPENAI_API_KEY: "" })).toBeUndefined();
  });
});

describe("readOpencodeModelFromConfig", () => {
  it("returns undefined when the per-tier block is absent", () => {
    expect(readOpencodeModelFromConfig(ENABLED_YAML)).toBeUndefined();
  });

  it("reads the `think` tier model from .red/config.yaml", () => {
    expect(readOpencodeModelFromConfig(ENABLED_YAML_WITH_TIER)).toBe("minimax/MiniMax-M3");
  });

  it("reads the `simple` tier when asked", () => {
    const yaml = `plugins:
  dev:
    enabled: true
    afk:
      models:
        opencode:
          simple:
            model: openai/gpt-4o-mini
`;
    expect(readOpencodeModelFromConfig(yaml, "simple")).toBe("openai/gpt-4o-mini");
  });
});

describe("isDevPluginEnabled (ADR 0067 strict opt-in)", () => {
  it("is true only when the explicit `enabled: true` is set", () => {
    expect(isDevPluginEnabled(ENABLED_YAML)).toBe(true);
  });
  it("is false when the block says `enabled: false`", () => {
    expect(isDevPluginEnabled(DISABLED_YAML)).toBe(false);
  });
  it("is false when the block is absent", () => {
    expect(isDevPluginEnabled(NO_BLOCK_YAML)).toBe(false);
  });
  it("is false for block-presence without the key (strict opt-in)", () => {
    const yaml = `plugins:\n  dev:\n    afk: {}\n`;
    expect(isDevPluginEnabled(yaml)).toBe(false);
  });
});

describe("buildProviderBlock", () => {
  it("emits the OpenRouter-shaped default when no env and no per-tier override is set", () => {
    const out = buildProviderBlock({ configText: ENABLED_YAML, env: {} });
    expect(out.model).toBe(DEFAULT_MODEL_SLUG);
    expect(Object.keys(out.provider)).toEqual(["openrouter", "minimax", "openai"]);
    expect(out["$schema"]).toBe("https://opencode.ai/config.json");
  });

  it("emits the per-tier model from .red/config.yaml when present", () => {
    const out = buildProviderBlock({ configText: ENABLED_YAML_WITH_TIER, env: {} });
    expect(out.model).toBe("minimax/MiniMax-M3");
  });

  it("respects an explicit `modelOverride` argument", () => {
    const out = buildProviderBlock({
      configText: ENABLED_YAML,
      env: {},
      modelOverride: "openai/gpt-4o",
    });
    expect(out.model).toBe("openai/gpt-4o");
  });

  it("re-orders provider entries so the active one is first", () => {
    const out = buildProviderBlock({ configText: ENABLED_YAML, env: { MINIMAX_API_KEY: "mn-…" } });
    expect(Object.keys(out.provider)[0]).toBe("minimax");
    // the rest are still present
    expect(Object.keys(out.provider).sort()).toEqual(["minimax", "openai", "openrouter"]);
  });

  it("does not embed the API key in the emitted payload", () => {
    const out = buildProviderBlock({
      configText: ENABLED_YAML,
      env: { OPENROUTER_API_KEY: "sk-or-SECRET" },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("sk-or-");
  });

  it("preserves the per-provider options (baseURL for OpenAI-compatible endpoints)", () => {
    const out = buildProviderBlock({ configText: ENABLED_YAML, env: {} });
    expect(out.provider.minimax?.options?.baseURL).toBe("https://api.minimax.chat/v1");
    expect(out.provider.openrouter?.options).toBeUndefined();
    expect(out.provider.openai?.options).toBeUndefined();
  });
});
