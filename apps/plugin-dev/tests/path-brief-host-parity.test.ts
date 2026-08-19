import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { injectPathBriefs } from "../src/core/path-brief-hook.js";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("path brief host parity", () => {
  it("injects the same paths skill on each host's simulated first touch", async () => {
    const root = await mkdtemp(join(tmpdir(), "path-brief-host-parity-"));
    sandboxes.push(root);
    const pluginRoot = join(root, "plugin");
    const repoRoot = join(root, "repo");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "guard"), { recursive: true });
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: ["./skills/guard"] }),
    );
    await writeFile(
      join(pluginRoot, "skills", "guard", "SKILL.md"),
      "---\nname: parity-guard\ndescription: Guard parity.\npaths:\n  - src/**/*.ts\n---\nKeep host behavior identical.\n",
    );

    const hosts = [
      {
        name: "Claude Code",
        payload: { tool_name: "Edit", tool_input: { file_path: "src/feature.ts" } },
      },
      {
        name: "Codex",
        payload: {
          tool_name: "apply_patch",
          tool_input: { input: "*** Begin Patch\n*** Update File: src/feature.ts\n@@\n+change\n*** End Patch" },
        },
      },
      {
        name: "OpenCode",
        payload: { tool_name: "write", tool_input: { file_path: "src/feature.ts" } },
      },
    ] as const;

    for (const host of hosts) {
      const options = { pluginRoot, repoRoot, stateRoot: join(root, "state", host.name) };
      const payload = { ...host.payload, session_id: `${host.name}-session`, cwd: repoRoot };
      const first = await injectPathBriefs(payload, options);
      const second = await injectPathBriefs(payload, options);

      expect(first, host.name).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "# Path brief: parity-guard\n\nKeep host behavior identical.",
        },
      });
      expect(second, host.name).toEqual({});
    }
  });
});
