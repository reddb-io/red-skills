import { describe, expect, it } from "vitest";
import { detectRunner, parseRunnerFlag } from "../src/core/runner-detection.js";

describe("runner detection", () => {
  it("honours --runner before env/process/path detection", () => {
    expect(detectRunner({ flag: "codex", env: { CLAUDECODE: "1" } }).runner).toBe("codex");
    expect(detectRunner({ flag: "codex", env: { CLAUDECODE: "1" } }).method).toBe("flag");
  });

  it("detects Claude and Codex from their env surfaces", () => {
    expect(detectRunner({ env: { CLAUDE_CODE_SSE_PORT: "123" } })).toMatchObject({ runner: "claude", method: "env-var" });
    expect(detectRunner({ env: { CODEX_SANDBOX: "workspace-write" } })).toMatchObject({ runner: "codex", method: "env-var" });
  });

  it("honours RED_AFK_RUNNER before ambient runner sniffing", () => {
    expect(detectRunner({ env: { RED_AFK_RUNNER: "codex", CLAUDECODE: "1" } })).toMatchObject({
      runner: "codex",
      method: "env-var",
      detail: "RED_AFK_RUNNER",
    });
    expect(() => detectRunner({ env: { RED_AFK_RUNNER: "bogus" } })).toThrow("unsupported runner: bogus");
  });

  it("falls back through process tree, path, and injected fallback", () => {
    expect(detectRunner({ env: {}, processTree: "node /opt/openai-codex/bin/codex" })).toMatchObject({ runner: "codex", method: "process" });
    expect(detectRunner({ env: {}, scriptPath: "/home/me/.claude/plugins/dev/afk.sh" })).toMatchObject({ runner: "claude", method: "path" });
    expect(detectRunner({ env: {}, fallback: "hermes" })).toMatchObject({ runner: "hermes", method: "env-fallback" });
  });

  it("parses both runner flag forms", () => {
    expect(parseRunnerFlag(["--runner", "claude"])).toBe("claude");
    expect(parseRunnerFlag(["--runner=codex"])).toBe("codex");
    expect(parseRunnerFlag(["--once"])).toBeUndefined();
  });

  // ADR 0059: opencode is a valid pin via --runner / RED_AFK_RUNNER, but is NEVER
  // auto-sniffed from caller identity — no host session is OpenCode.
  it("accepts opencode only as an explicit pin (flag or RED_AFK_RUNNER)", () => {
    expect(detectRunner({ flag: "opencode" })).toMatchObject({ runner: "opencode", method: "flag" });
    expect(detectRunner({ env: { RED_AFK_RUNNER: "opencode" } })).toMatchObject({
      runner: "opencode",
      method: "env-var",
      detail: "RED_AFK_RUNNER",
    });
  });

  it("never auto-sniffs opencode from ambient env / process tree / path", () => {
    // No ambient surface maps to opencode, so an opencode-ish process tree or
    // script path must NOT promote it — the cascade falls through to claude.
    expect(detectRunner({ env: {}, processTree: "node /opt/opencode/bin/opencode" })).toMatchObject({
      runner: "claude",
      method: "env-fallback",
    });
    expect(detectRunner({ env: { OPENCODE_HOME: "/x", OPENROUTER_API_KEY: "sk-x" } })).toMatchObject({
      runner: "claude",
      method: "env-fallback",
    });
    expect(detectRunner({ env: {}, scriptPath: "/home/me/.opencode/run.sh" })).toMatchObject({
      runner: "claude",
      method: "env-fallback",
    });
  });

  // PRD #788: claude-minimax is an explicit-pin-only lane (reuses claude-code
  // over MiniMax). Like opencode, no caller identity ever auto-sniffs it.
  it("accepts claude-minimax only as an explicit pin (flag or RED_AFK_RUNNER)", () => {
    expect(detectRunner({ flag: "claude-minimax" })).toMatchObject({ runner: "claude-minimax", method: "flag" });
    expect(detectRunner({ env: { RED_AFK_RUNNER: "claude-minimax" } })).toMatchObject({
      runner: "claude-minimax",
      method: "env-var",
      detail: "RED_AFK_RUNNER",
    });
  });

  it("never auto-sniffs claude-minimax from ambient env / process tree / path", () => {
    // No ambient surface maps to claude-minimax — a minimax-ish process tree or
    // script path must NOT promote it; the cascade falls through to claude.
    expect(detectRunner({ env: {}, processTree: "node /opt/minimax/bin/minimax" })).toMatchObject({
      runner: "claude",
      method: "env-fallback",
    });
    expect(detectRunner({ env: { MINIMAX_API_KEY: "sk-x" } })).toMatchObject({
      runner: "claude",
      method: "env-fallback",
    });
    expect(detectRunner({ env: {}, scriptPath: "/home/me/.minimax/run.sh" })).toMatchObject({
      runner: "claude",
      method: "env-fallback",
    });
  });

  it("honours an operator-configured opencode default (afk.default_runner), not a sniff", () => {
    // The injected fallback IS the operator's explicit `afk.default_runner` choice,
    // so opencode there is honoured — that is configuration, not caller-identity sniffing.
    expect(detectRunner({ env: {}, fallback: "opencode" })).toMatchObject({
      runner: "opencode",
      method: "env-fallback",
    });
  });
});
