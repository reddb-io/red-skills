import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { injectClaudePathBriefs } from "../src/core/path-brief-hook.js";

const sandboxes: string[] = [];

async function fixture(): Promise<{ pluginRoot: string; repoRoot: string; stateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "path-brief-hook-"));
  sandboxes.push(root);
  const pluginRoot = join(root, "plugin");
  const repoRoot = join(root, "repo");
  const stateRoot = join(root, "state");
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "guard"), { recursive: true });
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ skills: ["./skills/guard"] }),
  );
  await writeFile(
    join(pluginRoot, "skills", "guard", "SKILL.md"),
    `---
name: guarded-source
description: Keep guarded source safe.
paths:
  - src/**/*.ts
---
Keep the guarded source invariant intact.
`,
  );
  return { pluginRoot, repoRoot, stateRoot };
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Claude path brief injection", () => {
  it("injects a matching skill brief exactly once per session", async () => {
    const options = await fixture();
    const payload = {
      session_id: "session-one",
      cwd: options.repoRoot,
      tool_name: "Edit",
      tool_input: { file_path: join(options.repoRoot, "src", "feature", "thing.ts") },
    };

    const first = await injectClaudePathBriefs(payload, options);
    const second = await injectClaudePathBriefs(payload, options);

    expect(first).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "# Path brief: guarded-source\n\nKeep the guarded source invariant intact.",
      },
    });
    expect(second).toEqual({});
  });

  it("injects nothing when the session never touches a guarded path", async () => {
    const options = await fixture();

    await expect(
      injectClaudePathBriefs(
        {
          session_id: "session-untouched",
          cwd: options.repoRoot,
          tool_name: "Write",
          tool_input: { file_path: join(options.repoRoot, "docs", "notes.md") },
        },
        options,
      ),
    ).resolves.toEqual({});
  });

  it("injects the same skill exactly once for a Codex apply_patch touch", async () => {
    const options = await fixture();
    const payload = {
      session_id: "codex-session",
      cwd: options.repoRoot,
      tool_name: "apply_patch",
      tool_input: {
        input: "*** Begin Patch\n*** Update File: src/feature/thing.ts\n@@\n+changed\n*** End Patch",
      },
    };

    const first = await injectClaudePathBriefs(payload, options);
    const second = await injectClaudePathBriefs(payload, options);

    expect(first).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "# Path brief: guarded-source\n\nKeep the guarded source invariant intact.",
      },
    });
    expect(second).toEqual({});
  });
});
