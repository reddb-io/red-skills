import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const here = new URL(import.meta.url).pathname;
const repoRoot = here.slice(0, here.indexOf("/apps/dev/"));
const manifestPath = join(repoRoot, "plugins", "dev", "hooks", "claude.hooks.json");

function claudeRspPreExecCommand(): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bashHooks = manifest.hooks.PreToolUse.find((entry: { matcher?: string }) => entry.matcher === "Bash");
  const hook = bashHooks.hooks.find((entry: { command?: string }) =>
    entry.command?.includes("hook claude-pre-exec"),
  );
  if (!hook?.command) throw new Error("claude rsp pre-exec hook command not found");
  return hook.command;
}

function runHook(command: string, pluginRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-lc", command], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo ok" },
    }),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      RED_SKILLS_HOOK_TIMEOUT_S: "2s",
      RED_SKILLS_HOOK_STDIN_TIMEOUT_S: "2s",
    },
  });
}

describe("claude rsp pre-exec hook", () => {
  it("exits 0 when the rsp bundle is absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      mkdirSync(pluginRoot, { recursive: true });

      const result = runHook(claudeRspPreExecCommand(), pluginRoot);

      expect(result.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 0 when the rsp bundle exits non-zero", () => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      const dist = join(pluginRoot, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "rsp.bundle.min.mjs"), "process.exit(42);\n");

      const result = runHook(claudeRspPreExecCommand(), pluginRoot);

      expect(result.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
