import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const here = new URL(import.meta.url).pathname;
const repoRoot = here.slice(0, here.indexOf("/apps/dev/"));

type RspHookCase = {
  name: string;
  runner: "claude" | "codex";
  lifecycle: "PreToolUse" | "PostToolUse";
  subcommand: "claude-pre-exec" | "claude-post-exec" | "codex-pre-exec" | "codex-post-exec";
};

const rspHookCases: RspHookCase[] = [
  { name: "claude pre-exec", runner: "claude", lifecycle: "PreToolUse", subcommand: "claude-pre-exec" },
  { name: "claude post-exec", runner: "claude", lifecycle: "PostToolUse", subcommand: "claude-post-exec" },
  { name: "codex pre-exec", runner: "codex", lifecycle: "PreToolUse", subcommand: "codex-pre-exec" },
  { name: "codex post-exec", runner: "codex", lifecycle: "PostToolUse", subcommand: "codex-post-exec" },
];

function rspHookCommand(testCase: RspHookCase): string {
  const manifestPath = join(repoRoot, "plugins", "dev", "hooks", `${testCase.runner}.hooks.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const groups = manifest.hooks[testCase.lifecycle] ?? [];
  const hook = groups
    .flatMap((entry: { hooks?: Array<{ command?: string }> }) => entry.hooks ?? [])
    .find(
      (entry: { command?: string }) =>
        entry.command?.includes("rsp-hook.sh") && entry.command?.includes(testCase.subcommand),
    );
  if (!hook?.command) throw new Error(`${testCase.runner} rsp ${testCase.name} hook command not found`);
  return hook.command;
}

function rspPrimeCommand(runner: RspHookCase["runner"]): string {
  const manifestPath = join(repoRoot, "plugins", "dev", "hooks", `${runner}.hooks.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const groups = manifest.hooks.SessionStart ?? [];
  const hook = groups
    .flatMap((entry: { hooks?: Array<{ command?: string }> }) => entry.hooks ?? [])
    .find((entry: { command?: string }) => entry.command?.includes("rsp-hook.sh") && entry.command?.includes(" prime"));
  if (!hook?.command) throw new Error(`${runner} rsp SessionStart prime hook command not found`);
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
      CODEX_PLUGIN_ROOT: pluginRoot,
      RED_SKILLS_HOOK_TIMEOUT_S: "2s",
      RED_SKILLS_HOOK_STDIN_TIMEOUT_S: "2s",
      RED_SKILLS_RSP_HOOK_CACHE_DIR: join(pluginRoot, "..", "rsp-hook-cache"),
      ...extraEnv,
    },
  });
}

function runPrime(
  command: string,
  pluginRoot: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-lc", command], {
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CODEX_PLUGIN_ROOT: pluginRoot,
      RED_SKILLS_HOOK_TIMEOUT_S: "2s",
      RED_SKILLS_HOOK_STDIN_TIMEOUT_S: "2s",
      RED_SKILLS_RSP_HOOK_CACHE_DIR: join(pluginRoot, "..", "rsp-hook-cache"),
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
      "  appendFileSync(process.env.RSP_HOOK_LOG, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(input), redBin: process.env.REDDB_BIN }) + '\\n');",
      "  process.stdout.write('{}');",
      "});",
      "",
    ].join("\n"),
  );
}

function writePluginManifests(pluginRoot: string, version = "2.32.0"): void {
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
  writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ version }));
}

function installRspHookScript(pluginRoot: string): void {
  const hookDir = join(pluginRoot, "hooks");
  mkdirSync(hookDir, { recursive: true });
  const target = join(hookDir, "rsp-hook.sh");
  copyFileSync(join(repoRoot, "plugins", "dev", "hooks", "rsp-hook.sh"), target);
  chmodSync(target, 0o755);
}

