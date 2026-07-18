import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import { afkPaths, collectMonitorInputs, readFleetState, resolveRepoSlug } from "../runtime/wire.js";
import { migrateLegacyDevPaths } from "../runtime/red-path-migration.js";
import { parseRunnerFlag, detectRunner } from "../core/runner-detection.js";
import { callerProcessTreeNative } from "../runtime/caller-process.js";
import { classifySupervisor, resolveSupervisorConfig, type ElasticShrinkMode } from "../core/supervisor.js";
import { teardownWedgedSupervisor } from "../core/watchdog.js";
import { buildWatchdogIO } from "../runtime/watchdog-io.js";
import { spawnSupervisor } from "../runtime/supervisor-spawn.js";
import { isLivePid, killTreeAndWait } from "../runtime/kill-tree.js";
import { reapStaleSupervisorState } from "../runtime/supervisor-state.js";

export interface FleetLaunchResult {
  status: "launched" | "resized";
  pid: number;
  target: number;
  log: string;
}

export interface FleetStopResult {
  status: "stopped" | "none" | "stale" | "timeout";
  pid?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parsePositiveNumber(raw: string | undefined, flag: string): number {
  if (raw === undefined) throw new Error(`${flag} requires a value`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} requires a positive number`);
  return n;
}

function parseShrinkMode(raw: string | undefined, flag: string): ElasticShrinkMode {
  if (raw === undefined) throw new Error(`${flag} requires a value`);
  if (raw === "hard-kill" || raw === "drain-then-retire") return raw;
  throw new Error(`${flag} must be hard-kill or drain-then-retire`);
}

function parseFleetArgs(args: readonly string[]): { stop: boolean; status: boolean; target: number; request?: string; runnerFlag?: string; drainBudgetUsd?: number; shrinkMode?: ElasticShrinkMode; passthrough: string[] } {
  const passthrough: string[] = [];
  let stop = false;
  let status = false;
  let target: number | undefined;
  let request: string | undefined;
  let runnerFlag: string | undefined;
  let drainBudgetUsd: number | undefined;
  let shrinkMode: ElasticShrinkMode | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "stop") {
      stop = true;
      continue;
    }
    if (arg === "status") {
      status = true;
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
    if (arg === "--budget-usd" || arg === "--drain-budget-usd") {
      drainBudgetUsd = parsePositiveNumber(args[++i], arg);
      continue;
    }
    if (arg.startsWith("--budget-usd=")) {
      drainBudgetUsd = parsePositiveNumber(arg.slice("--budget-usd=".length), "--budget-usd");
      continue;
    }
    if (arg.startsWith("--drain-budget-usd=")) {
      drainBudgetUsd = parsePositiveNumber(arg.slice("--drain-budget-usd=".length), "--drain-budget-usd");
      continue;
    }
    if (arg === "--shrink-mode") {
      shrinkMode = parseShrinkMode(args[++i], arg);
      continue;
    }
    if (arg.startsWith("--shrink-mode=")) {
      shrinkMode = parseShrinkMode(arg.slice("--shrink-mode=".length), "--shrink-mode");
      continue;
    }
    if (/^[0-9]+$/.test(arg) && target === undefined) {
      target = Number(arg);
      continue;
    }
    passthrough.push(arg);
  }
  return { stop, status, target: target ?? 2, request, runnerFlag, drainBudgetUsd, shrinkMode, passthrough };
}

async function writeResizeRequest(
  path: string,
  target: number,
  shrinkMode: ElasticShrinkMode,
  runner?: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const request = {
    target,
    ...(runner !== undefined ? { runner } : {}),
    shrink_mode: shrinkMode,
  };
  await writeFile(
    tmp,
    encodeToon(request),
    "utf8",
  );
  await rename(tmp, path);
}

function directiveAck(
  state: Awaited<ReturnType<typeof readFleetState>>,
  request: { target: number; shrinkMode: ElasticShrinkMode; runner?: string },
): "applied" | "pending" {
  if (!state) return "pending";
  const appliedTarget = state.target ?? state.slotsTotal;
  if (appliedTarget !== request.target) return "pending";
  if ((state.shrinkMode ?? request.shrinkMode) !== request.shrinkMode) return "pending";
  if (request.runner !== undefined && state.runner !== request.runner) return "pending";
  return "applied";
}

export async function stopFleet(root = process.cwd(), stdout: NodeJS.WritableStream = process.stdout): Promise<FleetStopResult> {
  const paths = afkPaths(root);
  const stateAfk = dirname(paths.supervisorPidPath);
  const pidFile = paths.supervisorPidPath;
  const stopFile = join(dirname(pidFile), "afk-supervisor.stop");
  // Detached workers survive the supervisor's death (#2056): they are spawned
  // `detached: true` so they are NOT in the supervisor's process tree. Every stop
  // path must sweep them — otherwise a "stopped" report is a lie while orphaned
  // workers keep claiming, committing, and merging. Reuse the watchdog's
  // detached-worker killer + claim reconcile so no issue is stranded in `running`.
  const io = buildWatchdogIO(root, stdout);
  const sweepOrphans = async (): Promise<void> => {
    const killed = await io.killWorkers();
    if (killed > 0) {
      await io.reconcile();
      stdout.write(`terminated ${killed} orphaned worker${killed === 1 ? "" : "s"} and reconciled their claims.\n`);
    }
  };
  const supervisor = await reapStaleSupervisorState(stateAfk, isLivePid);
  if (supervisor.status === "stale") {
    await sweepOrphans();
    stdout.write(`no fleet running (stale supervisor files — cleaned).\n`);
    return { status: "stale", ...(supervisor.pid !== undefined ? { pid: supervisor.pid } : {}) };
  }
  const pid = supervisor.pid;
  if (!pid) {
    await sweepOrphans();
    stdout.write("no fleet running.\n");
    return { status: "none" };
  }
  await writeFile(stopFile, "", "utf8");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await fileExists(pidFile)) || !isLivePid(pid)) {
      // The supervisor's own terminateAll should have killed its slots on clean
      // exit, but sweep detached survivors anyway — a slot the loop lost track of
      // (moved-pid, mid-spawn) would otherwise outlive the "stopped" report.
      await sweepOrphans();
      stdout.write(`🛑 fleet stopped (supervisor pid=${pid} exited).\n`);
      return { status: "stopped", pid };
    }
    await sleep(1_000);
  }

  // Graceful stop timed out: a SIGTERM-ignoring supervisor (and its worker tree)
  // is still alive. Never report "stopped" while survivors linger (#580) —
  // escalate to the shared wait-and-escalate killer (SIGTERM → SIGKILL → confirm)
  // and only report stopped once the tree is confirmed gone.
  stdout.write(
    `warn: supervisor pid=${pid} did not exit within 30s of the stop file; escalating to SIGTERM/SIGKILL.\n`,
  );
  const dead = await killTreeAndWait(pid);
  if (dead) {
    // SIGKILL skips the supervisor's own `finally`, so clean its control files.
    await rm(pidFile, { force: true });
    await rm(stopFile, { force: true });
    // killTree of the supervisor pid misses the detached workers — sweep them.
    await sweepOrphans();
    stdout.write(`🛑 fleet stopped (supervisor pid=${pid} killed after graceful-stop timeout).\n`);
    return { status: "stopped", pid };
  }
  stdout.write(
    `✗ supervisor pid=${pid} survived SIGKILL; still live — see .red/tmp/supervisors/default/supervisor.log.toonl.\n`,
  );
  return { status: "timeout", pid };
}

export interface FleetStatusResult {
  status: "reported";
}

/**
 * Read-only fleet ground truth in one place (#2060). Answers "what is actually
 * running right now?" — the question that today requires cross-referencing the
 * supervisor pid, N worker pids, the in-process slot map, and two snapshot files.
 * Local reads only (ADR 0084); never mutates. Renders TOON (the agent-facing
 * output mandate). Surfaces the classifySupervisor health verdict and whether a
 * watchdog respawn would fire, so "why is nothing running?" is answerable.
 */
export async function statusFleet(root = process.cwd(), stdout: NodeJS.WritableStream = process.stdout): Promise<FleetStatusResult> {
  const io = buildWatchdogIO(root, stdout);
  const liveness = await io.liveness();
  const cfg = resolveSupervisorConfig();
  const now = Math.floor(Date.now() / 1000);
  const health = classifySupervisor(liveness, now, cfg.supervisorStaleS, cfg.progressStaleS);
  const repo = await resolveRepoSlug(root).catch(() => "");
  const inputs = await collectMonitorInputs(root, repo);
  const fleet = inputs.fleet;
  const liveWorkers = inputs.workers.filter((w) => w.pidLive === true || w.live);
  const heartbeatAgeS = liveness.lastHeartbeatEpoch !== null ? now - liveness.lastHeartbeatEpoch : -1;

  // A dead supervisor with ready-for-agent work and fewer live workers than the
  // target is what the watchdog would respawn — surface it so an operator who
  // sees "no workers" knows the recovery will (or won't) fire on the next tick.
  const wouldRespawn =
    health === "absent" &&
    (fleet?.readyForAgent ?? 0) > 0 &&
    liveWorkers.length < (fleet?.slotsTotal ?? cfg.target);

  const report = {
    supervisor: {
      pid: liveness.pid ?? 0,
      alive: liveness.pidAlive,
      health,
      runner: fleet?.runner ?? "",
      target: fleet?.target ?? fleet?.slotsTotal ?? 0,
      bundle_version: fleet?.bundleVersion ?? "",
      bundle_latest: fleet?.latestBundleVersion ?? "",
      heartbeat_age_s: heartbeatAgeS,
      would_respawn: wouldRespawn,
    },
    slots: {
      busy: fleet?.slotsBusy ?? 0,
      free: fleet?.slotsFree ?? 0,
      parked: fleet?.slotsParked ?? 0,
      total: fleet?.slotsTotal ?? 0,
    },
    churn: {
      deaths: fleet?.churnDeaths ?? 0,
      respawns: fleet?.churnRespawns ?? 0,
      window_s: fleet?.churnWindowS ?? 0,
    },
    live_workers: liveWorkers.map((w) => ({
      id: w.state.worker_id,
      pid: w.state.pid,
      issue: String(w.state.current.number),
      activity: w.state.current.activity,
      origin: w.state.origin ?? "afk",
    })),
  };
  stdout.write(`${encodeToon(report)}\n`);
  return { status: "reported" };
}

export async function launchFleet(args: readonly string[], root = process.cwd(), stdout: NodeJS.WritableStream = process.stdout): Promise<FleetLaunchResult> {
  const parsed = parseFleetArgs(args);
  if (!Number.isInteger(parsed.target) || parsed.target < 0) throw new Error("fleet target must be a non-negative integer");
  const paths = afkPaths(root);
  const stateAfk = dirname(paths.supervisorPidPath);
  await mkdir(paths.tmpDir, { recursive: true });
  await mkdir(stateAfk, { recursive: true });
  // One-time boot migration: relocate legacy `.red/tmp` / state artifacts to
  // their canonical state or supervisor tmp lane before any supervisor path is read/written.
  await migrateLegacyDevPaths(root).catch(() => undefined);
  const pidFile = paths.supervisorPidPath;
  const logFile = paths.supervisorLogPath;
  const supervisor = await reapStaleSupervisorState(stateAfk, isLivePid);
  if (supervisor.status === "stale") {
    stdout.write(`cleaned stale supervisor files before fleet launch.\n`);
  }
  const existing = supervisor.status === "live" ? supervisor.pid : null;
  if (existing) {
    // A live PID is not necessarily a healthy fleet (#407): a supervisor whose
    // #406 heartbeat has gone stale past RED_AFK_SUPERVISOR_STALE_S is hard-hung
    // (drain loop wedged) and cannot re-arm itself. This launch is an
    // already-alive surface, so it doubles as the recovery watchdog — tear the
    // wedged supervisor down and fall through to a clean relaunch. A FRESH
    // heartbeat still refuses the launch, exactly as before.
    const cfg = resolveSupervisorConfig();
    const io = buildWatchdogIO(root, stdout);
    const liveness = await io.liveness();
    const health = classifySupervisor(liveness, io.now(), cfg.supervisorStaleS, cfg.progressStaleS);
    if (health !== "quiescent") {
      const shrinkMode = parsed.shrinkMode ?? cfg.shrinkMode;
      const directiveRunner = parsed.runnerFlag ? detectRunner({ flag: parsed.runnerFlag }).runner : undefined;
      await writeResizeRequest(paths.supervisorResizePath, parsed.target, shrinkMode, directiveRunner);
      const ack = directiveAck(await readFleetState(paths.fleetStatePath), {
        target: parsed.target,
        shrinkMode,
        ...(directiveRunner !== undefined ? { runner: directiveRunner } : {}),
      });
      stdout.write(
        `fleet directive ${ack} (supervisor pid=${existing}, target=${parsed.target}` +
          `${directiveRunner !== undefined ? `, runner=${directiveRunner}` : ""}, shrink-mode=${shrinkMode})\n`,
      );
      return { status: "resized", pid: existing, target: parsed.target, log: logFile };
    }
    const staleForS = liveness.lastHeartbeatEpoch !== null ? io.now() - liveness.lastHeartbeatEpoch : null;
    io.log(
      `⚠️  fleet pre-check: supervisor pid=${existing} is QUIESCENT — heartbeat stale ` +
        `${staleForS ?? "?"}s ≥ ${cfg.supervisorStaleS}s; recovering before relaunch.`,
    );
    await teardownWedgedSupervisor(io, liveness.pid);
  }

  const detection = detectRunner({
    flag: parsed.runnerFlag ?? parseRunnerFlag(args),
    processTree: callerProcessTreeNative(),
    scriptPath: process.argv[1],
  });

  const supervisorPid = await spawnSupervisor({
    root,
    target: parsed.target,
    runner: detection.runner,
    passthrough: parsed.passthrough,
    request: parsed.request,
    drainBudgetUsd: parsed.drainBudgetUsd,
    shrinkMode: parsed.shrinkMode,
  });
  if (!supervisorPid) {
    let tail = "";
    try {
      const text = await readFile(logFile, "utf8");
      tail = text.split(/\r?\n/).slice(-20).join("\n");
    } catch {
      // ignore
    }
    throw new Error(`fleet launch failed: supervisor pid file did not appear. log: .red/tmp/supervisors/default/supervisor.log.toonl\n${tail}`);
  }

  stdout.write(`🚀 fleet launched (supervisor pid=${supervisorPid}, target=${parsed.target})\n`);
  stdout.write(`   log:   .red/tmp/supervisors/default/supervisor.log.toonl\n`);
  stdout.write(`   stop:  /dev:afk fleet stop\n`);
  stdout.write(`   monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/supervisors/default/supervisor.log.toonl manually.\n`);
  return { status: "launched", pid: supervisorPid, target: parsed.target, log: logFile };
}

export async function fleetCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseFleetArgs(args);
  try {
    if (parsed.status) {
      await statusFleet(cwd);
    } else if (parsed.stop) {
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
