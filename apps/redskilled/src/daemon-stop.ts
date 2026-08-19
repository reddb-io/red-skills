/**
 * daemon-stop — what a stop is holding, what survives it, and why it happened.
 *
 * **Stop is something you ask for, not something you signal.** A hand-sent
 * `SIGTERM` ends the same process, and that is the whole of what it can do: it
 * cannot say what the daemon was holding, cannot be declined, and leaves the
 * successor unable to tell a planned handover from a death. This module is the
 * report a stop answers with, built as a pure function of the daemon's own facts
 * so the CLI, the wire and the event lane all state the same thing.
 *
 * **Every Worker survives a stop, and the report says so out loud.** Workers are
 * init-system units (ADR 0130 rule 5) and the unisolated fallback is launched
 * detached, so the daemon leaving is a restart and never an evacuation. An
 * operator replacing a daemon needs that stated rather than assumed — the whole
 * reason to ask instead of signalling is to be told what one is about to do.
 *
 * PURE: every input is passed in.
 */
import type { RedskilledWorkerView } from "./host-state.js";

/**
 * Why a daemon stopped. A closed list, because it is the fact a successor reads.
 *
 * `not-running` is a verdict about the request rather than about a process: it is
 * how "there was nothing to stop" arrives as an answer instead of as an error.
 */
export type RedskilledStopReason =
  | "requested"
  | "signal"
  | "replaced"
  | "unreachable"
  | "not-running";

/** One Worker the daemon is holding at the moment it is asked to stop. */
export interface RedskilledStopWorkerView {
  readonly worker_id: string;
  readonly project_label: string;
  readonly pid: number;
  /** The transient unit's name; `null` when the launch was unisolated. */
  readonly unit: string | null;
  readonly isolated: boolean;
  /** True when the host keeps the surviving Worker inside its own resource scope. */
  readonly contained: boolean;
  /** True when this Worker outlives the daemon — every Worker does today. */
  readonly survives: boolean;
}

/**
 * The answer to a stop, whether or not there was a daemon to stop.
 *
 * `running` and `stopped` are two facts, never collapsed: a daemon that was not
 * running is a success with a stated reason (nothing to do), and a daemon that
 * declined would be running and not stopped. A single boolean would make those
 * two indistinguishable from each other and from a fault.
 */
export interface RedskilledDaemonStopped {
  readonly version: 1;
  /** True when a daemon was answering or a live holder owned the socket. */
  readonly running: boolean;
  /** True when that daemon accepted the stop. */
  readonly stopped: boolean;
  readonly reason: RedskilledStopReason;
  readonly socket_path: string;
  /** The stopping daemon's version; `null` when absent or unreachable. */
  readonly daemon_version: string | null;
  /** The stopping daemon's pid; `null` when none was running. */
  readonly pid: number | null;
  readonly holding: {
    readonly workers: readonly RedskilledStopWorkerView[];
    readonly projects: readonly string[];
  };
  /** The Worker ids that outlive this stop — the operator's actual exposure. */
  readonly surviving: readonly string[];
  readonly detail: string;
}

export interface BuildRedskilledStopReportInput {
  readonly reason: RedskilledStopReason;
  readonly socketPath: string;
  readonly daemonVersion: string;
  readonly pid: number;
  readonly workers: readonly RedskilledWorkerView[];
  /** Extra project labels to name as held — registrations without a Worker. */
  readonly projects?: readonly string[];
}

/** The report a running daemon answers a stop with. PURE. */
export function buildRedskilledStopReport(input: BuildRedskilledStopReportInput): RedskilledDaemonStopped {
  const workers = input.workers.map(toStopWorkerView);
  const projects = [...new Set([...workers.map((worker) => worker.project_label), ...(input.projects ?? [])])]
    .filter((label) => label !== "")
    .sort();
  const surviving = workers.filter((worker) => worker.survives).map((worker) => worker.worker_id);
  return {
    version: 1,
    running: true,
    stopped: true,
    reason: input.reason,
    socket_path: input.socketPath,
    daemon_version: input.daemonVersion,
    pid: input.pid,
    holding: { workers, projects },
    surviving,
    detail: describeStop({
      reason: input.reason,
      socketPath: input.socketPath,
      daemonVersion: input.daemonVersion,
      pid: input.pid,
      held: workers.length,
      projects: projects.length,
      surviving: surviving.length,
      uncontained: workers.filter((worker) => worker.survives && !worker.contained).length,
    }),
  };
}

/**
 * The report for a socket nobody is answering on. PURE.
 *
 * A success, deliberately: the operator asked for a machine with no daemon on it
 * and that is the machine they have. Erroring here would make "stop it" a command
 * one has to check the state before running, which is the hand-work the command
 * exists to remove.
 */
