import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import { readBuildInfo } from "@reddb-io/build-info";
import {
  castleLanePath,
  createEnginePaths,
  fleetRegistryPath,
  readCastleLaneRecords,
  readFleetProfile,
  readHostCapabilityProfile,
  resolveHostCapabilities,
  upsertFleetProfile,
  type CastleLaneRecord,
} from "@reddb-io/red-castle/engine";
import { afkPaths, collectMonitorInputs, readFleetState, resolveRepoSlug } from "../runtime/wire.js";
import { migrateLegacyDevPaths } from "../runtime/red-path-migration.js";
import { parseRunnerFlag, detectRunner } from "../core/runner-detection.js";
import { callerProcessTreeNative } from "../runtime/caller-process.js";
import { classifySupervisor, resolveSupervisorConfig, type ElasticShrinkMode } from "../core/supervisor.js";
import { teardownWedgedSupervisor } from "../core/watchdog.js";
import { buildWatchdogIO } from "../runtime/watchdog-io.js";
import { spawnSupervisor } from "../runtime/supervisor-spawn.js";
import { spawnSupervisorWatchdog } from "../runtime/supervisor-watchdog-spawn.js";
import { isLivePid, killTreeAndWait } from "../runtime/kill-tree.js";
import {
  discoverLiveSupervisorPid,
  isSupervisorIdentityLive,
  readSupervisorIdentity,
  reapStaleSupervisorState,
} from "../runtime/supervisor-state.js";
import { readPidStartTime } from "../core/state.js";
import { parseFleetFlag, DEFAULT_FLEET_NAME } from "../core/fleet-name.js";

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

