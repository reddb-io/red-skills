import { describe, it, expect } from "vitest";
import {
  MINIMAX_API_KEY_ENV,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M3_MODEL,
  resolveMiniMaxClaudeEnv,
} from "@reddb-io/red-castle/engine";

describe("resolveMiniMaxClaudeEnv", () => {
  it("maps MINIMAX_API_KEY to the two Anthropic inner-spawn vars", () => {
    expect(resolveMiniMaxClaudeEnv({ [MINIMAX_API_KEY_ENV]: "mm-key-123" })).toEqual({
      ANTHROPIC_API_KEY: "mm-key-123",
      ANTHROPIC_BASE_URL: MINIMAX_ANTHROPIC_BASE_URL,
      CLAUDE_CODE_SIMPLE: "1",
    });
  });

  it("returns undefined when the key is absent (lane unusable)", () => {
    expect(resolveMiniMaxClaudeEnv({})).toBeUndefined();
  });

  it("treats an empty-string key as unset (no auth-less MiniMax spawn)", () => {
    expect(resolveMiniMaxClaudeEnv({ [MINIMAX_API_KEY_ENV]: "" })).toBeUndefined();
  });

  it("ignores unrelated env vars (does not match by name coincidence)", () => {
    expect(
      resolveMiniMaxClaudeEnv({ MINIMAX_BASE_URL: "https://api.minimax.chat/v1", ANTHROPIC_API_KEY: "real-anthropic" }),
    ).toBeUndefined();
  });

  it("forces the MiniMax-M3 model id constant", () => {
    expect(MINIMAX_M3_MODEL).toBe("MiniMax-M3");
  });
});
