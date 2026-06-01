import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRunnerFlag, detectRunner } from "../core/runner-detection.js";
import { callerProcessTreeNative } from "../runtime/caller-process.js";

export interface FleetLaunchResult {
  status: "launched";
  pid: number;
  target: number;
  log: string;
}

export interface FleetStopResult {
  status: "stopped" | "none" | "stale" | "timeout";
  pid?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidFile(pidFile: string, deadlineMs: number): Promise<number | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const pid = await readPid(pidFile);
    if (pid && isLivePid(pid)) return pid;
    await sleep(100);
  }
  return null;
}

function parseFleetArgs(args: readonly string[]): { stop: boolean; target: number; request?: string; runnerFlag?: string; passthrough: string[] } {
  const passthrough: string[] = [];
  let stop = false;
  let target: number | undefined;
  let request: string | undefined;
  let runnerFlag: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "stop") {
      stop = true;
      continue;
    }
    if (arg === "--request" || arg === "-r") {
      request = args[++i];
      if (request === undefined) throw new Error(`${arg} requires a value`);
      continue;
    }
    if (arg.startsWith("--request=")) {
      request = arg.slice("--request=".length);
      continue;
    }
    if (arg === "--runner") {
      runnerFlag = args[++i];
      if (runnerFlag === undefined) throw new Error("--runner requires a value");
      continue;
    }
    if (arg.startsWith("--runner=")) {
      runnerFlag = arg.slice("--runner=".length);
      continue;
    }
    if (/^[0-9]+$/.test(arg) && target === undefined) {
      target = Number(arg);
      continue;
    }
    passthrough.push(arg);
  }
  return { stop, target: target ?? 2, request, runnerFlag, passthrough };
}

export async function stopFleet(root = process.cwd(), stdout: NodeJS.WritableStream = process.stdout): Promise<FleetStopResult> {
  const tmp = join(root, ".red", "tmp");
  const pidFile = join(tmp, "afk-supervisor.pid");
  const stopFile = join(tmp, "afk-supervisor.stop");
  const pid = await readPid(pidFile);
  if (!pid) {
    stdout.write("no fleet running.\n");
    return { status: "none" };
  }
  if (!isLivePid(pid)) {
    await rm(pidFile, { force: true });
    stdout.write(`no fleet running (stale pid file at .red/tmp/afk-supervisor.pid — cleaning).\n`);
    return { status: "stale", pid };
  }
  await writeFile(stopFile, "", "utf8");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await fileExists(pidFile)) || !isLivePid(pid)) {
      stdout.write(`🛑 fleet stopped (supervisor pid=${pid} exited).\n`);
      return { status: "stopped", pid };
    }
    await sleep(1_000);
  }
  stdout.write(`warn: supervisor pid=${pid} did not exit within 30s; stop file is present, see .red/tmp/afk-supervisor.log.\n`);
  return { status: "timeout", pid };
}

export async function launchFleet(args: readonly string[], root = process.cwd(), stdout: NodeJS.WritableStream = process.stdout): Promise<FleetLaunchResult> {
  const parsed = parseFleetArgs(args);
  if (!Number.isInteger(parsed.target) || parsed.target < 0) throw new Error("fleet target must be a non-negative integer");
  const tmp = join(root, ".red", "tmp");
  await mkdir(tmp, { recursive: true });
  const pidFile = join(tmp, "afk-supervisor.pid");
  const logFile = join(tmp, "afk-supervisor.log");
  const existing = await readPid(pidFile);
  if (existing && isLivePid(existing)) {
    throw new Error(`fleet already running (supervisor pid=${existing}, log .red/tmp/afk-supervisor.log).\n  to stop it: /dev:afk fleet stop`);
  }

  const detection = detectRunner({
    flag: parsed.runnerFlag ?? parseRunnerFlag(args),
    processTree: callerProcessTreeNative(),
    scriptPath: process.argv[1],
  });
  const childArgs = [...parsed.passthrough];
  if (parsed.request) childArgs.unshift("--request", parsed.request);
  const env: NodeJS.ProcessEnv = { ...process.env, RED_AFK_TARGET: String(parsed.target), RED_AFK_RUNNER: detection.runner };
  if (parsed.request) env.RED_AFK_REQUEST = parsed.request;

  const out = await import("node:fs").then((fs) => fs.openSync(logFile, "a"));
  // Spawn the native supervisor: `node <this-bundle> __supervise`.
  const child = spawn(process.execPath, [process.argv[1]!, "__supervise", ...childArgs], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const supervisorPid = await waitForPidFile(pidFile, 3_000);
  if (!supervisorPid) {
    let tail = "";
    try {
      const text = await readFile(logFile, "utf8");
      tail = text.split(/\r?\n/).slice(-20).join("\n");
    } catch {
      // ignore
    }
    throw new Error(`fleet launch failed: supervisor pid file did not appear. log: .red/tmp/afk-supervisor.log\n${tail}`);
  }

  stdout.write(`🚀 fleet launched (supervisor pid=${supervisorPid}, target=${parsed.target})\n`);
  stdout.write(`   log:   .red/tmp/afk-supervisor.log\n`);
  stdout.write(`   stop:  /dev:afk fleet stop\n`);
  stdout.write(`   monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.\n`);
  return { status: "launched", pid: supervisorPid, target: parsed.target, log: logFile };
}

export async function fleetCommand(args: string[], cwd = process.cwd()): Promise<number> {
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
    console.error(`✗ ${message}`);
    return 1;
  }
}