export interface FleetStopOptions {
  force?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function parseFleetArgs(args: readonly string[]): {
  stop: boolean;
  status: boolean;
  fleet: string;
  target: number;
  targetExplicit: boolean;
  request?: string;
  runnerFlag?: string;
  drainBudgetUsd?: number;
  shrinkMode?: ElasticShrinkMode;
  force: boolean;
  passthrough: string[];
} {
  const passthrough: string[] = [];
  let stop = false;
  let status = false;
  let target: number | undefined;
  let request: string | undefined;
  let runnerFlag: string | undefined;
  let drainBudgetUsd: number | undefined;
  let shrinkMode: ElasticShrinkMode | undefined;
  let force = false;

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
    if (arg === "--force") {
      force = true;
      continue;
    }
    // The fleet name is consumed here (parseFleetFlag re-reads it) so it never
    // reaches the passthrough argv each slot's `run --once` receives.
    if (arg === "--fleet") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--fleet=")) continue;
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
  return {
    stop,
    status,
    fleet: parseFleetFlag(args) ?? DEFAULT_FLEET_NAME,
    target: target ?? 2,
    targetExplicit: target !== undefined,
    request,
    runnerFlag,
    drainBudgetUsd,
    shrinkMode,
    force,
    passthrough,
  };
}

export async function writeResizeRequest(
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

export async function stopFleet(
  root = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  fleetName?: string,
  options: FleetStopOptions = {},
): Promise<FleetStopResult> {
  const paths = afkPaths(root, fleetName);
  const stateAfk = dirname(paths.supervisorPidPath);
  const pidFile = paths.supervisorPidPath;
  const stopFile = join(dirname(pidFile), "afk-supervisor.stop");
  // Publish stop intent before inspecting either process. A watchdog pass that
  // already observed a dead supervisor must see this sentinel before it can
  // relaunch, and the watchdog itself must be gone before any terminal report.
  await mkdir(dirname(stopFile), { recursive: true });
  await writeFile(stopFile, "", "utf8");
  const watchdogIdentity = await readSupervisorIdentity(
    paths.supervisorWatchdogPidPath,
    paths.supervisorWatchdogPidStartPath,
  );
  if (
    watchdogIdentity !== null &&
    isSupervisorIdentityLive(watchdogIdentity, isLivePid, readPidStartTime)
  ) {
    const watchdogDead = await killTreeAndWait(watchdogIdentity.pid);
    if (!watchdogDead) {
      stdout.write(`✗ fleet watchdog pid=${watchdogIdentity.pid} survived termination; stop remains armed.\n`);
      return { status: "timeout", pid: watchdogIdentity.pid };
    }
  }
  await rm(paths.supervisorWatchdogPidPath, { force: true });
  await rm(paths.supervisorWatchdogPidStartPath, { force: true });
  // Graceful stop deliberately leaves detached one-shot workers to finish.
  // Only explicit force reuses the watchdog's fleet-scoped worker killer and
  // reconciles claims for workers that hard teardown actually terminated.
  const io = buildWatchdogIO(root, stdout, paths.fleet);
  const killAttributedWorkersAndReconcile = async () => {
    const result = await io.killWorkers();
    if (result.killed > 0) {
      await io.reconcile();
      stdout.write(
        `terminated ${result.killed} fleet-attributed worker${result.killed === 1 ? "" : "s"} and reconciled their claims.\n`,
      );
    }
    return result;
  };
  const liveSupervisor = await discoverLiveSupervisorPid(stateAfk, isLivePid, { fleet: paths.fleet });
  if (!liveSupervisor) {
    const supervisor = await reapStaleSupervisorState(stateAfk, isLivePid);
    if (supervisor.status === "stale" && supervisor.pid !== undefined) {
      stdout.write(`no fleet running (reason=dead supervisor pid; stale files cleaned).\n`);
      return { status: "stale", ...(supervisor.pid !== undefined ? { pid: supervisor.pid } : {}) };
    }
    stdout.write("no fleet running (reason=no supervisor pid).\n");
    return { status: "none" };
  }
  const pid = liveSupervisor.pid;
  if (options.force) {
    const dead = await killTreeAndWait(pid);
    if (!dead) {
      stdout.write(`✗ supervisor pid=${pid} survived forced termination; stop remains armed.\n`);
      return { status: "timeout", pid };
    }
    await rm(pidFile, { force: true });
    await rm(paths.supervisorPidStartPath, { force: true });
    await rm(stopFile, { force: true });
    await rm(paths.supervisorRecoveryPath, { force: true });
    const workerResult = await killAttributedWorkersAndReconcile();
    if (workerResult.survivors.length > 0) {
      const survivor = workerResult.survivors[0]!;
      stdout.write(
        `✗ fleet-attributed worker pid=${survivor} survived forced termination.\n`,
      );
      return { status: "timeout", pid: survivor };
    }
    stdout.write(`🛑 fleet stopped (reason=forced teardown; supervisor pid=${pid} killed).\n`);
    return { status: "stopped", pid };
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isLivePid(pid)) {
      stdout.write(`🛑 fleet stopped (reason=operator stop requested; supervisor pid=${pid} exited).\n`);
      return { status: "stopped", pid };
    }
    await sleep(1_000);
  }

  stdout.write(
    `warn: supervisor pid=${pid} did not exit within 30s of the stop file; stop remains armed (use --force for hard teardown).\n`,
  );
  return { status: "timeout", pid };
}

export interface FleetStatusResult {
  status: "reported";
}

type FleetLogMode =
  | { kind: "supervisor" }
  | { kind: "worker"; workerId: string }
  | { kind: "all" };

interface FleetLogsArgs {
  mode: FleetLogMode;
  follow: boolean;
}

interface FleetLogSource {
  id: string;
  path: string;
  prefix: string;
}

interface FleetLogEntry {
  sourceId: string;
  index: number;
  at: string;
  line: string;
}

export interface FleetLogsResult {
  status: "logged";
  follow: boolean;
  sources: number;
}

export interface FleetLogsOptions {
  followPollMs?: number;
  signal?: AbortSignal;
}

function parseFleetLogsArgs(args: readonly string[]): FleetLogsArgs {
  let mode: FleetLogMode | undefined;
  let follow = false;

  function setMode(next: FleetLogMode): void {
    if (mode !== undefined) throw new Error("fleet logs accepts only one of --supervisor, --worker, or --all");
    mode = next;
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--follow" || arg === "-f") {
      follow = true;
      continue;
    }
    if (arg === "--supervisor") {
      setMode({ kind: "supervisor" });
      continue;
    }
    if (arg === "--all") {
      setMode({ kind: "all" });
      continue;
    }
    if (arg === "--worker" || arg === "-w") {
      const workerId = args[++i];
      if (!workerId) throw new Error(`${arg} requires a worker id`);
      setMode({ kind: "worker", workerId });
      continue;
    }
    if (arg.startsWith("--worker=")) {
      const workerId = arg.slice("--worker=".length);
      if (!workerId) throw new Error("--worker requires a worker id");
      setMode({ kind: "worker", workerId });
      continue;
    }
    throw new Error(`unknown fleet logs argument: ${arg}`);
  }

