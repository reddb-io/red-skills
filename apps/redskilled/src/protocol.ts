/**
 * protocol — the `redskilled` wire contract.
 *
 * ADR 0130 rule 3: **the contract is minimal and frozen.** That is what lets one
 * daemon serve checkouts pinned to different bundle versions — version skew
 * stops being managed and stops existing. So every addition here is a deliberate
 * widening of a frozen surface, not a convenience: the daemon carries no castle
 * semantics, and an op that needed to know what a Ticket or a Gate is would
 * belong to the per-project bundle instead.
 *
 * `ping` and `host-state` make the daemon reachable and honest about its own
 * life. `worker-start` is the one op that changes the machine, and it stays
 * inside rule 3 by taking the whole launch as data: an argv, a placement target,
 * a budget, and two opaque strings — a project label and a workspace path. There
 * is no repository, ticket or runner in this contract, so there is nothing here
 * for a version-skewed client to disagree with the daemon about.
 *
 * `statusline-payload` is the second read, and it widens nothing the daemon does
 * not already own: it is the host-wide Worker set the daemon holds anyway, dated
 * by the daemon's own sampler, so a surface that needs structure never has to
 * parse a rendered line and never needs a private source. `worker-command`
 * carries the commanding verbs — stop, recycle, steer — as data rather than as
 * three ops, so the reach rule is decided once for all of them.
 *
 * **Every request may name the project its session belongs to.** That single
 * opaque string is what makes reach asymmetric (ADR 0130 rule 9): a session reads
 * the whole host and writes only its own project.
 */
import { sendLineRequest } from "@reddb-io/shared/resident-core.js";
import { isRedskilledAdmissionVerdict, type RedskilledAdmissionVerdict } from "./admission.js";
import { isRedskilledWorkerView, type RedskilledHostState, type RedskilledWorkerView } from "./host-state.js";
import { isRedskilledReachVerdict, type RedskilledReachVerdict, type RedskilledWorkerCommandName } from "./session-reach.js";
import { isRedskilledStatuslinePayload, type RedskilledStatuslinePayload } from "./statusline-payload.js";
import type { RedskilledWorkerSpec } from "./worker-launch.js";

/** The wire version. A daemon states it; a client that cannot read it must not proceed. */
export const REDSKILLED_PROTOCOL_VERSION = 1;

/**
 * One commanding verb, aimed at one Worker, from one session.
 *
 * `session_project` rides on the command rather than on the connection because
 * the daemon holds no session state: a client that reconnects per request must
 * not lose the one fact its reach is decided on.
 */
export interface RedskilledWorkerCommandRequest {
  readonly command: RedskilledWorkerCommandName;
  readonly worker_id: string;
  readonly session_project?: string;
  /** Free-form, opaque to the daemon; recorded with the act, never interpreted. */
  readonly detail?: string;
}

export type RedskilledRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "host-state" }
  | { id: string; op: "statusline-payload"; session_project?: string }
  | { id: string; op: "worker-start"; spec: RedskilledWorkerSpec; session_project?: string }
  | { id: string; op: "worker-command"; command: RedskilledWorkerCommandRequest }
  | { id: string; op: "shutdown" };

export type RedskilledResponse =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string };

export interface RedskilledPong {
  readonly pong: true;
  readonly protocol_version: number;
  readonly daemon_version: string;
  readonly pid: number;
}

/**
 * The answer to `worker-start`.
 *
 * `warnings` is part of the success reply, not an error channel: a Worker that
 * started without isolation is running and is a downgrade at the same time, and
 * collapsing that into ok/failed would lose whichever half the reader needed.
 */
export interface RedskilledWorkerStarted {
  readonly worker: RedskilledWorkerView;
  /**
   * The host-wide verdict that allowed this birth.
   *
   * It rides on the success reply, not only on a refusal: a caller that can read
   * the ceiling and the machine's current consumption off its own admitted
   * request never has to ask a second question to know how much room is left.
   */
  readonly admission: RedskilledAdmissionVerdict;
  readonly warnings: readonly string[];
}

export function isRedskilledWorkerStarted(value: unknown): value is RedskilledWorkerStarted {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const started = value as Record<string, unknown>;
  return Array.isArray(started.warnings) &&
    isRedskilledWorkerView(started.worker) &&
    isRedskilledAdmissionVerdict(started.admission);
}

/**
 * The answer to a permitted `worker-command`.
 *
 * A refusal never arrives here: reach is decided before the mechanism runs, and a
 * refused command comes back as an error carrying the verdict's own sentence, so
 * a caller can neither mistake it for a no-op nor learn from it what another
 * project is running.
 */
export interface RedskilledWorkerCommandResult {
  readonly version: 1;
  readonly command: RedskilledWorkerCommandName;
  readonly worker_id: string;
  /** True when the daemon carried the command out. */
  readonly applied: boolean;
  readonly reach: RedskilledReachVerdict;
  readonly detail: string;
}

export function isRedskilledWorkerCommandResult(value: unknown): value is RedskilledWorkerCommandResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.version === 1 &&
    typeof result.command === "string" &&
    typeof result.worker_id === "string" &&
    typeof result.applied === "boolean" &&
    typeof result.detail === "string" &&
    isRedskilledReachVerdict(result.reach);
}

export interface RedskilledClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

/** One request, one response — errors surface as thrown, never as a silent default. */
export async function sendRedskilledRequest(
  opts: RedskilledClientOptions,
  request: RedskilledRequest,
): Promise<RedskilledResponse> {
  return await sendLineRequest<RedskilledRequest, RedskilledResponse>(opts, request, "redskilled daemon");
}

export function isRedskilledPong(value: unknown): value is RedskilledPong {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const pong = value as Record<string, unknown>;
  return pong.pong === true &&
    typeof pong.protocol_version === "number" &&
    typeof pong.daemon_version === "string" &&
    Number.isInteger(pong.pid);
}

/** True when `value` is a complete payload — re-exported so a client checks one surface. */
export { isRedskilledStatuslinePayload };

export type {
  RedskilledAdmissionVerdict,
  RedskilledHostState,
  RedskilledReachVerdict,
  RedskilledStatuslinePayload,
  RedskilledWorkerCommandName,
  RedskilledWorkerView,
  RedskilledWorkerSpec,
};
