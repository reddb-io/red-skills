import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const here = new URL(import.meta.url).pathname;
const repoRoot = here.slice(0, here.indexOf("/apps/dev/"));
const manifestPath = join(repoRoot, "plugins", "dev", "hooks", "claude.hooks.json");

type RspHookCase = {
  name: string;
  lifecycle: "PreToolUse" | "PostToolUse";
  subcommand: "claude-pre-exec" | "claude-post-exec";
};

const rspHookCases: RspHookCase[] = [
  { name: "pre-exec", lifecycle: "PreToolUse", subcommand: "claude-pre-exec" },
  { name: "post-exec", lifecycle: "PostToolUse", subcommand: "claude-post-exec" },
];

function claudeRspHookCommand(testCase: RspHookCase): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bashHooks = manifest.hooks[testCase.lifecycle].find(
    (entry: { matcher?: string }) => entry.matcher === "Bash",
  );
  const hook = bashHooks.hooks.find((entry: { command?: string }) =>
    entry.command?.includes(`hook ${testCase.subcommand}`),
  );
  if (!hook?.command) throw new Error(`claude rsp ${testCase.name} hook command not found`);
  return hook.command;
}

function runHook(
  command: string,
  pluginRoot: string,
  testCase: RspHookCase,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-lc", command], {
    input: JSON.stringify({
      hook_event_name: testCase.lifecycle,
      tool_name: "Bash",
      tool_input: { command: "echo ok" },
    }),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      RED_SKILLS_HOOK_TIMEOUT_S: "2s",
      RED_SKILLS_HOOK_STDIN_TIMEOUT_S: "2s",
      ...extraEnv,
    },
  });
}

function writeRecordingRspBundle(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  appendFileSync(process.env.RSP_HOOK_LOG, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(input) }) + '\\n');",
      "  process.stdout.write('{}');",
      "});",
      "",
    ].join("\n"),
  );
}

describe("claude rsp hooks", () => {
  it.each(rspHookCases)("exits 0 when the $name rsp bundle is absent", (testCase) => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      mkdirSync(pluginRoot, { recursive: true });

      const result = runHook(claudeRspHookCommand(testCase), pluginRoot, testCase);

      expect(result.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(rspHookCases)("exits 0 when the $name rsp bundle exits non-zero", (testCase) => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      const dist = join(pluginRoot, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "rsp.bundle.min.mjs"), "process.exit(42);\n");

      const result = runHook(claudeRspHookCommand(testCase), pluginRoot, testCase);

      expect(result.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(rspHookCases)("resolves the $name bundle from the warmed bundle cache", (testCase) => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      const cacheRoot = join(tmp, "red-skills-cache");
      const bundle = join(cacheRoot, "rsp-2.32.0.bundle.min.mjs");
      const log = join(tmp, "rsp-hook.log");
      mkdirSync(pluginRoot, { recursive: true });
      writeRecordingRspBundle(bundle);

      const result = runHook(claudeRspHookCommand(testCase), pluginRoot, testCase, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
        RSP_HOOK_LOG: log,
      });

      expect(result.status).toBe(0);
      expect(existsSync(log)).toBe(true);
      const [line] = readFileSync(log, "utf8").trim().split("\n");
      expect(JSON.parse(line)).toMatchObject({
        args: ["hook", testCase.subcommand],
        input: { hook_event_name: testCase.lifecycle },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
