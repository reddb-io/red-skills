// mcp-lane-canary — the MCP lane's own liveness proof (ADR 0128 §7).
//
// `project_start` once spawned every slot against a bundle that cannot route
// `run`; each slot died before writing a worker directory, so workers created
// through the CANONICAL interface drained zero issues while the CLI lane kept
// working and no surface reported the difference (#2677). A merged fix proves
// nothing there: the defect only exists in the shipped bundle, exercised
// through the real MCP transport.
//
// This module is the step machine, kept IO-free so both the real transport
// (runtime/mcp-lane-canary-io.ts) and the regression tests drive the same
// ordered contract. Every step names itself on failure, so a red canary reports
// WHICH step went inert instead of "the lane did nothing".
//
// The lane grew a SECOND process under ADR 0130 (#2794): a Worker's process
// liveness now resolves over a unix socket to the `redskilled` daemon, so the
// MCP server answering is no longer evidence that the lane behind it answers.
// `daemon_reach` is that boundary's own step — a reachable tool over an
// unreachable daemon is exactly the shape #2677 taught us goes unnoticed.

import { encode as encodeToon } from "@reddb-io/toon";
import { isDaemonSilence } from "../runtime/liveness-anchor.js";

/** The ordered lane the canary walks. A step name IS the failure vocabulary. */
export type McpLaneCanaryStep =
  | "connect"
  | "project_start"
  | "supervisor_live"
  | "worker_spawn"
  | "daemon_reach"
  | "project_status"
  | "project_stop";

export const MCP_LANE_CANARY_STEPS: readonly McpLaneCanaryStep[] = [
  "connect",
  "project_start",
  "supervisor_live",
  "worker_spawn",
  "daemon_reach",
  "project_status",
  "project_stop",
];

/** The MCP tools the lane must expose before the canary can walk it at all. */
export const MCP_LANE_CANARY_REQUIRED_TOOLS: readonly string[] = [
  "project_start",
  "project_status",
  "project_stop",
  "worker_vitals",
];

/** One worker directory as observed on disk — the anchor `project_start`'s
 * returned pid can never substitute for. */
export interface CanaryWorker {
  /** Worker id (the `.red/tmp/workers/<id>` directory name). */
  readonly worker: string;
  /** Absolute worker directory path. */
  readonly dir: string;
  /** The pid in `worker.pid`, or null when the file is absent/unparseable. */
  readonly pid: number | null;
  /** Whether that pid names a live process right now. */
  readonly alive: boolean;
}

