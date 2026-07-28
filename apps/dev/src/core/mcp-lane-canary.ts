// mcp-lane-canary — the MCP lane's own liveness proof (ADR 0128 §7).
//
// `fleet_create` once spawned every slot against a bundle that cannot route
// `run`; each slot died before writing a worker directory, so a fleet created
// through the CANONICAL interface drained zero issues while the CLI lane kept
// working and no surface reported the difference (#2677). A merged fix proves
// nothing there: the defect only exists in the shipped bundle, exercised
// through the real MCP transport.
//
// This module is the step machine, kept IO-free so both the real transport
// (runtime/mcp-lane-canary-io.ts) and the regression tests drive the same
// ordered contract. Every step names itself on failure, so a red canary reports
// WHICH step went inert instead of "the fleet did nothing".

import { encode as encodeToon } from "@reddb-io/toon";

/** The ordered lane the canary walks. A step name IS the failure vocabulary. */
export type McpLaneCanaryStep =
  | "connect"
  | "fleet_create"
  | "supervisor_live"
  | "worker_spawn"
  | "fleet_status"
  | "fleet_stop";

export const MCP_LANE_CANARY_STEPS: readonly McpLaneCanaryStep[] = [
  "connect",
  "fleet_create",
  "supervisor_live",
  "worker_spawn",
  "fleet_status",
  "fleet_stop",
];

/** The MCP tools the lane must expose before the canary can walk it at all. */
export const MCP_LANE_CANARY_REQUIRED_TOOLS: readonly string[] = [
  "fleet_create",
  "fleet_status",
  "fleet_stop",
];

/** One worker directory as observed on disk — the anchor `fleet_create`'s
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
  /** Fleet name to create. Use a canary-only name — this fleet is torn down. */
  readonly fleet: string;
  readonly runner: string;
  /** Slots to ask for. One is enough to prove the lane is not inert. */
  readonly target?: number;
  /** How long a healthy lane may take to produce a live worker. */
  readonly workerDeadlineMs?: number;
  /** How long `fleet_stop` may take to retire the supervisor and its workers. */
  readonly teardownDeadlineMs?: number;
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
  readonly fleet: string;
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
 * Teardown is unconditional after a successful `fleet_create` — a canary that
 * leaves a live supervisor behind is worse than no canary.
 */
