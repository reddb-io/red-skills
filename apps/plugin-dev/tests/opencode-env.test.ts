import { describe, it, expect } from "vitest";
import {
  OPENCODE_AUTH_ENV_PRECEDENCE,
  openCodeAuthEnv,
  resolveOpenCodeAuth,
} from "@reddb-io/worker/engine";

describe("OPENCODE_AUTH_ENV_PRECEDENCE", () => {
  it("lists OPENAI before MINIMAX before OPENROUTER (ADR 0059 amendment)", () => {
    expect(OPENCODE_AUTH_ENV_PRECEDENCE).toEqual([
      "OPENAI_API_KEY",
      "MINIMAX_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
  });
});

describe("resolveOpenCodeAuth", () => {
  it("returns undefined when no precedence entry is set", () => {
    expect(resolveOpenCodeAuth({})).toBeUndefined();
    expect(resolveOpenCodeAuth({ SOME_OTHER_KEY: "x" })).toBeUndefined();
  });

  it("treats an empty-string value as unset (no false-positive dispatch)", () => {
    // Operators sometimes export placeholders in shared shell rc files. An
    // empty value must not dispatch to a provider with no actual key.
    expect(resolveOpenCodeAuth({ OPENAI_API_KEY: "" })).toBeUndefined();
    expect(resolveOpenCodeAuth({ MINIMAX_API_KEY: "" })).toBeUndefined();
    expect(resolveOpenCodeAuth({ OPENROUTER_API_KEY: "" })).toBeUndefined();
  });

  it("resolves OPENAI_API_KEY when it is the only key set", () => {
    expect(resolveOpenCodeAuth({ OPENAI_API_KEY: "sk-openai-123" })).toEqual({
      envVar: "OPENAI_API_KEY",
      keyValue: "sk-openai-123",
    });
  });

  it("resolves MINIMAX_API_KEY when it is the only key set", () => {
    expect(resolveOpenCodeAuth({ MINIMAX_API_KEY: "minimax-sub-456" })).toEqual({
      envVar: "MINIMAX_API_KEY",
      keyValue: "minimax-sub-456",
    });
  });

  it("resolves OPENROUTER_API_KEY when it is the only key set (back-compat with #626)", () => {
    expect(resolveOpenCodeAuth({ OPENROUTER_API_KEY: "sk-or-789" })).toEqual({
      envVar: "OPENROUTER_API_KEY",
      keyValue: "sk-or-789",
    });
  });

  it("applies precedence OPENAI > MINIMAX > OPENROUTER when multiple are set", () => {
    expect(
      resolveOpenCodeAuth({
        OPENAI_API_KEY: "sk-oai",
        MINIMAX_API_KEY: "minimax",
        OPENROUTER_API_KEY: "sk-or",
      }),
    ).toEqual({ envVar: "OPENAI_API_KEY", keyValue: "sk-oai" });
    expect(
      resolveOpenCodeAuth({
        MINIMAX_API_KEY: "minimax",
        OPENROUTER_API_KEY: "sk-or",
      }),
    ).toEqual({ envVar: "MINIMAX_API_KEY", keyValue: "minimax" });
    expect(
      resolveOpenCodeAuth({ OPENROUTER_API_KEY: "sk-or", MINIMAX_API_KEY: "" }),
    ).toEqual({ envVar: "OPENROUTER_API_KEY", keyValue: "sk-or" });
  });

  it("ignores unrelated env vars (does not match by name coincidence)", () => {
    // Verifies the resolver sticks to the precedence list — a stray
    // OPENAI_API_BASE / MINIMAX_BASE_URL / etc. must not satisfy the dispatch.
    expect(
      resolveOpenCodeAuth({
        OPENAI_API_BASE: "https://api.openai.com/v1",
        MINIMAX_BASE_URL: "https://api.minimax.chat/v1",
        OPENROUTER_BASE: "https://openrouter.ai/api/v1",
      }),
    ).toBeUndefined();
  });
});

describe("openCodeAuthEnv", () => {
  it("returns undefined when the resolver yielded no auth (fail-closed no-op)", () => {
    expect(openCodeAuthEnv(undefined)).toBeUndefined();
  });

  it("builds a single-key env object keyed by the resolver's env-var name", () => {
    expect(openCodeAuthEnv({ envVar: "OPENAI_API_KEY", keyValue: "k" })).toEqual({
      OPENAI_API_KEY: "k",
    });
    expect(openCodeAuthEnv({ envVar: "MINIMAX_API_KEY", keyValue: "k" })).toEqual({
      MINIMAX_API_KEY: "k",
    });
    expect(openCodeAuthEnv({ envVar: "OPENROUTER_API_KEY", keyValue: "k" })).toEqual({
      OPENROUTER_API_KEY: "k",
    });
  });
});