describe("rsp host hooks", () => {
  it.each(rspHookCases)("exits 0 when the $name rsp bundle is absent", (testCase) => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      mkdirSync(pluginRoot, { recursive: true });

      const result = runHook(rspHookCommand(testCase), pluginRoot, testCase);

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
      installRspHookScript(pluginRoot);
      writePluginManifests(pluginRoot);
      writeFileSync(join(dist, "rsp.bundle.min.mjs"), "process.exit(42);\n");

      const prime = runPrime(rspPrimeCommand(testCase.runner), pluginRoot);
      expect(prime.status).toBe(0);

      const result = runHook(rspHookCommand(testCase), pluginRoot, testCase, {
        RED_SKILLS_HOOK_DEBUG: "1",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("rsp-hook:");
      expect(result.stderr).toContain("exited 42");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(rspHookCases)("does not discover the $name warmed cache on the command hot path", (testCase) => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      const cacheRoot = join(tmp, "red-skills-cache");
      const bundle = join(cacheRoot, "rsp-2.32.0.bundle.min.mjs");
      const log = join(tmp, "rsp-hook.log");
      mkdirSync(pluginRoot, { recursive: true });
      installRspHookScript(pluginRoot);
      writeRecordingRspBundle(bundle);

      const result = runHook(rspHookCommand(testCase), pluginRoot, testCase, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
        RSP_HOOK_LOG: log,
      });

      expect(result.status).toBe(0);
      expect(existsSync(log)).toBe(false);
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
      installRspHookScript(pluginRoot);
      writePluginManifests(pluginRoot);
      writeRecordingRspBundle(bundle);

      const prime = runPrime(rspPrimeCommand(testCase.runner), pluginRoot, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
      });
      expect(prime.status).toBe(0);
      expect(prime.stdout).toBe("{}");

      const result = runHook(rspHookCommand(testCase), pluginRoot, testCase, {
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

  it.each(rspHookCases)("sets REDDB_BIN from the warm runtime cache for $name", (testCase) => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      const cacheRoot = join(tmp, "red-skills-cache");
      const bundle = join(cacheRoot, "rsp-2.32.0.bundle.min.mjs");
      const red = join(cacheRoot, "reddb", "1.7.0", process.platform === "win32" ? "red.exe" : "red");
      const log = join(tmp, "rsp-hook.log");
      mkdirSync(pluginRoot, { recursive: true });
      installRspHookScript(pluginRoot);
      writePluginManifests(pluginRoot);
      mkdirSync(join(red, ".."), { recursive: true });
      writeFileSync(red, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeRecordingRspBundle(bundle);

      const prime = runPrime(rspPrimeCommand(testCase.runner), pluginRoot, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
      });
      expect(prime.status).toBe(0);

      const result = runHook(rspHookCommand(testCase), pluginRoot, testCase, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
        RSP_HOOK_LOG: log,
      });

      expect(result.status).toBe(0);
      const [line] = readFileSync(log, "utf8").trim().split("\n");
      expect(JSON.parse(line)).toMatchObject({ redBin: red });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(rspHookCases)("invalidates the $name cache when the plugin manifest changes", (testCase) => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-rsp-hook-"));
    try {
      const pluginRoot = join(tmp, "plugins", "dev");
      const cacheRoot = join(tmp, "red-skills-cache");
      const bundle = join(cacheRoot, "rsp-2.32.0.bundle.min.mjs");
      const log = join(tmp, "rsp-hook.log");
      const manifest = join(pluginRoot, testCase.runner === "claude" ? ".claude-plugin" : ".codex-plugin", "plugin.json");
      mkdirSync(pluginRoot, { recursive: true });
      installRspHookScript(pluginRoot);
      writePluginManifests(pluginRoot);
      writeRecordingRspBundle(bundle);

      const prime = runPrime(rspPrimeCommand(testCase.runner), pluginRoot, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
      });
      expect(prime.status).toBe(0);

      const first = runHook(rspHookCommand(testCase), pluginRoot, testCase, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
        RSP_HOOK_LOG: log,
      });
      expect(first.status).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);

      const future = new Date(Date.now() + 5000);
      writeFileSync(manifest, JSON.stringify({ version: "2.33.0" }));
      utimesSync(manifest, future, future);

      const second = runHook(rspHookCommand(testCase), pluginRoot, testCase, {
        RED_SKILLS_CACHE_DIR: cacheRoot,
        RSP_HOOK_LOG: log,
        RED_SKILLS_HOOK_DEBUG: "1",
      });
      expect(second.status).toBe(0);
      expect(second.stderr).toContain("stale");
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