export async function runMcpLaneCanary(
  deps: McpLaneCanaryDeps,
  options: McpLaneCanaryOptions,
): Promise<McpLaneCanaryResult> {
  const target = options.target ?? DEFAULTS.target;
  const workerDeadlineMs = options.workerDeadlineMs ?? DEFAULTS.workerDeadlineMs;
  const teardownDeadlineMs = options.teardownDeadlineMs ?? DEFAULTS.teardownDeadlineMs;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;

  const steps: McpLaneCanaryStepResult[] = [];
  const record = (step: McpLaneCanaryStep, verdict: McpLaneCanaryVerdict, detail: string): void => {
    steps.push({ step, verdict, detail });
  };
  let supervisorPid: number | undefined;
  let workers: readonly CanaryWorker[] = [];
  let inertStep: McpLaneCanaryStep | undefined;

  const call = async (
    step: McpLaneCanaryStep,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    let payload: unknown;
    try {
      payload = await deps.callTool(tool, args);
    } catch (error) {
      inert(step, `${tool} threw over the MCP transport: ${errorText(error)}`);
    }
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

    // ---- 2. fleet_create: the canonical interface accepts the launch ----
    const created = await call("fleet_create", "fleet_create", {
      name: options.fleet,
      runner: options.runner,
      target,
    });
    const status = created.status;
    if (status !== "launched" && status !== "resized") {
      inert("fleet_create", `fleet_create returned status=${JSON.stringify(status)} instead of launched`);
    }
    const pid = readPid(created.pid);
    if (pid === null) {
      inert("fleet_create", `fleet_create returned no supervisor pid (payload: ${JSON.stringify(created)})`);
    }
    supervisorPid = pid;
    record("fleet_create", "ok", `fleet_create launched fleet ${options.fleet} with supervisor pid ${pid}`);

    try {
      // ---- 3. supervisor_live: the returned pid is a real process ----
      if (!deps.isLive(pid)) {
        inert("supervisor_live", `fleet_create returned supervisor pid ${pid} but no such process is alive — the supervisor died inside its own launch probe`);
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
          inert("worker_spawn", `supervisor pid ${pid} died before any worker appeared — the fleet went inert during its first ticks`);
        }
        await deps.sleep(pollMs);
      }
      if (live.length === 0) {
        const observed = seen.length === 0
          ? "no worker directory was ever written"
          : `only dead worker directories exist: ${seen.map(describe).join("; ")}`;
        inert(
          "worker_spawn",
          `fleet_create returned supervisor pid ${pid} but ${observed} within ${workerDeadlineMs}ms — the slot entry spawned nothing that boots (the #2677 shape: a bundle whose slot entry cannot route \`run\`)`,
        );
      }
      workers = live;
      record("worker_spawn", "ok", `${live.length} live worker(s): ${live.map(describe).join("; ")}`);

      // ---- 5. fleet_status: the canonical reader observes that worker ----
      const observedStatus = await call("fleet_status", "fleet_status", { fleet: options.fleet });
      const supervisor = asRecord(observedStatus.supervisor);
      if (!supervisor || !readBool(supervisor.alive)) {
        inert("fleet_status", `fleet_status reports the supervisor as not alive while pid ${pid} is running — the lane's reader and writer disagree`);
      }
      const reportedPid = readPid(supervisor.pid);
      if (reportedPid !== pid) {
        inert("fleet_status", `fleet_status reports supervisor pid ${reportedPid ?? "none"}, not the ${pid} fleet_create returned`);
      }
      const busy = readCount(asRecord(observedStatus.slots)?.busy);
      if (busy < 1) {
        inert("fleet_status", `fleet_status reports slots.busy=${busy} while ${live.length} live worker(s) exist on disk — the fleet cannot see its own workers`);
      }
      record("fleet_status", "ok", `fleet_status observes supervisor ${pid} with slots.busy=${busy}`);
    } finally {
      // ---- 6. fleet_stop: teardown, always attempted once a fleet exists ----
      // Nothing thrown here may mask the walk's own verdict, so the teardown
      // reports its failure as a step rather than as an exception.
      try {
        steps.push(await stopFleet());
      } catch (error) {
        steps.push({
          step: "fleet_stop",
          verdict: "inert",
          detail: `teardown itself threw: ${errorText(error)}`,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof InertStepError)) throw error;
    inertStep = error.step;
    // The failing step is recorded in walk order, ahead of any teardown row.
    const teardownAt = steps.findIndex((entry) => entry.step === "fleet_stop");
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
    fleet: options.fleet,
    steps,
    ...(resolvedInert ? { inertStep: resolvedInert } : {}),
    summary: ok
      ? `MCP lane canary green: fleet_create → live worker → fleet_status → fleet_stop all answered on fleet ${options.fleet}`
      : `MCP lane canary FAILED — the ${resolvedInert} step went inert: ${
        steps.find((entry) => entry.step === resolvedInert)?.detail ?? "no detail"
      }`,
    ...(supervisorPid !== undefined ? { supervisorPid } : {}),
    workers,
  };

  /** Stop the fleet and CONFIRM the supervisor and its workers are gone. */
  async function stopFleet(): Promise<McpLaneCanaryStepResult> {
    if (supervisorPid === undefined) {
      return {
        step: "fleet_stop",
        verdict: "skipped",
        detail: "no fleet was created, so there is nothing to stop",
      };
    }
    const pid = supervisorPid;
    let stopped: Record<string, unknown>;
    try {
      stopped = await call("fleet_stop", "fleet_stop", { fleet: options.fleet, force: true });
    } catch (error) {
      return {
        step: "fleet_stop",
        verdict: "inert",
        detail: error instanceof InertStepError ? error.message : errorText(error),
      };
    }
    if (stopped.status !== "stopped" && stopped.status !== "none") {
      return {
        step: "fleet_stop",
        verdict: "inert",
        detail: `fleet_stop returned status=${JSON.stringify(stopped.status)} for supervisor pid ${pid} — the canonical stop no-opped`,
      };
    }
    const deadline = deps.now() + teardownDeadlineMs;
    for (;;) {
      const remaining = (await deps.observeWorkers()).filter((worker) => worker.alive);
      if (!deps.isLive(pid) && remaining.length === 0) {
        return {
          step: "fleet_stop",
          verdict: "ok",
          detail: `fleet_stop retired supervisor ${pid} and every worker it spawned`,
        };
      }
      if (deps.now() >= deadline) {
        const survivors = deps.isLive(pid) ? [`supervisor ${pid}`] : [];
        survivors.push(...remaining.map(describe));
        return {
          step: "fleet_stop",
          verdict: "inert",
          detail: `fleet_stop returned ${String(stopped.status)} but ${survivors.join(", ")} survived ${teardownDeadlineMs}ms`,
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
    fleet: result.fleet,
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
