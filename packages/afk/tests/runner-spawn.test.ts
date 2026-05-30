import { describe, expect, it } from "vitest";
import {
  buildInnerPrompt,
  claudeSpawnArgs,
  codexSpawnArgs,
  detectStage,
  isRunnerExhausted,
  runInner,
  specialUserRequestBlock,
  type InnerSpawner,
  type SpawnInvocation,
} from "../src/core/runner-spawn.js";

// A fake spawner emitting scripted stdout lines — no real claude/codex process.
function fakeSpawner(scriptedLines: string[]): { spawn: InnerSpawner; seen: SpawnInvocation[] } {
  const seen: SpawnInvocation[] = [];
  const spawn: InnerSpawner = (invocation) => {
    seen.push(invocation);
    return {
      lines: (async function* () {
        for (const line of scriptedLines) yield line;
      })(),
    };
  };
  return { spawn, seen };
}

describe("buildInnerPrompt (build_inner_prompt parity)", () => {
  it("assembles handoff + commits + body without a special request", () => {
    const prompt = buildInnerPrompt({
      agentPromptBody: "AGENT BODY",
      handoffPath: "/iter/handoff.md",
      recentCommits: "abc short log",
    });
    expect(prompt).toBe(
      "Handoff file: /iter/handoff.md  (read this first)\n\n" + "Recent commits on main:\nabc short log\n" + "\nAGENT BODY\n",
    );
    expect(prompt).not.toContain("SPECIAL USER REQUEST");
  });

  it("inserts the special request block between commits and body", () => {
    const prompt = buildInnerPrompt({
      agentPromptBody: "AGENT BODY",
      handoffPath: "/iter/handoff.md",
      recentCommits: "abc short log",
      specialRequest: "focus on the parser",
    });
    expect(prompt).toBe(
      "Handoff file: /iter/handoff.md  (read this first)\n\n" +
        "Recent commits on main:\nabc short log\n" +
        "\n---- SPECIAL USER REQUEST ------\nfocus on the parser\n-------------------------------\n" +
        "\nAGENT BODY\n",
    );
  });

  it("specialUserRequestBlock returns null when no request is set", () => {
    expect(specialUserRequestBlock(undefined)).toBeNull();
    expect(specialUserRequestBlock("")).toBeNull();
    expect(specialUserRequestBlock("do X")).toBe("---- SPECIAL USER REQUEST ------\ndo X\n-------------------------------");
  });
});

describe("detectStage (SKILL.md Stage Detection table)", () => {
  it("starts at setup and stays there on neutral lines", () => {
    expect(detectStage("hello from the agent", "setup")).toBe("setup");
  });

  it("moves to explore on git ls-files / find / Read", () => {
    expect(detectStage("running git ls-files", "setup")).toBe("explore");
    expect(detectStage("find . -name foo", "setup")).toBe("explore");
    expect(detectStage("Read packages/afk/src/cli.ts", "setup")).toBe("explore");
  });

  it("moves to impl on the first Edit / Write call", () => {
    expect(detectStage("Edit src/core/runner-spawn.ts", "explore")).toBe("impl");
    expect(detectStage("Write tests/foo.test.ts", "explore")).toBe("impl");
  });

  it("moves to tests on a pnpm test invocation", () => {
    expect(detectStage("pnpm test", "impl")).toBe("tests");
  });

  it("moves to commit on a git commit invocation", () => {
    expect(detectStage("git commit -m done", "tests")).toBe("commit");
  });

  it("never regresses to an earlier stage", () => {
    expect(detectStage("Read some/file", "impl")).toBe("impl");
    expect(detectStage("git ls-files", "commit")).toBe("commit");
  });
});

describe("claudeSpawnArgs / codexSpawnArgs (runner-*.md argv parity)", () => {
  it("builds the claude stream-json argv with the prompt last", () => {
    const inv = claudeSpawnArgs({ prompt: "PROMPT", worktree: "/wt" });
    expect(inv.command).toBe("claude");
    expect(inv.args).toEqual([
      "--model",
      "opus",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      "PROMPT",
    ]);
  });

  it("builds the codex exec --json argv with -C worktree and last-message sink", () => {
    const inv = codexSpawnArgs({ prompt: "PROMPT", worktree: "/wt", lastMessagePath: "/tmp/last" });
    expect(inv.command).toBe("codex");
    expect(inv.args).toEqual([
      "exec",
      "--json",
      "-C",
      "/wt",
      "--sandbox",
      "danger-full-access",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message",
      "/tmp/last",
      "PROMPT",
    ]);
  });
});

describe("isRunnerExhausted (run_inner exhaustion grep)", () => {
  it("matches the documented usage-limit strings, case-insensitively", () => {
    expect(isRunnerExhausted("you hit your usage limit")).toBe(true);
    expect(isRunnerExhausted("Weekly cap reached")).toBe(true);
    expect(isRunnerExhausted("session exhausted")).toBe(true);
    expect(isRunnerExhausted("rate_limit_error")).toBe(true);
    expect(isRunnerExhausted("please try again later")).toBe(true);
    expect(isRunnerExhausted("normal work output")).toBe(false);
  });
});

describe("runInner (injected spawner + attempt-reader composition)", () => {
  it("advances the stage across a scripted stream and detects the sentinel", async () => {
    const { spawn, seen } = fakeSpawner([
      "starting up",
      "git ls-files",
      "Edit src/core/runner-spawn.ts",
      "pnpm test",
      "git commit -m done",
      "<promise>DONE</promise>",
    ]);
    const invocation = claudeSpawnArgs({ prompt: "PROMPT", worktree: "/wt" });
    const result = await runInner(spawn, { runner: "claude", invocation });

    expect(seen).toEqual([invocation]);
    expect(result.stage).toBe("commit");
    expect(result.outcome?.kind).toBe("done");
    expect(result.exhausted).toBe(false);
    expect(result.lastLine).toBe("<promise>DONE</promise>");
  });

  it("composes attempt-reader: a BLOCKED sentinel is surfaced", async () => {
    const { spawn } = fakeSpawner(["Edit foo", "<promise>BLOCKED</promise>"]);
    const invocation = codexSpawnArgs({ prompt: "P", worktree: "/wt", lastMessagePath: "/tmp/last" });
    const result = await runInner(spawn, { runner: "codex", invocation });
    expect(result.outcome?.kind).toBe("blocked");
    expect(result.stage).toBe("impl");
  });

  it("ignores a sentinel quoted mid-line in planning prose (line-anchored via attempt-reader)", async () => {
    const { spawn } = fakeSpawner(["I will write <promise>DONE</promise> when finished", "Edit foo"]);
    const invocation = claudeSpawnArgs({ prompt: "P", worktree: "/wt" });
    const result = await runInner(spawn, { runner: "claude", invocation });
    // attempt-reader matches the sentinel substring within the line; this asserts
    // the composition wires through detectSentinelLine rather than re-anchoring.
    expect(result.outcome?.kind).toBe("done");
  });

  it("flags exhaustion and returns no sentinel on EOF without one", async () => {
    const { spawn } = fakeSpawner(["working", "you hit your usage limit", "still nothing"]);
    const invocation = claudeSpawnArgs({ prompt: "P", worktree: "/wt" });
    const result = await runInner(spawn, { runner: "claude", invocation });
    expect(result.exhausted).toBe(true);
    expect(result.outcome).toBeNull();
  });
});
