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
// **What the lane is changed under ADR 0130 Amendment 3 (#2902): the MCP
// registers, the daemon drives.** Starting work no longer launches a process of
// the project's own — it hands the host a repository identity, an opaque
// selector, an opaque argv and a target, and the host owns every birth from
// there. So the canary's load-bearing assertion INVERTED. It once refused to
// accept a returned supervisor pid as evidence of drainage; it now refuses to
// accept a lane that produced any process of its own at all, and reads the
// registration the daemon handed back as the lane's only proof of life.
//
// The socket is still the boundary that decides the walk — a start that cannot
// reach the daemon must REFUSE rather than fall back to spawning (ADR 0130 rule
// 6), and `project_start` going inert while naming that socket is what a dead
// host looks like from here.
//
// **The walk goes on past the registration (#2908).** A lane that registers and
// then does nothing looks identical, from the project's side, to one that drains:
// the difference lives in the daemon, so the canary asks it directly. It watches
// for the ONE aliased poll that covers this project (Amendment 3's whole claim,
// which a per-project poller would fail by request count alone) and then for the
// Worker that poll justified — read back from the host, never inferred from a
// directory, because a pid file cannot say whether a birth was ever admitted.

import { encode as encodeToon } from "@reddb-io/toon";

/** The ordered lane the canary walks. A step name IS the failure vocabulary. */
export type McpLaneCanaryStep =
  | "connect"
  | "project_start"
  | "registration_held"
  | "no_project_process"
  | "queue_polled"
  | "worker_born"
  | "project_status"
  | "project_stop";

export const MCP_LANE_CANARY_STEPS: readonly McpLaneCanaryStep[] = [
  "connect",
  "project_start",
  "registration_held",
  "no_project_process",
  "queue_polled",
  "worker_born",
  "project_status",
  "project_stop",
];

/** The MCP tools the lane must expose before the canary can walk it at all. */
export const MCP_LANE_CANARY_REQUIRED_TOOLS: readonly string[] = [
  "project_start",
  "project_status",
  "project_stop",
];

/** One worker directory as observed on disk — the anchor no returned payload can
 * substitute for, in either direction. */
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

/** The registration the daemon handed back, as the canary reads it. */
export interface CanaryRegistration {
  /** The daemon's opaque label for this project. */
  readonly project: string;
  readonly target: number;
  /** The project's work query, verbatim as the daemon holds it. */
  readonly selector: string;
  /** What runs when a Worker is born for this project. */
  readonly argv: readonly string[];
  /** When the registration lapses unless the session renews it. */
  readonly renewBy: string;
}

/** One Worker the DAEMON says it holds, read back across the socket. */
export interface CanaryHostWorker {
  readonly workerId: string;
  readonly pid: number;
}

/** The last poll the daemon says covered this project. */
export interface CanaryHostPoll {
  /** When the poll answered — the fetch's instant, not the read's. */
  readonly at: string;
  /** `counted` is the only outcome that carries a depth (ADR 0130 Amendment 3). */
  readonly outcome: string;
  readonly depth: number | null;
  /** What that whole interval cost, however many projects it covered. */
  readonly requestCount: number;
  readonly detail: string;
}

/**
 * What the host itself says about this project, read over the session socket.
 *
 * The canary's second source, and the only one that can tell a Worker the daemon
 * BIRTHED from one something else started: on disk the two are one directory with
 * one pid file, and the difference — whether a birth was admitted, counted and is
 * stoppable — exists only in the daemon's answer.
 */
export interface CanaryHostView {
  /** Whether the daemon answered at all. `false` leaves every field empty. */
  readonly reachable: boolean;
  /** Live Workers the host attributes to this project. */
  readonly workers: readonly CanaryHostWorker[];
  /** The last poll covering this project; null until one has. */
  readonly poll: CanaryHostPoll | null;
  /** Why the read failed, when it did. */
  readonly detail?: string;
}