  if (mode === undefined) throw new Error("fleet logs requires --supervisor, --worker <id>, or --all");
  return { mode, follow };
}

async function childDirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Every supervisor lane under `.red/tmp/supervisors/`. A named fleet nests its
 * lanes one level deeper (`<fleet>/s<pid>/`), so this walks both the top level
 * (the legacy flat layout) and each fleet dir's children.
 */
async function supervisorLogSources(root: string): Promise<FleetLogSource[]> {
  const paths = createEnginePaths(join(root, ".red"));
  const top = await childDirs(paths.supervisorsRoot);
  const ids: string[] = [...top];
  for (const dir of top) {
    for (const nested of await childDirs(join(paths.supervisorsRoot, dir))) {
      ids.push(join(dir, nested));
    }
  }
  const sources: FleetLogSource[] = [];
  for (const id of ids) {
    const path = castleLanePath(paths, "supervisor", id);
    if (await readableFile(path)) {
      sources.push({ id: `supervisor:${id}`, path, prefix: "" });
    }
  }
  return sources;
}

async function workerLogSources(root: string, mode: Extract<FleetLogMode, { kind: "worker" | "all" }>): Promise<FleetLogSource[]> {
  const paths = createEnginePaths(join(root, ".red"));
  const workerIds = mode.kind === "worker" ? [mode.workerId] : await childDirs(paths.workersRoot);
  const sources: FleetLogSource[] = [];
  for (const workerId of workerIds) {
    const path = castleLanePath(paths, "worker", workerId);
    if (mode.kind === "worker" || await readableFile(path)) {
      sources.push({
        id: `worker:${workerId}`,
        path,
        prefix: mode.kind === "all" ? `[${workerId}] ` : "",
      });
    }
  }
  return sources;
}

async function fleetLogSources(root: string, mode: FleetLogMode): Promise<FleetLogSource[]> {
  if (mode.kind === "supervisor") return supervisorLogSources(root);
  return workerLogSources(root, mode);
}

function payloadText(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const message = payload.message;
  if (typeof message === "string") return message;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return parts.join(" ");
}

function renderRecord(record: CastleLaneRecord, prefix: string): string {
  const parts = [record.at, record.kind];
  if (record.issue !== undefined) parts.push(`#${record.issue}`);
  if (record.attempt !== undefined) parts.push(`a${record.attempt}`);
  const payload = payloadText(record.payload);
  return `${prefix}${parts.join(" ")}${payload ? ` ${payload}` : ""}`;
}

async function readLogEntries(source: FleetLogSource): Promise<FleetLogEntry[]> {
  const records = await readCastleLaneRecords(source.path);
  return records.map((record, index) => ({
    sourceId: source.id,
    index,
    at: record.at,
    line: renderRecord(record, source.prefix),
  }));
}

