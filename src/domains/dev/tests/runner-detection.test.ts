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

  it("falls back through process tree, path, and RED_AFK_RUNNER", () => {
    expect(detectRunner({ env: {}, processTree: "node /opt/openai-codex/bin/codex" })).toMatchObject({ runner: "codex", method: "process" });
    expect(detectRunner({ env: {}, scriptPath: "/home/me/.claude/plugins/dev/afk.sh" })).toMatchObject({ runner: "claude", method: "path" });
    expect(detectRunner({ env: { RED_AFK_RUNNER: "hermes" } })).toMatchObject({ runner: "hermes", method: "env-fallback" });
  });

  it("parses both runner flag forms", () => {
    expect(parseRunnerFlag(["--runner", "claude"])).toBe("claude");
    expect(parseRunnerFlag(["--runner=codex"])).toBe("codex");
    expect(parseRunnerFlag(["--once"])).toBeUndefined();
  });
});