export interface McpLaneCanaryDeps {
  /** Real `tools/list` over the transport. */
  listTools(): Promise<readonly string[]>;
  /** Real `tools/call` over the transport; returns the decoded payload. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Fresh on-disk scan of the worker lane. */
  observeWorkers(): Promise<readonly CanaryWorker[]>;
  /** Fresh read of the daemon's own answer about one project, over the socket. */
  observeHost(project: string): Promise<CanaryHostView>;
  /** Liveness for a pid the canary holds directly. */
  isLive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface McpLaneCanaryOptions {
  readonly runner: string;
  /** Slots to ask for. One is enough to prove the lane is not inert. */
  readonly target?: number;
  /** How long the canary watches for a process the project must never have
   * started. Absence is only worth asserting once the lane has had time to
   * betray it. */
  readonly quietDeadlineMs?: number;
  /** How long `project_stop` may take to give the registration back. */
  readonly teardownDeadlineMs?: number;
  /**
   * How long the canary waits for the daemon's poll to cover this project, and
   * then for the Worker that poll justifies.
   *
   * Generous by default: both are timer-driven inside the daemon, so the wait is
   * a poll window plus a demand window and neither belongs to this process.
   */
  readonly demandDeadlineMs?: number;
  /** The unix socket this walk expects `redskilled` to answer on. Named in every
   * start failure, because "restart the daemon" and "fix the lane that stopped
   * asking it" are different repairs and the path is what tells them apart.
   * Absent reads as unresolved rather than as no boundary. */
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
  /** The registration the lane produced, once `project_start` answered. */
  readonly registration?: CanaryRegistration;
  /** The poll the daemon ran over this project, once one covered it. */
  readonly poll?: CanaryHostPoll;
  /** Live workers the canary observed at its high-water mark. On a green walk
   * these are the DAEMON's — every one of them named in its host state. */
  readonly workers: readonly CanaryWorker[];
}

const DEFAULTS = {
  target: 1,
  quietDeadlineMs: 3_000,
  teardownDeadlineMs: 20_000,
  demandDeadlineMs: 60_000,
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

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
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
 * The load-bearing asymmetry lives in `no_project_process`: a registration the
 * daemon acknowledged is NOT permission to have started something as well. The
 * lane is only correct once the project's whole presence on the machine is that
 * record — which is exactly what a fallback launch, quietly restored, would
 * stop being true while every payload still read `registered`.
 *
 * Teardown is unconditional after a successful `project_start` — a canary that
 * leaves a registration behind commits the host to work nobody is watching.
 */
export async function runMcpLaneCanary(
  deps: McpLaneCanaryDeps,
  options: McpLaneCanaryOptions,
): Promise<McpLaneCanaryResult> {
  const target = options.target ?? DEFAULTS.target;
  const quietDeadlineMs = options.quietDeadlineMs ?? DEFAULTS.quietDeadlineMs;
  const teardownDeadlineMs = options.teardownDeadlineMs ?? DEFAULTS.teardownDeadlineMs;
  const demandDeadlineMs = options.demandDeadlineMs ?? DEFAULTS.demandDeadlineMs;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  // One phrase, so every boundary failure routes an operator to the same place.
  const socket = options.socketPath
    ? `the redskilled session socket ${options.socketPath}`
    : "the redskilled session socket (path unresolved)";

  const steps: McpLaneCanaryStepResult[] = [];
  const record = (step: McpLaneCanaryStep, verdict: McpLaneCanaryVerdict, detail: string): void => {
    steps.push({ step, verdict, detail });
  };
  let registration: CanaryRegistration | undefined;
  let poll: CanaryHostPoll | undefined;
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

  /**
   * Watch the daemon's own answer until `ready` accepts it, or go inert saying
   * what never arrived.
   *
   * A daemon that stops answering mid-walk fails HERE rather than at the deadline
   * it would otherwise run out on: "the host went away" and "the host is up and
   * did nothing" are different repairs, and the second one is the only one this
   * lane is a probe for.
   */
  const awaitHost = async (
    step: McpLaneCanaryStep,
    project: string,
    ready: (host: CanaryHostView) => CanaryHostView | null,
    timeoutDetail: string,
  ): Promise<CanaryHostView> => {
    const deadline = deps.now() + demandDeadlineMs;
    for (;;) {
      const host = await deps.observeHost(project);
      if (!host.reachable) {
        inert(step, `the daemon on ${socket} stopped answering mid-walk: ${host.detail ?? "no detail"}`);
      }
      const accepted = ready(host);
      if (accepted !== null) return accepted;
      if (deps.now() >= deadline) inert(step, `${timeoutDetail} (watched for ${demandDeadlineMs}ms)`);
      await deps.sleep(pollMs);
    }
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

    // ---- 2. project_start: the canonical interface accepts the start ----
    // A start that could not reach the host must arrive here as a THROWN tool
    // error, not as a payload: the refusal is the contract (ADR 0130 rule 6),
    // and it is the socket, not the tool, an operator has to go and repair.
    const created = await call("project_start", "project_start", {
      runner: options.runner,
      target,
    });
    const status = created.status;
    if (status !== "registered") {
      inert(
        "project_start",
        `project_start returned status=${JSON.stringify(status)} instead of registered — ` +
          `the lane still launches a process of the project's own instead of registering it with the daemon on ${socket}`,
      );
    }
    record("project_start", "ok", `project_start registered this project with the daemon on ${socket}`);

    try {
      // ---- 3. registration_held: the answer is a real registration ----
      // Only the daemon can mint a project label and a renewal deadline, so a
      // payload carrying them is the walk's proof that the start CROSSED the
      // socket rather than being answered by the MCP server on its own.
      registration = readRegistration(created);
      record(
        "registration_held",
        "ok",
        `the daemon on ${socket} holds project ${registration.project} at target ${registration.target} until ${registration.renewBy}, ` +
          `for selector ${registration.selector} and argv ${registration.argv.join(" ")}`,
      );

      // ---- 4. no_project_process: the start birthed nothing of its own ----
      // The inversion of the old #2677 assertion. Then, a returned pid was not
      // evidence of a worker; now, ANY process this project started is evidence
      // of a fallback launch the host never admitted, never counts and cannot
      // stop — including one dressed in a `registered` payload.
      const pid = readPid(created.pid);
      if (pid !== null) {
        inert(
          "no_project_process",
          `project_start answered registered but handed back pid ${pid}${deps.isLive(pid) ? " and that process is alive" : ""} — ` +
            `the lane launched a process of the project's own behind the registration`,
        );
      }
      // A Worker on disk is not by itself a fault: the daemon's own demand loop
      // births one for this registration, and it lands in the same lane. What is
      // read here is PARENTAGE — a live worker the host does not name is one no
      // admission verdict judged, no host counts and no `project_stop` can end.
      const quietUntil = deps.now() + quietDeadlineMs;
      for (;;) {
        const seen = (await deps.observeWorkers()).filter((worker) => worker.alive);
        const host = await deps.observeHost(registration.project);
        const owned = new Set(host.workers.map((worker) => worker.pid));
        const stray = seen.filter((worker) => worker.pid === null || !owned.has(worker.pid));
        if (stray.length > 0) {
          workers = stray;
          inert(
            "no_project_process",
            `project_start registered this project but ${stray.length} live worker(s) the daemon on ${socket} does not name appeared under it: ` +
              `${stray.map(describe).join("; ")} — a Worker born outside the daemon is an unbudgeted birth no admission verdict ever judged`,
          );
        }
        if (deps.now() >= quietUntil) break;
        await deps.sleep(pollMs);
      }
      record(
        "no_project_process",
        "ok",
        `no process of this project's own appeared within ${quietDeadlineMs}ms — every Worker under this project is one the daemon on ${socket} names`,
      );

      // ---- 5. queue_polled: the daemon counted this project's work ----
      // The registration is a query the project handed over; the poll is the
      // daemon acting on it. Without this step a lane that registered and then
      // sat there forever would read exactly like a lane that drains.
      const polled = await awaitHost(
        "queue_polled",
        registration.project,
        (host) => (host.poll === null ? null : host),
        `the daemon on ${socket} never polled a queue covering project ${registration.project}: a registration nothing counts is ` +
          `a project the host will never birth a Worker for`,
      );
      poll = polled.poll!;
      if (poll.requestCount !== 1) {
        inert(
          "queue_polled",
          `the poll covering project ${registration.project} cost ${poll.requestCount} requests — ADR 0130 Amendment 3 batches every ` +
            `registered project into ONE aliased request per interval, and a count above one is the per-project shape it replaced`,
        );
      }
      record(
        "queue_polled",
        "ok",
        `the daemon on ${socket} covered project ${registration.project} in one request at ${poll.at}: ${poll.detail}`,
      );

      // ---- 6. worker_born: the host acted on what it counted ----
      // The end of the lane, and the only step that proves the two players
      // actually met: a registration the MCP made, a queue the daemon polled, and
      // a process the daemon started because of both.
      const born = await awaitHost(
        "worker_born",
        registration.project,
        (host) => (host.workers.length > 0 ? host : null),
        `the daemon on ${socket} counted ${poll.depth ?? "no"} item(s) for project ${registration.project} and never birthed a Worker — ` +
          `the lane registers and polls but the demand loop is inert`,
      );
      const onDisk = (await deps.observeWorkers()).filter((worker) => worker.alive);
      const bornPids = new Set(born.workers.map((worker) => worker.pid));
      workers = onDisk.filter((worker) => worker.pid !== null && bornPids.has(worker.pid));
      const missing = born.workers.filter((worker) => !deps.isLive(worker.pid));
      if (missing.length > 0) {
        inert(
          "worker_born",
          `the daemon on ${socket} reports Worker(s) ${missing.map((worker) => `${worker.workerId} (pid=${worker.pid})`).join(", ")} ` +
            `for project ${registration.project}, and no such process is running — the host's answer and the machine disagree`,
        );
      }
      record(
        "worker_born",
        "ok",
        `the daemon on ${socket} birthed ${born.workers.length} Worker(s) for project ${registration.project}: ` +
          `${born.workers.map((worker) => `${worker.workerId} (pid=${worker.pid})`).join(", ")}`,
      );

      // ---- 7. project_status: the canonical reader agrees the project runs
      // no process of its own ----
      const observedStatus = await call("project_status", "project_status", {});
      const supervisor = asRecord(observedStatus.supervisor);
      const reportedPid = supervisor ? readPid(supervisor.pid) : null;
      if (supervisor && readBool(supervisor.alive)) {
        inert(
          "project_status",
          `project_status reports supervisor pid ${reportedPid ?? "none"} alive after a registration — ` +
            `the lane's reader can still see a per-project process the start was supposed to have stopped creating`,
        );
      }
      const busy = readCount(asRecord(observedStatus.slots)?.busy);
      if (busy > 0) {
        inert(
          "project_status",
          `project_status reports slots.busy=${busy} while this project started nothing — the lane's reader and writer disagree`,
        );
      }
      record("project_status", "ok", "project_status answers with no per-project supervisor and no busy slot");
    } finally {
      // ---- 8. project_stop: give the registration back, always ----
      // Nothing thrown here may mask the walk's own verdict, so the teardown
      // reports its failure as a step rather than as an exception.
      try {
        steps.push(await stopProject());
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
      ? "MCP lane canary green: project_start → a registration the daemon holds → no process of the project's own → one poll covering it → " +
        "a Worker the daemon birthed → project_status → project_stop all answered"
      : `MCP lane canary FAILED — the ${resolvedInert} step went inert: ${
        steps.find((entry) => entry.step === resolvedInert)?.detail ?? "no detail"
      }`,
    ...(registration ? { registration } : {}),
    ...(poll ? { poll } : {}),
    workers,
  };

  /**
   * Read the registration out of the start payload.
   *
   * Every field is required and none is repaired: a start that answered without
   * the argv the host will run, or without the selector it was given, has not
   * registered this project — it has agreed to something else. The selector and
   * the argv are read VERBATIM (ADR 0130 rule 3): the canary asserts they came
   * back, never what they should say.
   */
  function readRegistration(payload: Record<string, unknown>): CanaryRegistration {
    const project = readText(payload.project);
    if (project === "") {
      inert(
        "registration_held",
        `project_start answered registered but named no project (payload: ${JSON.stringify(payload)}) — ` +
          `only the daemon mints that label, so nothing here proves the start reached ${socket}`,
      );
    }
    const renewBy = readText(payload.renew_by);
    if (renewBy === "") {
      inert(
        "registration_held",
        `the registration for ${project} carries no renewal deadline — a record that never lapses outlives the session that asked for it`,
      );
    }
    const selector = readText(payload.selector);
    if (selector === "") {
      inert(
        "registration_held",
        `the registration for ${project} carries no selector — a project registered against no work at all is a target the host can never fill`,
      );
    }
    const argv = Array.isArray(payload.argv) ? payload.argv.map(readText) : [];
    if (argv.length === 0 || argv.some((entry) => entry === "")) {
      inert(
        "registration_held",
        `the registration for ${project} carries no argv (payload: ${JSON.stringify(payload.argv)}) — ` +
          `the host would hold a target it has no way to fill`,
      );
    }
    if (!argv.includes("run")) {
      inert(
        "registration_held",
        `the registration for ${project} carries an argv that never routes \`run\`: ${argv.join(" ")} — ` +
          `the #2677 shape, moved one process out: the host would birth Workers that boot into nothing`,
      );
    }
    return {
      project,
      target: readCount(payload.target),
      selector,
      argv,
      renewBy,
    };
  }

  /** Give the registration back, and CONFIRM the daemon released it. */
  async function stopProject(): Promise<McpLaneCanaryStepResult> {
    if (registration === undefined) {
      return {
        step: "project_stop",
        verdict: "skipped",
        detail: "nothing was registered, so there is nothing to give back",
      };
    }
    const project = registration.project;
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
    if (!readBool(stopped.deregistered)) {
      return {
        step: "project_stop",
        verdict: "inert",
        detail:
          `project_stop answered ${JSON.stringify(stopped.status)} without deregistering ${project} on ${socket} — ` +
          `a project that cannot be put down keeps its target claimed against the host forever ` +
          // The tool's own words for why, verbatim: a teardown that failed for a
          // reason the payload states and the report drops is one an operator has
          // to reproduce before they can even start reading it.
          `(payload: ${JSON.stringify(stopped)})`,
      };
    }
    const deadline = deps.now() + teardownDeadlineMs;
    for (;;) {
      const remaining = (await deps.observeWorkers()).filter((worker) => worker.alive);
      if (remaining.length === 0) {
        return {
          step: "project_stop",
          verdict: "ok",
          detail: `project_stop gave back the registration for ${project} and left nothing running`,
        };
      }
      if (deps.now() >= deadline) {
        return {
          step: "project_stop",
          verdict: "inert",
          detail: `project_stop deregistered ${project} but ${remaining.map(describe).join(", ")} survived ${teardownDeadlineMs}ms`,
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
    ...(result.registration
      ? {
        registration: {
          project: result.registration.project,
          target: result.registration.target,
          selector: result.registration.selector,
          argv: [...result.registration.argv],
          renew_by: result.registration.renewBy,
        },
      }
      : {}),
    ...(result.poll
      ? {
        poll: {
          at: result.poll.at,
          outcome: result.poll.outcome,
          depth: result.poll.depth ?? -1,
          request_count: result.poll.requestCount,
        },
      }
      : {}),
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
