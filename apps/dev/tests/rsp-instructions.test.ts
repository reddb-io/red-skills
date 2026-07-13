import { describe, expect, it } from "vitest";
import { renderRspInstructionsHookOutput } from "../src/commands/rsp-instructions.js";

describe("rsp instruction session content", () => {
  it("emits Claude SessionStart additionalContext with interception guidance", () => {
    const parsed = JSON.parse(renderRspInstructionsHookOutput("claude"));
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Claude lane");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("pre-execution interception is available");
  });

  it("emits Codex session content with rewrite guidance and the post-exec gap", () => {
    const parsed = JSON.parse(renderRspInstructionsHookOutput("codex"));
    expect(parsed.systemMessage).toContain("Codex lane");
    expect(parsed.systemMessage).toContain("rsp show el:<id>");
    expect(parsed.systemMessage).toContain("pre-execution rewrite hook is available");
    expect(parsed.systemMessage).toContain("Codex PostToolUse cannot");
  });
});
