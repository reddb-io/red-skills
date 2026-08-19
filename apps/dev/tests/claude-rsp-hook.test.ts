// claude-rsp-hook — the rsp host hook script after ADR 0147 §4 switched its
// wiring OFF (issue #4010).
//
// The manifests stopped invoking `hooks/rsp-hook.sh`; the script itself stayed,
// because the ticket switches the surface off and keeps the code. That leaves
// two obligations, and this file holds both. The manifests must name the hook
// NOWHERE — an absence is what nobody notices coming back, so it is asserted
// rather than assumed. And the script must keep behaving, so the wrapper the
// retired manifest entry used to spell is kept HERE, verbatim in shape, and the
// behavioural suite runs against it exactly as before: a host that re-wires the
// hook tomorrow gets the same guarantees it had yesterday.
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

/**
 * The SessionStart/PreToolUse/PostToolUse wrapper the dev hook manifests used
 * to declare, before ADR 0147 §4 removed the entries. It lives here now so the
 * script keeps being exercised through the shape a host actually invokes it
 * with — stdin spooled to a temp file, both timeouts honoured, an absent or
 * non-executable script degrading to a silent success.
 */
function hostWrapper(runner: RspHookCase["runner"], subcommand: string, fallback: "json" | "exit"): string {
  const rootVar = runner === "claude" ? "CLAUDE_PLUGIN_ROOT" : "CODEX_PLUGIN_ROOT";
  const onFailure = fallback === "json" ? 'printf "{}"' : "true";
  const onAbsent = fallback === "json" ? 'printf "{}"' : "exit 0";
  return (
    `sh -c 'tmp="$(mktemp)"; trap "rm -f \\"$tmp\\"" EXIT; ` +
    `timeout "\${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat >"$tmp" 2>/dev/null || true; ` +
    `hook="\${${rootVar}}/hooks/rsp-hook.sh"; ` +
    `if [ -x "$hook" ]; then timeout "\${RED_SKILLS_HOOK_TIMEOUT_S:-3s}" "$hook" ${subcommand} <"$tmp" || ${onFailure}; ` +
    `else ${onAbsent}; fi'`
  );
}

function rspHookCommand(testCase: RspHookCase): string {
  return hostWrapper(testCase.runner, testCase.subcommand, "exit");
}

function rspPrimeCommand(runner: RspHookCase["runner"]): string {
  return hostWrapper(runner, "prime", "json");
}

/** Every `command` string anywhere in one dev hook manifest. */
function manifestCommands(runner: RspHookCase["runner"]): string[] {
  const manifestPath = join(repoRoot, "plugins", "dev", "hooks", `${runner}.hooks.json`);
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  return Object.values(parsed.hooks ?? {})
    .flat()
    .flatMap((group) => group.hooks ?? [])
    .map((entry) => entry.command ?? "");
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

describe("the dev hook manifests no longer wire the rsp host hooks (ADR 0147 §4)", () => {
  it.each(["claude", "codex"] as const)("%s: names rsp-hook.sh in no lifecycle", (runner) => {
    const offenders = manifestCommands(runner).filter((command) => command.includes("rsp-hook.sh"));
    expect(offenders, `${runner}.hooks.json still invokes the rsp host hook`).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("%s: injects no rsp instructions at session start", (runner) => {
    const offenders = manifestCommands(runner).filter((command) => command.includes("rsp-instructions"));
    expect(offenders, `${runner}.hooks.json still injects the rsp ambient skill`).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("%s: keeps the script itself installed", (runner) => {
    // The wiring is what ADR 0147 §4 removes; the code stays for the fold-in,
    // and the behavioural suite above is only meaningful while it does.
    void runner;
    expect(existsSync(join(repoRoot, "plugins", "dev", "hooks", "rsp-hook.sh"))).toBe(true);
  });
});