export function buildRedskilledNotRunningStop(socketPath: string): RedskilledDaemonStopped {
  return {
    version: 1,
    running: false,
    stopped: false,
    reason: "not-running",
    socket_path: socketPath,
    daemon_version: null,
    pid: null,
    holding: { workers: [], projects: [] },
    surviving: [],
    detail: `no redskilled daemon is answering on ${JSON.stringify(socketPath)}, so there was nothing to stop`,
  };
}

/**
 * The report for a live socket holder that could not answer its own stop verb.
 *
 * The holder cannot describe its Workers or version, so those facts stay empty
 * rather than being guessed. `running` still records the process fact that
 * licensed the signal, while `stopped` records the independent settle check.
 */
export function buildRedskilledUnreachableStop(input: {
  readonly socketPath: string;
  readonly pid: number;
  readonly stopped: boolean;
  readonly pending?: readonly string[];
}): RedskilledDaemonStopped {
  const outcome = input.stopped
    ? "SIGTERM stopped that holder and released the socket"
    : `SIGTERM was sent, but the holder did not finish stopping${
      input.pending == null || input.pending.length === 0 ? "" : `: ${input.pending.join(", ")}`
    }`;
  return {
    version: 1,
    running: true,
    stopped: input.stopped,
    reason: "unreachable",
    socket_path: input.socketPath,
    daemon_version: null,
    pid: input.pid,
    holding: { workers: [], projects: [] },
    surviving: [],
    detail:
      `redskilled pid ${input.pid} was alive and held ${JSON.stringify(input.socketPath)}, but it did not answer ` +
      `a ping, so stop signalled it directly; ${outcome}. Its held Workers and version could not be read`,
  };
}

/** The Worker as a stop reports it. PURE. */
function toStopWorkerView(worker: RedskilledWorkerView): RedskilledStopWorkerView {
  return {
    worker_id: worker.worker_id,
    project_label: worker.project_label,
    pid: worker.pid,
    unit: worker.unit ?? null,
    isolated: worker.isolated,
    contained: worker.isolated,
    // Isolated Workers belong to the init system and unisolated ones are launched
    // detached, so neither is a child this process can take with it.
    survives: true,
  };
}

/** Why a daemon stopped, as one sentence. PURE. */
export function describeRedskilledStopReason(reason: RedskilledStopReason): string {
  if (reason === "requested") return "an operator asked for it";
  if (reason === "signal") return "the daemon was signalled";
  if (reason === "replaced") return "a newer published bundle is taking the session over";
  if (reason === "unreachable") return "the daemon held the socket but could not be reached";
  return "no daemon was running";
}

function describeStop(input: {
  readonly reason: RedskilledStopReason;
  readonly socketPath: string;
  readonly daemonVersion: string;
  readonly pid: number;
  readonly held: number;
  readonly projects: number;
  readonly surviving: number;
  readonly uncontained: number;
}): string {
  const head = `stopping the redskilled daemon (pid ${input.pid}, version ${input.daemonVersion}) on ` +
    `${JSON.stringify(input.socketPath)}: ${describeRedskilledStopReason(input.reason)}`;
  if (input.held === 0) return `${head}; it holds no Workers, so nothing survives the stop`;
  return `${head}; it holds ${count(input.held, "Worker")} across ${count(input.projects, "project")}, and ` +
    `${input.surviving} of them survive it — ${count(input.uncontained, "uncontained survivor")} ` +
    `${input.uncontained === 1 ? "runs" : "run"} as detached process groups outside an init-system unit`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function isRedskilledDaemonStopped(value: unknown): value is RedskilledDaemonStopped {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const stopped = value as Record<string, unknown>;
  const holding = stopped.holding as { workers?: unknown; projects?: unknown } | undefined;
  return stopped.version === 1 &&
    typeof stopped.running === "boolean" &&
    typeof stopped.stopped === "boolean" &&
    typeof stopped.reason === "string" &&
    typeof stopped.socket_path === "string" &&
    typeof stopped.detail === "string" &&
    (stopped.daemon_version === null || typeof stopped.daemon_version === "string") &&
    (stopped.pid === null || typeof stopped.pid === "number") &&
    holding != null &&
    Array.isArray(holding.workers) &&
    holding.workers.every((worker) =>
      worker != null &&
      typeof worker === "object" &&
      !Array.isArray(worker) &&
      typeof (worker as Record<string, unknown>).contained === "boolean"
    ) &&
    Array.isArray(holding.projects) &&
    Array.isArray(stopped.surviving);
}
