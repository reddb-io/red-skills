import { describe, expect, it } from "vitest";

import {
  DEFAULT_CADENCE,
  RUNNER_CREDENTIAL_ENVS,
  hasCredential,
  missingCredentialEnvs,
  parseCadence,
  selectRunner,
} from "../src/runners.mjs";

describe("parseCadence", () => {
  it("falls back to the default cadence when unset or blank", () => {
    expect(parseCadence(undefined)).toEqual(["claude", "codex", "opencode"]);
    expect(parseCadence("")).toEqual([...DEFAULT_CADENCE]);
    expect(parseCadence("  , ,")).toEqual([...DEFAULT_CADENCE]);
  });

  it("never puts claude-minimax in the default cadence", () => {
    expect(DEFAULT_CADENCE).not.toContain("claude-minimax");
    expect(parseCadence(undefined)).not.toContain("claude-minimax");
  });

  it("admits claude-minimax only when explicitly listed", () => {
    expect(parseCadence("claude-minimax")).toEqual(["claude-minimax"]);
    expect(parseCadence("claude, claude-minimax")).toEqual(["claude", "claude-minimax"]);
  });

  it("trims, lowercases and de-duplicates while preserving order", () => {
    expect(parseCadence(" Codex , claude ,codex ")).toEqual(["codex", "claude"]);
  });

  it("rejects an unknown runner instead of silently dropping it", () => {
    expect(() => parseCadence("claude,hal9000")).toThrow(/hal9000/);
  });
});

describe("hasCredential", () => {
  it("maps each runner to its credential env vars", () => {
    expect(RUNNER_CREDENTIAL_ENVS.claude).toContain("ANTHROPIC_API_KEY");
    expect(RUNNER_CREDENTIAL_ENVS.codex).toContain("OPENAI_API_KEY");
    expect(RUNNER_CREDENTIAL_ENVS["claude-minimax"]).toEqual(["MINIMAX_API_KEY"]);
  });

  it("accepts any one of a runner's alternative credentials", () => {
    expect(hasCredential("claude", { CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toBe(true);
    expect(hasCredential("opencode", { OPENROUTER_API_KEY: "k" })).toBe(true);
    expect(hasCredential("opencode", {})).toBe(false);
  });

  it("treats a blank value as missing", () => {
    expect(hasCredential("codex", { OPENAI_API_KEY: "   " })).toBe(false);
    expect(missingCredentialEnvs("codex", {})).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("selectRunner", () => {
  const all = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", OPENROUTER_API_KEY: "r" };

  it("round-robins across the cadence, one step per run", () => {
    const cadence = ["claude", "codex", "opencode"];
    const picks = [0, 1, 2, 3].map((cycle) => selectRunner(cadence, cycle, all).runner);
    expect(picks).toEqual(["claude", "codex", "opencode", "claude"]);
  });

  it("falls back to the next credentialed runner when a credential is missing", () => {
    const cadence = ["claude", "codex", "opencode"];
    const onlyOpenRouter = { OPENROUTER_API_KEY: "r" };
    const selection = selectRunner(cadence, 0, onlyOpenRouter);
    expect(selection.runner).toBe("opencode");
    expect(selection.skipped).toEqual(["claude", "codex"]);
  });

  it("wraps around the cadence when the fallback passes the end", () => {
    const cadence = ["claude", "codex", "opencode"];
    const onlyAnthropic = { ANTHROPIC_API_KEY: "a" };
    const selection = selectRunner(cadence, 2, onlyAnthropic);
    expect(selection.runner).toBe("claude");
    expect(selection.skipped).toEqual(["opencode"]);
  });

  it("never falls back onto claude-minimax when it is not in the cadence", () => {
    const cadence = ["claude", "codex", "opencode"];
    const onlyMiniMax = { MINIMAX_API_KEY: "m" };
    // MINIMAX_API_KEY does credential opencode, so opencode — not claude-minimax — wins.
    expect(selectRunner(cadence, 0, onlyMiniMax).runner).toBe("opencode");
  });

  it("selects claude-minimax when it is listed and credentialed", () => {
    const selection = selectRunner(["claude-minimax"], 0, { MINIMAX_API_KEY: "m" });
    expect(selection.runner).toBe("claude-minimax");
  });

  it("returns no runner when every cadence entry lacks a credential", () => {
    const selection = selectRunner(["claude", "codex"], 0, {});
    expect(selection.runner).toBeNull();
    expect(selection.skipped).toEqual(["claude", "codex"]);
  });

  it("rejects an empty cadence", () => {
    expect(() => selectRunner([], 0, all)).toThrow(/cadence/);
  });
});
