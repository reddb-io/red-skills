#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/commands/fleet.ts
import { spawn as spawn2 } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/types/runner.ts
var runners = ["claude", "codex", "hermes"];
function isRunner(value) {
  return runners.includes(value);
}

// src/core/runner-detection.ts
var CLAUDE_ENV_KEYS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];
var CODEX_ENV_KEYS = ["CODEX_HOME", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_MANAGED_BY_NPM"];
function envHasAny(env, keys) {
  return keys.find((key) => env[key] !== void 0 && env[key] !== "");
}
function runnerFromFallback(value) {
  return value && isRunner(value) ? value : "claude";
}
function detectRunner(input = {}) {
  const env = input.env ?? process.env;
  if (input.flag) {
    if (!isRunner(input.flag)) throw new Error(`unsupported runner: ${input.flag}`);
    return { runner: input.flag, method: "flag", detail: "--runner" };
  }
  const claudeKey = envHasAny(env, CLAUDE_ENV_KEYS);
  if (claudeKey) return { runner: "claude", method: "env-var", detail: claudeKey };
  const codexKey = envHasAny(env, CODEX_ENV_KEYS);
  if (codexKey) return { runner: "codex", method: "env-var", detail: codexKey };
  const tree = input.processTree?.toLowerCase() ?? "";
  if (/claude(\s|$|-|_)|claude-code/.test(tree)) return { runner: "claude", method: "process" };
  if (/codex(\s|$|-|_)|openai-codex/.test(tree)) return { runner: "codex", method: "process" };
  const scriptPath = input.scriptPath ?? "";
  if (scriptPath.includes("/.claude/")) return { runner: "claude", method: "path" };
  if (scriptPath.includes("/.codex/")) return { runner: "codex", method: "path" };
  const fallback = input.fallback ?? env.RED_AFK_RUNNER;
  return { runner: runnerFromFallback(fallback), method: "env-fallback", detail: fallback ?? "claude" };
}
function parseRunnerFlag(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--runner") return args[i + 1];
    if (arg.startsWith("--runner=")) return arg.slice("--runner=".length);
  }
  return void 0;
}

// src/platform/legacy.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/platform/command.ts
import { spawn } from "node:child_process";
function runInteractive(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

// src/platform/legacy.ts
var scriptNames = {
  afk: "afk.sh",
  monitor: "monitor.sh",
  supervisor: "supervisor.sh",
  once: "once.sh",
  hooks: "hooks.sh",
  statusline: "statusline.sh"
};
function skillDirFromModule(metaUrl = import.meta.url) {
  let cursor = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(cursor, "scripts", "afk.sh"))) return cursor;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error("could not locate AFK skill directory from module path");
}
function legacyScriptPath(command, skillDir = skillDirFromModule()) {
  return join(skillDir, "scripts", scriptNames[command]);
}
async function runLegacy(command, args, cwd = process.cwd()) {
  const script = legacyScriptPath(command);
  const result = await runInteractive("bash", [script, ...args], { cwd, env: process.env });
  if (result.signal) return 128;
  return result.code ?? 1;
}

