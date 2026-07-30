import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import {
  castleLanePath,
  createEnginePaths,
  PROJECT_SUPERVISOR_LANE,
  readCastleLaneRecords,
  readHostCapabilityProfile,
  runnerFromExplicitEnv,
  resolveHostCapabilities,
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
  publishSupervisorLiveness,
  readRecordedLiveSupervisorPid,
  readSupervisorLiveness,
  readWatchdogLiveness,
  reapStaleSupervisorState,
} from "../runtime/liveness-anchor.js";
import { refuseRemovedFleetFlag } from "../core/removed-fleet-flag.js";
import { publishedVersionReport, readPublishedBundleVersion } from "../core/published-version.js";

export interface FleetLaunchResult {
  status: "launched" | "resized";
  pid: number;
  target: number;
  log: string;
}

export interface FleetStopResult {
  status: "stopped" | "none" | "stale" | "timeout";
  pid?: number;
  /** Which anchor named the supervisor this stop acted on. Reporting the anchor
   * is what turns "status: none on a fleet it could see working" into a
   * diagnosable answer (#2698, #2704). */
  anchor?: "pid-file" | "fleet-state" | "none";
}

export interface FleetStopOptions {
  force?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FLEET_USAGE = `Usage: red-skills-dev fleet [target] [options]
       red-skills-dev fleet status
       red-skills-dev fleet stop [--force]
       red-skills-dev fleet logs

Options:
  --runner <runner>
  --base <branch>
  --request <text>, -r <text>
  --budget-usd <amount>
  --shrink-mode <hard-kill|drain-then-retire>
  --help, -h
`;

const WORKER_PASSTHROUGH_FLAGS = new Set([
  "--spec",
  "--issues",
  "--selector",
  "--tags",
  "--user",
  "-n",
  "--once",
  "--model",
  "--effort",
  "--alternate",
  "--fallback-runner",
  "--boot-only",
  "--reconcile-issue",
  "--origin",
  "--kind",
  "--lane",
  "--pre-pr",
  "--local-merge",
  "--yolo",
  "--verify",
  "--go-verify-retries",
  "--run-mode",
]);

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
  target: number;
  targetExplicit: boolean;
  request?: string;
  runnerFlag?: string;
  base?: string;
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
  let base: string | undefined;
  let drainBudgetUsd: number | undefined;
  let shrinkMode: ElasticShrinkMode | undefined;
  let force = false;

  // A caller that still names a fleet is answered before anything is parsed.
  refuseRemovedFleetFlag(args);

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
    // The trunk this project's work is cut from. It reached every worker through
    // the registered fleet profile before the registry was removed (ADR 0130),
    // so it is a flag now rather than a lookup.
    if (arg === "--base") {
      base = args[++i];
      if (base === undefined) throw new Error("--base requires a value");
      continue;
    }
    if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
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
    if (arg.startsWith("-")) {
      const flag = arg.split("=", 1)[0]!;
      if (!WORKER_PASSTHROUGH_FLAGS.has(flag)) {
        throw new Error(`unknown fleet flag: ${flag}`);
      }
    }
    passthrough.push(arg);
  }
  return {
    stop,
    status,
    target: target ?? 2,
    targetExplicit: target !== undefined,
    request,
    runnerFlag,
    ...(base !== undefined ? { base } : {}),
    drainBudgetUsd,
    shrinkMode,
    force,
    passthrough,
  };
}

/**
 * Launch runner cascade (#2545): explicit --runner flag > the operator's
 * RED_AFK_RUNNER env AT THIS LAUNCH > a runner remembered from elsewhere. The
 * remembered runner must never shadow the env the operator just set — that is
 * exactly the "fresh relaunch keeps the stale runner" trap. The registry that
 * once supplied the third rung is gone (ADR 0130), so nothing passes it today;
 * the order is kept because the cascade is what the rule is about.
 */
/**
 * The launch banner's monitoring line. Names the castle MCP read tools first
 * (ADR 0120/0123); the slash command and the raw log tail are the no-MCP
 * fallback for hosts that never loaded the castle server.
 */