export interface McpLaneCanaryDeps {
  /** Real `tools/list` over the transport. */
  listTools(): Promise<readonly string[]>;
  /** Real `tools/call` over the transport; returns the decoded payload. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Fresh on-disk scan of the worker lane. */
  observeWorkers(): Promise<readonly CanaryWorker[]>;
  /** Liveness for a pid the canary holds directly (the supervisor's). */
  isLive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface McpLaneCanaryOptions {
  readonly runner: string;
  /** Slots to ask for. One is enough to prove the lane is not inert. */
  readonly target?: number;
  /** How long a healthy lane may take to produce a live worker. */
  readonly workerDeadlineMs?: number;
  /** How long `project_stop` may take to retire the supervisor and its workers. */
  readonly teardownDeadlineMs?: number;
  /** How long the lane's reader may take to publish the spawned Worker with the
   * daemon's verdict on it. */
  readonly daemonDeadlineMs?: number;
  /** The unix socket this walk expects `redskilled` to answer on. Named in every
   * `daemon_reach` failure, because "restart the daemon" and "fix the lane that
   * stopped asking it" are different repairs and the path is what tells them
   * apart. Absent reads as unresolved rather than as no boundary. */
  readonly socketPath?: string;
  readonly pollMs?: number;
}

export type McpLaneCanaryVerdict = "ok" | "inert" | "skipped";

export interface McpLaneCanaryStepResult {
  readonly step: McpLaneCanaryStep;
  readonly verdict: McpLaneCanaryVerdict;
  readonly detail: string;
}

export interface McpLaneCanaryResult {
  readonly ok: boolean;
  readonly steps: readonly McpLaneCanaryStepResult[];
  /** The FIRST step that went inert. Absent on a green run. */
  readonly inertStep?: McpLaneCanaryStep;
  /** One line naming the inert step, or the green lane. */
  readonly summary: string;
  readonly supervisorPid?: number;
  /** Live workers the canary observed at its high-water mark. */
  readonly workers: readonly CanaryWorker[];
}

const DEFAULTS = {
  target: 1,
  workerDeadlineMs: 45_000,
  teardownDeadlineMs: 20_000,
  daemonDeadlineMs: 20_000,
  pollMs: 250,
} as const;

/** A step that proved inert. Carries the step name so the walker never has to
 * guess which assertion failed. */
class InertStepError extends Error {
  constructor(
    readonly step: McpLaneCanaryStep,
    detail: string,
  ) {
    super(detail);
  }
}

function inert(step: McpLaneCanaryStep, detail: string): never {
  throw new InertStepError(step, detail);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a pid-shaped field, tolerating the TOON round-trip's string numbers. */
function readPid(value: unknown): number | null {
  const raw = typeof value === "string" ? Number(value) : value;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

function readCount(value: unknown): number {
  const raw = typeof value === "string" ? Number(value) : value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function readBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** The worker id one `worker_vitals` row is about, or null when it names none. */
function vitalsWorkerId(row: Record<string, unknown>): string | null {
  const id = asRecord(row.worker)?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

function describe(worker: CanaryWorker): string {
  return `${worker.worker} (pid=${worker.pid ?? "none"}, dir=${worker.dir})`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk the MCP lane end to end and report the first step that went inert.
 *
 * The load-bearing asymmetry lives in `worker_spawn`: a returned supervisor pid
 * is NOT evidence of drainage. The lane is only alive once a worker directory
 * with a live pid exists on disk, which is exactly what #2677's dead slots
 * never produced.
 *
 * Teardown is unconditional after a successful `project_start` — a canary that
 * leaves a live supervisor behind is worse than no canary.
 */
export async function runMcpLaneCanary(
  deps: McpLaneCanaryDeps,
  options: McpLaneCanaryOptions,
): Promise<McpLaneCanaryResult> {
  const target = options.target ?? DEFAULTS.target;
  const workerDeadlineMs = options.workerDeadlineMs ?? DEFAULTS.workerDeadlineMs;
  const teardownDeadlineMs = options.teardownDeadlineMs ?? DEFAULTS.teardownDeadlineMs;
  const daemonDeadlineMs = options.daemonDeadlineMs ?? DEFAULTS.daemonDeadlineMs;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  // One phrase, so both boundary failures route an operator to the same place.
  const socket = options.socketPath
    ? `the redskilled session socket ${options.socketPath}`
    : "the redskilled session socket (path unresolved)";

  const steps: McpLaneCanaryStepResult[] = [];
  const record = (step: McpLaneCanaryStep, verdict: McpLaneCanaryVerdict, detail: string): void => {
    steps.push({ step, verdict, detail });
  };
  let supervisorPid: number | undefined;
  let workers: readonly CanaryWorker[] = [];
  let inertStep: McpLaneCanaryStep | undefined;

  const invoke = async (
    step: McpLaneCanaryStep,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      return await deps.callTool(tool, args);
    } catch (error) {
      inert(step, `${tool} threw over the MCP transport: ${errorText(error)}`);
    }
  };

  const call = async (
    step: McpLaneCanaryStep,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const payload = await invoke(step, tool, args);
    const shaped = asRecord(payload);
    if (!shaped) inert(step, `${tool} returned a non-object payload: ${JSON.stringify(payload)}`);
    return shaped;
  };

  try {
    // ---- 1. connect: the transport is real, and the lane's tools exist ----
    let tools: readonly string[];
    try {
      tools = await deps.listTools();
    } catch (error) {
      inert("connect", `the MCP transport never handshook: ${errorText(error)}`);
    }
    const missing = MCP_LANE_CANARY_REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    if (missing.length > 0) {
      inert("connect", `the MCP server exposes no ${missing.join(", ")} tool — the lane is not the castle surface`);
    }
    record("connect", "ok", `tools/list served ${tools.length} tools including ${MCP_LANE_CANARY_REQUIRED_TOOLS.join(", ")}`);

    // ---- 2. project_start: the canonical interface accepts the launch ----
    const created = await call("project_start", "project_start", {
      runner: options.runner,
      target,
    });
    const status = created.status;
    if (status !== "launched" && status !== "resized") {
      inert("project_start", `project_start returned status=${JSON.stringify(status)} instead of launched`);
    }
    const pid = readPid(created.pid);
    if (pid === null) {
      inert("project_start", `project_start returned no supervisor pid (payload: ${JSON.stringify(created)})`);
    }
    supervisorPid = pid;
    record("project_start", "ok", `project_start launched this project's workers with supervisor pid ${pid}`);

    try {
      // ---- 3. supervisor_live: the returned pid is a real process ----
      if (!deps.isLive(pid)) {
        inert("supervisor_live", `project_start returned supervisor pid ${pid} but no such process is alive — the supervisor died inside its own launch probe`);
      }
      record("supervisor_live", "ok", `supervisor pid ${pid} is alive`);

      // ---- 4. worker_spawn: a worker directory AND a live worker pid ----
      // The #2677 assertion. A supervisor pid proves the launch; only this
      // proves the slot entry spawned something that boots.
      const deadline = deps.now() + workerDeadlineMs;
      let seen: readonly CanaryWorker[] = [];
      let live: readonly CanaryWorker[] = [];
      for (;;) {
        seen = await deps.observeWorkers();
        live = seen.filter((worker) => worker.alive);
        if (live.length > 0) break;
        if (deps.now() >= deadline) break;
        if (!deps.isLive(pid)) {
          inert("worker_spawn", `supervisor pid ${pid} died before any worker appeared — the lane went inert during its first ticks`);
        }
        await deps.sleep(pollMs);
      }
      if (live.length === 0) {
        const observed = seen.length === 0
          ? "no worker directory was ever written"
          : `only dead worker directories exist: ${seen.map(describe).join("; ")}`;
        inert(
          "worker_spawn",
          `project_start returned supervisor pid ${pid} but ${observed} within ${workerDeadlineMs}ms — the slot entry spawned nothing that boots (the #2677 shape: a bundle whose slot entry cannot route \`run\`)`,
        );
      }
      workers = live;
      record("worker_spawn", "ok", `${live.length} live worker(s): ${live.map(describe).join("; ")}`);

      // ---- 5. daemon_reach: the lane crosses the socket to the daemon ----
      // ADR 0130 put a second process behind this tool: `worker_vitals` answers
      // in the MCP server, but the verdict on a Worker's PROCESS is fetched over
      // a unix socket from `redskilled`. A dead socket does not make the tool
      // fail — it makes it answer `unknown`, which is why this needs its own
      // step and its own sentence in the report.
      record("daemon_reach", "ok", await reachDaemon(live));

      // ---- 6. project_status: the canonical reader observes that worker ----
      const observedStatus = await call("project_status", "project_status", {});
      const supervisor = asRecord(observedStatus.supervisor);
      if (!supervisor || !readBool(supervisor.alive)) {
        inert("project_status", `project_status reports the supervisor as not alive while pid ${pid} is running — the lane's reader and writer disagree`);
      }
      const reportedPid = readPid(supervisor.pid);
      if (reportedPid !== pid) {
        inert("project_status", `project_status reports supervisor pid ${reportedPid ?? "none"}, not the ${pid} project_start returned`);
      }
      const busy = readCount(asRecord(observedStatus.slots)?.busy);
      if (busy < 1) {
        inert("project_status", `project_status reports slots.busy=${busy} while ${live.length} live worker(s) exist on disk — the lane cannot see its own workers`);
      }
      record("project_status", "ok", `project_status observes supervisor ${pid} with slots.busy=${busy}`);
    } finally {
      // ---- 7. project_stop: teardown, always attempted once workers exist ----
      // Nothing thrown here may mask the walk's own verdict, so the teardown
      // reports its failure as a step rather than as an exception.
      try {
        steps.push(await stopFleet());
      } catch (error) {
        steps.push({
          step: "project_stop",
          verdict: "inert",
          detail: `teardown itself threw: ${errorText(error)}`,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof InertStepError)) throw error;
    inertStep = error.step;
    // The failing step is recorded in walk order, ahead of any teardown row.
    const teardownAt = steps.findIndex((entry) => entry.step === "project_stop");
    const failure: McpLaneCanaryStepResult = {
      step: error.step,
      verdict: "inert",
      detail: error.message,
    };
    if (teardownAt === -1) steps.push(failure);
    else steps.splice(teardownAt, 0, failure);
  }

  for (const step of MCP_LANE_CANARY_STEPS) {
    if (steps.some((entry) => entry.step === step)) continue;
    steps.push({
      step,
      verdict: "skipped",
      detail: inertStep ? `not reached — the lane went inert at ${inertStep}` : "not reached",
    });
  }
  steps.sort(
    (a, b) => MCP_LANE_CANARY_STEPS.indexOf(a.step) - MCP_LANE_CANARY_STEPS.indexOf(b.step),
  );

  const ok = inertStep === undefined && steps.every((entry) => entry.verdict === "ok");
  const failed = steps.find((entry) => entry.verdict === "inert");
  const resolvedInert = inertStep ?? failed?.step;
  return {
    ok,
    steps,
    ...(resolvedInert ? { inertStep: resolvedInert } : {}),
    summary: ok
      ? "MCP lane canary green: project_start → live worker → a daemon verdict over the socket → project_status → project_stop all answered"
      : `MCP lane canary FAILED — the ${resolvedInert} step went inert: ${
        steps.find((entry) => entry.step === resolvedInert)?.detail ?? "no detail"
      }`,
    ...(supervisorPid !== undefined ? { supervisorPid } : {}),
    workers,
  };

  /**
   * Prove the tool's answer came FROM the daemon rather than from its silence.
   *
   * The verdict is read for a worker the canary watched appear on disk, never
   * for whatever the reader happens to list: a payload about no work is exactly
   * the false green this probe exists to refuse. What the daemon says about that
   * worker is not asserted — a Worker this lane launched itself was never in the
   * daemon's set, so `unknown` is the honest answer and only SILENCE is a defect.
   */
  async function reachDaemon(live: readonly CanaryWorker[]): Promise<string> {
    const wanted = new Set(live.map((worker) => worker.worker));
    const deadline = deps.now() + daemonDeadlineMs;
    for (;;) {
      const payload = await invoke("daemon_reach", "worker_vitals", { live_only: false });
      const rows = (Array.isArray(payload) ? payload : [])
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => row !== null);
      const ids = rows.map(vitalsWorkerId);
      const at = ids.findIndex((id) => id !== null && wanted.has(id));
      if (at !== -1) return daemonVerdict(rows[at]!, ids[at]!);
      if (deps.now() >= deadline) {
        const listed = rows.length === 0
          ? "listed no worker at all"
          : `listed only ${ids.map((id) => id ?? "<unnamed>").join(", ")}`;
        inert(
          "daemon_reach",
          `worker_vitals ${listed} within ${daemonDeadlineMs}ms, so no daemon verdict was ever published for the live worker(s) ${[...wanted].join(", ")} — the lane's own reader cannot see the worker the lane just spawned`,
        );
      }
      await deps.sleep(pollMs);
    }
  }

  /** Read one vitals row's daemon block, or name how the boundary failed. */
  function daemonVerdict(row: Record<string, unknown>, workerId: string): string {
    const block = asRecord(row.daemon_liveness);
    if (!block) {
      inert(
        "daemon_reach",
        `worker_vitals published ${workerId} with no daemon_liveness block — the shipped lane no longer crosses ${socket} at all, so nothing on it measures a Worker's process`,
      );
    }
    const reason = asRecord(block.staleness)?.reason;
    if (typeof reason !== "string" || reason === "") {
      inert(
        "daemon_reach",
        `worker_vitals published ${workerId} with a daemon_liveness block carrying no staleness reason (${JSON.stringify(block)}) — an answer that cannot say how current it is cannot be the daemon's`,
      );
    }
    if (isDaemonSilence(reason)) {
      inert(
        "daemon_reach",
        `worker_vitals answered over MCP for ${workerId} but the redskilled daemon behind it did not: ${reason} — the tool is reachable and the socket is not, which is what an inert lane looks like once it spans two processes; nothing answered on ${socket}`,
      );
    }
    return `worker_vitals crossed the socket for ${workerId}: the daemon answered (verdict=${
      typeof block.verdict === "string" ? block.verdict : "none"
    }, anchor=${typeof block.anchor === "string" ? block.anchor : "none"}, ${reason})`;
  }

  /** Stop the workers and CONFIRM the supervisor and its workers are gone. */
  async function stopFleet(): Promise<McpLaneCanaryStepResult> {
    if (supervisorPid === undefined) {
      return {
        step: "project_stop",
        verdict: "skipped",
        detail: "nothing was started, so there is nothing to stop",
      };
    }
    const pid = supervisorPid;
    let stopped: Record<string, unknown>;
    try {
      stopped = await call("project_stop", "project_stop", { force: true });
    } catch (error) {
      return {
        step: "project_stop",
        verdict: "inert",
        detail: error instanceof InertStepError ? error.message : errorText(error),
      };
    }
    if (stopped.status !== "stopped" && stopped.status !== "none") {
      return {
        step: "project_stop",
        verdict: "inert",
        detail: `project_stop returned status=${JSON.stringify(stopped.status)} for supervisor pid ${pid} — the canonical stop no-opped`,
      };
    }
    const deadline = deps.now() + teardownDeadlineMs;
    for (;;) {
      const remaining = (await deps.observeWorkers()).filter((worker) => worker.alive);
      if (!deps.isLive(pid) && remaining.length === 0) {
        return {
          step: "project_stop",
          verdict: "ok",
          detail: `project_stop retired supervisor ${pid} and every worker it spawned`,
        };
      }
      if (deps.now() >= deadline) {
        const survivors = deps.isLive(pid) ? [`supervisor ${pid}`] : [];
        survivors.push(...remaining.map(describe));
        return {
          step: "project_stop",
          verdict: "inert",
          detail: `project_stop returned ${String(stopped.status)} but ${survivors.join(", ")} survived ${teardownDeadlineMs}ms`,
        };
      }
      await deps.sleep(pollMs);
    }
  }
}

/** Render the walk as TOON (ADR 0097): the step table first, so the inert row
 * is readable without parsing the summary sentence. */
export function renderMcpLaneCanaryToon(result: McpLaneCanaryResult): string {
  return encodeToon({
    canary: "mcp-lane",
    ok: result.ok,
    ...(result.inertStep ? { inert_step: result.inertStep } : {}),
    ...(result.supervisorPid !== undefined ? { supervisor_pid: result.supervisorPid } : {}),
    steps: result.steps.map((step) => ({
      step: step.step,
      verdict: step.verdict,
      detail: step.detail,
    })),
    workers: result.workers.map((worker) => ({
      worker: worker.worker,
      pid: worker.pid ?? 0,
      alive: worker.alive,
    })),
    summary: result.summary,
  });
}