// src/commands/fleet.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function isLivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function readPid(path) {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}
async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function waitForPidFile(pidFile, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const pid = await readPid(pidFile);
    if (pid && isLivePid(pid)) return pid;
    await sleep(100);
  }
  return null;
}
function parseFleetArgs(args) {
  const passthrough = [];
  let stop = false;
  let target;
  let request;
  let runnerFlag;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "stop") {
      stop = true;
      continue;
    }
    if (arg === "--request" || arg === "-r") {
      request = args[++i];
      if (request === void 0) throw new Error(`${arg} requires a value`);
      continue;
    }
    if (arg.startsWith("--request=")) {
      request = arg.slice("--request=".length);
      continue;
    }
    if (arg === "--runner") {
      runnerFlag = args[++i];
      if (runnerFlag === void 0) throw new Error("--runner requires a value");
      continue;
    }
    if (arg.startsWith("--runner=")) {
      runnerFlag = arg.slice("--runner=".length);
      continue;
    }
    if (/^[0-9]+$/.test(arg) && target === void 0) {
      target = Number(arg);
      continue;
    }
    passthrough.push(arg);
  }
  return { stop, target: target ?? 2, request, runnerFlag, passthrough };
}
async function stopFleet(root = process.cwd(), stdout = process.stdout) {
  const tmp = join2(root, ".red", "tmp");
  const pidFile = join2(tmp, "afk-supervisor.pid");
  const stopFile = join2(tmp, "afk-supervisor.stop");
  const pid = await readPid(pidFile);
  if (!pid) {
    stdout.write("no fleet running.\n");
    return { status: "none" };
  }
  if (!isLivePid(pid)) {
    await rm(pidFile, { force: true });
    stdout.write(`no fleet running (stale pid file at .red/tmp/afk-supervisor.pid \u2014 cleaning).
`);
    return { status: "stale", pid };
  }
  await writeFile(stopFile, "", "utf8");
  const deadline = Date.now() + 3e4;
  while (Date.now() < deadline) {
    if (!await fileExists(pidFile) || !isLivePid(pid)) {
      stdout.write(`\u{1F6D1} fleet stopped (supervisor pid=${pid} exited).
`);
      return { status: "stopped", pid };
    }
    await sleep(1e3);
  }
  stdout.write(`warn: supervisor pid=${pid} did not exit within 30s; stop file is present, see .red/tmp/afk-supervisor.log.
`);
  return { status: "timeout", pid };
}
async function launchFleet(args, root = process.cwd(), stdout = process.stdout) {
  const parsed = parseFleetArgs(args);
  if (!Number.isInteger(parsed.target) || parsed.target < 0) throw new Error("fleet target must be a non-negative integer");
  const tmp = join2(root, ".red", "tmp");
  await mkdir(tmp, { recursive: true });
  const pidFile = join2(tmp, "afk-supervisor.pid");
  const logFile = join2(tmp, "afk-supervisor.log");
  const existing = await readPid(pidFile);
  if (existing && isLivePid(existing)) {
    throw new Error(`fleet already running (supervisor pid=${existing}, log .red/tmp/afk-supervisor.log).
  to stop it: /dev:afk fleet stop`);
  }
  const detection = detectRunner({ flag: parsed.runnerFlag ?? parseRunnerFlag(args), scriptPath: process.argv[1] });
  const script = legacyScriptPath("supervisor");
  const childArgs = [...parsed.passthrough];
  if (parsed.request) childArgs.unshift("--request", parsed.request);
  const env = { ...process.env, RED_AFK_TARGET: String(parsed.target), RED_AFK_RUNNER: detection.runner };
  if (parsed.request) env.RED_AFK_REQUEST = parsed.request;
  const out = await import("node:fs").then((fs) => fs.openSync(logFile, "a"));
  const child = spawn2("bash", [script, ...childArgs], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  const supervisorPid = await waitForPidFile(pidFile, 3e3);
  if (!supervisorPid) {
    let tail = "";
    try {
      const text = await readFile(logFile, "utf8");
      tail = text.split(/\r?\n/).slice(-20).join("\n");
    } catch {
    }
    throw new Error(`fleet launch failed: supervisor pid file did not appear. log: .red/tmp/afk-supervisor.log
${tail}`);
  }
  stdout.write(`\u{1F680} fleet launched (supervisor pid=${supervisorPid}, target=${parsed.target})
`);
  stdout.write(`   log:   .red/tmp/afk-supervisor.log
`);
  stdout.write(`   stop:  /dev:afk fleet stop
`);
  stdout.write(`   monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.
`);
  return { status: "launched", pid: supervisorPid, target: parsed.target, log: logFile };
}
async function fleetCommand(args, cwd = process.cwd()) {
  const parsed = parseFleetArgs(args);
  try {
    if (parsed.stop) {
      await stopFleet(cwd);
    } else {
      await launchFleet(args, cwd);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\u2717 ${message}`);
    return 1;
  }
}

// src/commands/monitor.ts
async function monitorCommand(args, cwd = process.cwd()) {
  return runLegacy("monitor", args, cwd);
}

// src/commands/run.ts
async function runCommand(options) {
  const flag = parseRunnerFlag(options.args);
  const detection = detectRunner({ flag, scriptPath: process.argv[1] });
  if (!process.env.RED_AFK_TS_QUIET_BOOT) {
    process.stderr.write(`[afk-ts] runner: ${detection.runner} (detected via ${detection.method})
`);
    process.stderr.write("[afk-ts] compatibility mode: delegating orchestration to scripts/afk.sh\n");
  }
  return runLegacy("afk", options.args, options.cwd);
}

// src/cli.ts
function parseCli(argv) {
  const [first, ...rest] = argv;
  if (first === "monitor") return { command: "monitor", args: rest };
  if (first === "fleet") return { command: "fleet", args: rest };
  if (first === "run") return { command: "run", args: rest };
  return { command: "run", args: [...argv] };
}
async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.command === "monitor") return monitorCommand(parsed.args);
  if (parsed.command === "fleet") return fleetCommand(parsed.args);
  return runCommand({ args: parsed.args });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[afk-ts] ${message}`);
    process.exit(1);
  });
}
export {
  main,
  parseCli
};