export function fleetMonitorSuggestion(): string {
  return (
    "monitor: call the castle `monitor` tool (and `worker_vitals` for liveness); " +
    `no-MCP fallback: run /dev:afk monitor or tail .red/tmp/supervisors/${PROJECT_SUPERVISOR_LANE}/supervisor.log.toonl manually.`
  );
}

export function resolveLaunchRunnerPin(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  profileRunner: string | undefined,
): string | undefined {
  return flag ?? runnerFromExplicitEnv(env.RED_AFK_RUNNER) ?? profileRunner;
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
  options: FleetStopOptions = {},
): Promise<FleetStopResult> {
  const paths = afkPaths(root);
  const stateAfk = dirname(paths.supervisorPidPath);
  const pidFile = paths.supervisorPidPath;
  const stopFile = join(dirname(pidFile), "afk-supervisor.stop");
  // Publish stop intent before inspecting either process. A watchdog pass that
  // already observed a dead supervisor must see this sentinel before it can
  // relaunch, and the watchdog itself must be gone before any terminal report.
  await mkdir(dirname(stopFile), { recursive: true });
  await writeFile(stopFile, "", "utf8");
  const watchdog = await readWatchdogLiveness(
    paths.supervisorWatchdogPidPath,
    paths.supervisorWatchdogPidStartPath,
  );
  if (watchdog?.alive) {
    const watchdogDead = await killTreeAndWait(watchdog.pid);
    if (!watchdogDead) {
      stdout.write(`✗ fleet watchdog pid=${watchdog.pid} survived termination; stop remains armed.\n`);
      return { status: "timeout", pid: watchdog.pid };
    }
  }
  await rm(paths.supervisorWatchdogPidPath, { force: true });
  await rm(paths.supervisorWatchdogPidStartPath, { force: true });
  // Graceful stop deliberately leaves detached one-shot workers to finish.
  // Only explicit force reuses the watchdog's lane-scoped worker killer and
  // reconciles claims for workers that hard teardown actually terminated.
  const io = buildWatchdogIO(root, stdout);
  const killAttributedWorkersAndReconcile = async () => {
    const result = await io.killWorkers();
    if (result.killed > 0) {
      await io.reconcile();
      stdout.write(
        `terminated ${result.killed} supervised worker${result.killed === 1 ? "" : "s"} and reconciled their claims.\n`,
      );
    }
    return result;
  };
  // The single anchor names the supervisor to stop. `status: none` is now only
  // reachable when NO anchor names one — never while a lane is visibly ticking.
  //
  // `--force` alone may then fall back to a recorded pid that is merely alive
  // (#2714). A hard teardown must never be blocked by a missing start pin — that
  // is the state in which stop reported "no fleet running" about a supervisor the
  // operator could see and had to kill by hand.
  const liveness = await readSupervisorLiveness(stateAfk);
  const recorded =
    !liveness.alive && options.force
      ? await readRecordedLiveSupervisorPid(stateAfk, isLivePid)
      : null;
  const liveSupervisor: { pid: number; anchor: "pid-file" | "fleet-state" } | null =
    liveness.alive
      ? { pid: liveness.pid, anchor: liveness.anchor }
      : recorded !== null
        ? { pid: recorded.pid, anchor: recorded.source }
        : null;
  if (liveSupervisor === null) {
    const supervisor = await reapStaleSupervisorState(stateAfk, isLivePid);
    if (supervisor.status === "stale" && supervisor.pid !== undefined) {
      stdout.write(`no fleet running (reason=dead supervisor pid; stale files cleaned).\n`);
      return { status: "stale", pid: supervisor.pid, anchor: "none" };
    }
    stdout.write("no fleet running (reason=no supervisor pid).\n");
    return { status: "none", anchor: "none" };
  }
  const pid = liveSupervisor.pid;
  const anchor = liveSupervisor.anchor;
  if (options.force) {
    const dead = await killTreeAndWait(pid);
    if (!dead) {
      stdout.write(`✗ supervisor pid=${pid} survived forced termination; stop remains armed.\n`);
      return { status: "timeout", pid, anchor };
    }
    await rm(pidFile, { force: true });
    await rm(paths.supervisorPidStartPath, { force: true });
    await rm(stopFile, { force: true });
    await rm(paths.supervisorRecoveryPath, { force: true });
    const workerResult = await killAttributedWorkersAndReconcile();
    if (workerResult.survivors.length > 0) {
      const survivor = workerResult.survivors[0]!;
      stdout.write(
        `✗ supervised worker pid=${survivor} survived forced termination.\n`,
      );
      return { status: "timeout", pid: survivor, anchor };
    }
    stdout.write(
      `🛑 fleet stopped (reason=forced teardown; supervisor pid=${pid} killed; anchor=${anchor}).\n`,
    );
    return { status: "stopped", pid, anchor };
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isLivePid(pid)) {
      stdout.write(
        `🛑 fleet stopped (reason=operator stop requested; supervisor pid=${pid} exited; anchor=${anchor}).\n`,
      );
      return { status: "stopped", pid, anchor };
    }
    await sleep(1_000);
  }

  stdout.write(
    `warn: supervisor pid=${pid} did not exit within 30s of the stop file; stop remains armed (use --force for hard teardown).\n`,
  );
  return { status: "timeout", pid, anchor };
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
 * Every supervisor lane under `.red/tmp/supervisors/`. The project's lane nests
 * its per-process lanes one level deeper (`<lane>/s<pid>/`), so this walks both
 * the top level (the legacy flat layout) and each lane dir's children.
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
): Promise<FleetStatusResult> {
  const paths = afkPaths(root);
  const io = buildWatchdogIO(root, stdout);
  const liveness = await io.liveness();
  const cfg = resolveSupervisorConfig();
  const now = Math.floor(Date.now() / 1000);
  const supervisor = await readSupervisorLiveness(paths.supervisorRuntimeDir, {
    heartbeatEpoch: liveness.lastHeartbeatEpoch,
    staleAfterS: cfg.supervisorStaleS,
    nowS: now,
  });
  liveness.pid = supervisor.alive ? supervisor.pid : liveness.pid;
  liveness.pidAlive = supervisor.alive;
  const health = classifySupervisor(liveness, now, cfg.supervisorStaleS, cfg.progressStaleS);
  const repo = await resolveRepoSlug(root).catch(() => "");
  const inputs = await collectMonitorInputs(root, repo);
  const fleet = inputs.fleet;
  // Same owner as the boot probe (#2809): the CLI never re-derives "what is
  // published" from the fleet snapshot or from its own installed version.
  const version = publishedVersionReport(fleet?.bundleVersion, readPublishedBundleVersion());
  const liveWorkers = inputs.workers.filter((w) => w.pidLive === true || w.live);
  const heartbeatAgeS = supervisor.heartbeat.age_s;

  // A dead supervisor with ready-for-agent work and fewer live workers than the
  // target is what the watchdog would respawn — surface it so an operator who
  // sees "no workers" knows the recovery will (or won't) fire on the next tick.
  const wouldRespawn =
    health === "absent" &&
    (fleet?.readyForAgent ?? 0) > 0 &&
    liveWorkers.length < (fleet?.slotsTotal ?? cfg.target);

  const report = {
    supervisor: {
      pid: supervisor.pid,
      alive: supervisor.alive,
      health,
      runner: fleet?.runner ?? "",
      target: fleet?.target ?? fleet?.slotsTotal ?? 0,
      bundle_version: fleet?.bundleVersion ?? "",
      // Unknown is its own answer, distinct from `version_skew: 0` (#2752); the
      // published answer carries its own staleness (#2809).
      ...version,
      heartbeat_age_s: heartbeatAgeS,
      identity_anchor: supervisor.anchor,
      heartbeat: { ...publishSupervisorLiveness(supervisor).heartbeat },
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
  const paths = afkPaths(root);
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
  const supervisor = await reapStaleSupervisorState(stateAfk, isLivePid);
  if (supervisor.status === "stale") {
    stdout.write(`cleaned stale supervisor files before launch.\n`);
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
      const watchdogPid = await spawnSupervisorWatchdog({ root });
      if (!watchdogPid) {
        throw new Error("launch failed: supervisor self-heal watchdog did not arm");
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
        `directive ${ack} (supervisor pid=${existing}, target=${target}` +
          `${directiveRunner !== undefined ? `, runner=${directiveRunner}` : ""}, shrink-mode=${shrinkMode})\n`,
      );
      return { status: "resized", pid: existing, target, log: logFile };
    }
    const staleForS = liveness.lastHeartbeatEpoch !== null ? io.now() - liveness.lastHeartbeatEpoch : null;
    io.log(
      `⚠️  pre-check: supervisor pid=${existing} is QUIESCENT — heartbeat stale ` +
        `${staleForS ?? "?"}s ≥ ${cfg.supervisorStaleS}s; recovering before relaunch.`,
    );
    await teardownWedgedSupervisor(io, liveness.pid);
  }

  const detection = detectRunner({
    flag: resolveLaunchRunnerPin(parsed.runnerFlag ?? parseRunnerFlag(args), process.env, undefined),
    processTree: callerProcessTreeNative(),
    scriptPath: process.argv[1],
  });

  const supervisorPid = await spawnSupervisor({
    root,
    target,
    runner: detection.runner,
    ...(parsed.base !== undefined ? { base: parsed.base } : {}),
    passthrough: [...parsed.passthrough],
    request: parsed.request,
    drainBudgetUsd: parsed.drainBudgetUsd,
    shrinkMode: parsed.shrinkMode,
    adoptSlotPids: priorFleetState?.slotPids ?? [],
    // Isolation notices belong in the launch output, never swallowed (#2697).
    onNotice: (message) => stdout.write(`⚠ ${message}\n`),
  });
  if (!supervisorPid) {
    let tail = "";
    try {
      const text = await readFile(logFile, "utf8");
      tail = text.split(/\r?\n/).slice(-20).join("\n");
    } catch {
      // ignore
    }
    throw new Error(`launch failed: supervisor pid file did not appear. log: .red/tmp/supervisors/${PROJECT_SUPERVISOR_LANE}/supervisor.log.toonl\n${tail}`);
  }
  const watchdogPid = await spawnSupervisorWatchdog({ root });
  if (!watchdogPid) {
    await killTreeAndWait(supervisorPid).catch(() => false);
    await rm(paths.supervisorPidPath, { force: true }).catch(() => undefined);
    await rm(paths.supervisorPidStartPath, { force: true }).catch(() => undefined);
    throw new Error("launch failed: supervisor self-heal watchdog did not arm");
  }

  stdout.write(
    `🚀 workers launched (supervisor pid=${supervisorPid}, target=${target})\n`,
  );
  stdout.write(`   self-heal: armed (watchdog pid=${watchdogPid})\n`);
  stdout.write(`   log:   .red/tmp/supervisors/${PROJECT_SUPERVISOR_LANE}/supervisor.log.toonl\n`);
  stdout.write(`   stop:  /dev:afk fleet stop\n`);
  stdout.write(`   ${fleetMonitorSuggestion()}\n`);
  return { status: "launched", pid: supervisorPid, target, log: logFile };
}

export async function fleetCommand(args: string[], cwd = process.cwd()): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(FLEET_USAGE);
    return 0;
  }
  try {
    // Every route through this command, including `logs`, answers a caller that
    // still names a fleet with the replacement rather than an internal error.
    refuseRemovedFleetFlag(args);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
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
  try {
    const parsed = parseFleetArgs(args);
    if (parsed.status) {
      await statusFleet(cwd, process.stdout);
    } else if (parsed.stop) {
      await stopFleet(cwd, process.stdout, { force: parsed.force });
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