function sortEntries(entries: FleetLogEntry[]): FleetLogEntry[] {
  return entries.sort((a, b) => {
    const at = a.at.localeCompare(b.at);
    if (at !== 0) return at;
    const source = a.sourceId.localeCompare(b.sourceId);
    if (source !== 0) return source;
    return a.index - b.index;
  });
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/**
 * `fleet logs` is the read-only human view over the structured castle lanes.
 * It never asks GitHub or mutates local state: it decodes supervisor/worker
 * TOONL lanes and renders prose only at read time (ADR 0084).
 */
export async function logsFleet(
  args: readonly string[],
  root = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  options: FleetLogsOptions = {},
): Promise<FleetLogsResult> {
  const parsed = parseFleetLogsArgs(args);
  const emitted = new Map<string, number>();
  let sourcesSeen = 0;

  async function emitAvailable(): Promise<void> {
    const sources = await fleetLogSources(root, parsed.mode);
    sourcesSeen = Math.max(sourcesSeen, sources.length);
    const nextEntries: FleetLogEntry[] = [];
    for (const source of sources) {
      const entries = await readLogEntries(source);
      const previous = emitted.get(source.id) ?? 0;
      if (entries.length < previous) emitted.set(source.id, 0);
      const start = entries.length < previous ? 0 : previous;
      nextEntries.push(...entries.slice(start));
      emitted.set(source.id, entries.length);
    }
    for (const entry of sortEntries(nextEntries)) {
      stdout.write(`${entry.line}\n`);
    }
  }

  await emitAvailable();
  while (parsed.follow && !options.signal?.aborted) {
    await wait(options.followPollMs ?? 250, options.signal);
    if (options.signal?.aborted) break;
    await emitAvailable();
  }

  return { status: "logged", follow: parsed.follow, sources: sourcesSeen };
}

/**
 * Read-only fleet ground truth in one place (#2060). Answers "what is actually
 * running right now?" — the question that today requires cross-referencing the
 * supervisor pid, N worker pids, the in-process slot map, and two snapshot files.
 * Local reads only (ADR 0084); never mutates. Renders TOON (the agent-facing
 * output mandate). Surfaces the classifySupervisor health verdict and whether a
 * watchdog respawn would fire, so "why is nothing running?" is answerable.
 */
export async function statusFleet(
  root = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  fleetName?: string,
): Promise<FleetStatusResult> {
  const paths = afkPaths(root, fleetName);
  const io = buildWatchdogIO(root, stdout, paths.fleet);
  const liveness = await io.liveness();
  const liveSupervisor = await discoverLiveSupervisorPid(paths.supervisorRuntimeDir, isLivePid, { fleet: paths.fleet });
  if (liveSupervisor) {
    liveness.pid = liveSupervisor.pid;
    liveness.pidAlive = true;
  }
  const cfg = resolveSupervisorConfig();
  const now = Math.floor(Date.now() / 1000);
  const health = classifySupervisor(liveness, now, cfg.supervisorStaleS, cfg.progressStaleS);
  const repo = await resolveRepoSlug(root).catch(() => "");
  const inputs = await collectMonitorInputs(root, repo);
  const fleet = inputs.fleet;
  const latestBundleVersion = fleet?.latestBundleVersion || readBuildInfo("dev").version;
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
      bundle_latest: latestBundleVersion,
      version_skew: Number(Boolean(
        fleet?.bundleVersion &&
        latestBundleVersion &&
        fleet.bundleVersion !== latestBundleVersion
      )),
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
  const enginePaths = createEnginePaths(join(root, ".red"));
  const paths = afkPaths(root, parsed.fleet);
  const stateAfk = dirname(paths.supervisorPidPath);
  await mkdir(paths.tmpDir, { recursive: true });
  await mkdir(stateAfk, { recursive: true });
  // One-time boot migration: relocate legacy `.red/tmp` / state artifacts to
  // their canonical state or supervisor tmp lane before any supervisor path is read/written.
  await migrateLegacyDevPaths(root).catch(() => undefined);
  const hostProfile = await readHostCapabilityProfile(enginePaths);
  const target = parsed.targetExplicit
    ? parsed.target
    : resolveHostCapabilities(hostProfile).defaultFleetWidth;
  if (!Number.isInteger(target) || target < 0)
    throw new Error("fleet target must be a non-negative integer");
  const pidFile = paths.supervisorPidPath;
  const logFile = paths.supervisorLogPath;
  const priorFleetState = await readFleetState(paths.fleetStatePath).catch(() => null);
  // A registered fleet launches from its PROFILE: the registry supplies the
  // runner and the work-scope selector, and explicit flags still override.
  const profile = await readFleetProfile(
    fleetRegistryPath(enginePaths),
    paths.fleet,
  ).catch(() => undefined);
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
    const io = buildWatchdogIO(root, stdout, paths.fleet);
    const liveness = await io.liveness();
    const health = classifySupervisor(liveness, io.now(), cfg.supervisorStaleS, cfg.progressStaleS);
    if (health !== "quiescent") {
      const watchdogPid = await spawnSupervisorWatchdog({ root, fleet: paths.fleet });
      if (!watchdogPid) {
        throw new Error("fleet launch failed: supervisor self-heal watchdog did not arm");
      }
      const shrinkMode = parsed.shrinkMode ?? cfg.shrinkMode;
      const directiveRunner = parsed.runnerFlag
        ? detectRunner({ flag: parsed.runnerFlag }).runner
        : undefined;
      await writeResizeRequest(
        paths.supervisorResizePath,
        target,
        shrinkMode,
        directiveRunner,
      );
      const ack = directiveAck(await readFleetState(paths.fleetStatePath), {
        target,
        shrinkMode,
        ...(directiveRunner !== undefined ? { runner: directiveRunner } : {}),
      });
      stdout.write(
        `fleet directive ${ack} (supervisor pid=${existing}, target=${target}` +
          `${directiveRunner !== undefined ? `, runner=${directiveRunner}` : ""}, shrink-mode=${shrinkMode})\n`,
      );
      return { status: "resized", pid: existing, target, log: logFile };
    }
    const staleForS = liveness.lastHeartbeatEpoch !== null ? io.now() - liveness.lastHeartbeatEpoch : null;
    io.log(
      `⚠️  fleet pre-check: supervisor pid=${existing} is QUIESCENT — heartbeat stale ` +
        `${staleForS ?? "?"}s ≥ ${cfg.supervisorStaleS}s; recovering before relaunch.`,
    );
    await teardownWedgedSupervisor(io, liveness.pid);
  }

  const detection = detectRunner({
    flag: parsed.runnerFlag ?? parseRunnerFlag(args) ?? profile?.runner,
    processTree: callerProcessTreeNative(),
    scriptPath: process.argv[1],
  });

  // The profile's selector reaches every slot's `run --once` as `--selector`,
  // so this fleet only ever claims issues inside its own scope. An explicit
  // filter flag on the command line wins over the registered scope.
  const scoped =
    profile?.selector && !parsed.passthrough.some((a) => a.startsWith("--spec") || a.startsWith("--issues") || a.startsWith("--selector"))
      ? ["--selector", JSON.stringify(profile.selector)]
      : [];

  const supervisorPid = await spawnSupervisor({
    root,
    target,
    runner: detection.runner,
    passthrough: [...parsed.passthrough, ...scoped],
    request: parsed.request,
    drainBudgetUsd: parsed.drainBudgetUsd,
    shrinkMode: parsed.shrinkMode,
    adoptSlotPids: priorFleetState?.slotPids ?? [],
    fleet: paths.fleet,
  });
  if (!supervisorPid) {
    let tail = "";
    try {
      const text = await readFile(logFile, "utf8");
      tail = text.split(/\r?\n/).slice(-20).join("\n");
    } catch {
      // ignore
    }
    throw new Error(`fleet launch failed: supervisor pid file did not appear. log: .red/tmp/supervisors/${paths.fleet}/supervisor.log.toonl\n${tail}`);
  }
  const watchdogPid = await spawnSupervisorWatchdog({ root, fleet: paths.fleet });
  if (!watchdogPid) {
    await killTreeAndWait(supervisorPid).catch(() => false);
    await rm(paths.supervisorPidPath, { force: true }).catch(() => undefined);
    await rm(paths.supervisorPidStartPath, { force: true }).catch(() => undefined);
    throw new Error("fleet launch failed: supervisor self-heal watchdog did not arm");
  }

  // Persist the profile so CLI-launched fleets are always in the registry (#2358).
  await upsertFleetProfile(fleetRegistryPath(enginePaths), {
    name: paths.fleet,
    runner: detection.runner,
    ...(profile?.selector ? { selector: profile.selector } : {}),
    ...(profile?.config ? { config: profile.config } : {}),
    ...(profile?.base ? { base: profile.base } : {}),
  }).catch(() => undefined);

  const named =
    paths.fleet === DEFAULT_FLEET_NAME ? "" : ` --fleet ${paths.fleet}`;
  stdout.write(
    `🚀 fleet ${paths.fleet} launched (supervisor pid=${supervisorPid}, target=${target})\n`,
  );
  stdout.write(`   self-heal: armed (watchdog pid=${watchdogPid})\n`);
  stdout.write(`   log:   .red/tmp/supervisors/${paths.fleet}/supervisor.log.toonl\n`);
  stdout.write(`   stop:  /dev:afk fleet stop${named}\n`);
  stdout.write(
    `   monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/supervisors/${paths.fleet}/supervisor.log.toonl manually.\n`,
  );
  return { status: "launched", pid: supervisorPid, target, log: logFile };
}

export async function fleetCommand(args: string[], cwd = process.cwd()): Promise<number> {
  if (args[0] === "logs") {
    try {
      await logsFleet(args.slice(1), cwd);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ ${message}`);
      return 1;
    }
  }
  const parsed = parseFleetArgs(args);
  try {
    if (parsed.status) {
      await statusFleet(cwd, process.stdout, parsed.fleet);
    } else if (parsed.stop) {
      await stopFleet(cwd, process.stdout, parsed.fleet, { force: parsed.force });
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
