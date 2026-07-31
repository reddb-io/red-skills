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
 * parse a rendered line and never needs a private source. `statusline-string` is
 * the same answer already rendered, and it widens the contract by exactly one
 * string because the alternative is every agent host reimplementing the line —
 * which is the drift the pair of ops exists to prevent (ADR 0130 rule 10). The
 * daemon renders it from the very payload the other op returns, so the two can
 * disagree only if a pure function is impure. `worker-heartbeat` widens it by one
 * more string, in the one direction the daemon has no other way to learn: the
 * Worker's own last logged line. It is stored and echoed, never parsed — transport
 * is not semantics — which is what keeps the verbose statusline one read and keeps
 * the daemon ignorant of where a project's logs live. `worker-command`
 * carries the commanding verbs — stop, recycle, steer — as data rather than as
 * three ops, so the reach rule is decided once for all of them.
 *
 * `project-register` widens the contract by a query string and no further (ADR
 * 0130 Amendment 4). A project contributes a registration rather than a process,
 * and the two strings it carries — a selector and an argv — are opaque in exactly
 * the sense a Worker's last logged line already is: stored, echoed, never read.
 * The daemon still does not know what an Issue, a label, a Spec, a gate or a
 * Landing is, which is what keeps this a frozen surface rather than a growing one.
 * `project-deregister` widens it by nothing at all: it names a project the daemon
 * already keys registrations by, and takes the record back out.
 *
 * **Every request may name the project its session belongs to.** That single
 * opaque string is what makes reach asymmetric (ADR 0130 rule 9): a session reads
 * the whole host and writes only its own project.
 */
import { sendLineRequest } from "@reddb-io/shared/resident-core.js";
import { isRedskilledAdmissionVerdict, type RedskilledAdmissionVerdict } from "./admission.js";
import { isRedskilledWorkerView, type RedskilledHostState, type RedskilledWorkerView } from "./host-state.js";
import {
  isRedskilledProjectRegistration,
  type RedskilledProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "./project-registration.js";
import { isRedskilledReachVerdict, type RedskilledReachVerdict, type RedskilledWorkerCommandName } from "./session-reach.js";
import { isRedskilledStatuslinePayload, type RedskilledStatuslinePayload } from "./statusline-payload.js";
import type { RedskilledStatuslineMode, RedskilledStatuslineRender } from "./statusline-render.js";
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

/**
 * How one statusline read wants to be rendered.
 *
 * Every field is optional and every one is a decided value: the client resolves
 * config and flags before it asks, because the daemon must never learn what a
 * `.red/config.yaml` is (ADR 0130 rule 3). What travels here is taste already
 * settled, never a place to go and look it up.
 */
export interface RedskilledStatuslineRenderRequest {
  readonly mode?: RedskilledStatuslineMode;
  readonly project?: string | null;
  readonly max_workers?: number;
  readonly max_projects?: number;
  readonly max_width?: number;
  /** Ask for the second line per Worker: the last line each one logged. */
  readonly verbose?: boolean;
}

/**
 * One Worker publishing its own last logged line.
 *
 * `last_log_line` is opaque: the daemon checks that it is a string and stores it,
 * and nothing in this process ever reads it for meaning. The alternative — a
 * statusline reading each Worker's log itself — would cost a disk read per Worker
 * per render, cross a project boundary, and give every surface a private source
 * to contradict the daemon with.
 */
export interface RedskilledWorkerHeartbeatRequest {
  readonly worker_id: string;
  readonly last_log_line: string;
  readonly session_project?: string;
}

export type RedskilledRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "host-state" }
  | { id: string; op: "statusline-payload"; session_project?: string }
  | { id: string; op: "statusline-string"; session_project?: string; render?: RedskilledStatuslineRenderRequest }
  | { id: string; op: "worker-start"; spec: RedskilledWorkerSpec; session_project?: string }
  | { id: string; op: "worker-command"; command: RedskilledWorkerCommandRequest }
  | { id: string; op: "worker-heartbeat"; heartbeat: RedskilledWorkerHeartbeatRequest }
  | { id: string; op: "project-register"; registration: RedskilledProjectRegistrationRequest; session_project?: string }
  | { id: string; op: "project-deregister"; project_label: string; session_project?: string }
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

/**
 * The answer to a permitted heartbeat.
 *
 * `accepted` is false — not an error — when the daemon holds no such live Worker:
 * a Worker whose death the daemon observed a moment before its last heartbeat
 * landed is a race, not a fault, and a publisher must not treat it as one.
 */
export interface RedskilledWorkerHeartbeatAck {
  readonly version: 1;
  readonly worker_id: string;
  readonly accepted: boolean;
  readonly reach: RedskilledReachVerdict;
  /** When the daemon recorded the line; `null` when it recorded nothing. */
  readonly published_at: string | null;
  readonly detail: string;
}

export function isRedskilledWorkerHeartbeatAck(value: unknown): value is RedskilledWorkerHeartbeatAck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ack = value as Record<string, unknown>;
  return ack.version === 1 &&
    typeof ack.worker_id === "string" &&
    typeof ack.accepted === "boolean" &&
    typeof ack.detail === "string" &&
    (ack.published_at === null || typeof ack.published_at === "string") &&
    isRedskilledReachVerdict(ack.reach);
}

/**
 * The answer to an accepted `project-register`.
 *
 * A refusal never arrives here — a duplicate registration and a cross-project one
 * both come back as errors carrying their own sentence — so a caller holding this
 * value holds a record the daemon is keeping, never a maybe.
 */
export interface RedskilledProjectRegistered {
  readonly version: 1;
  readonly registration: RedskilledProjectRegistration;
  readonly reach: RedskilledReachVerdict;
  readonly detail: string;
}

export function isRedskilledProjectRegistered(value: unknown): value is RedskilledProjectRegistered {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const registered = value as Record<string, unknown>;
  return registered.version === 1 &&
    typeof registered.detail === "string" &&
    isRedskilledProjectRegistration(registered.registration) &&
    isRedskilledReachVerdict(registered.reach);
}

/**
 * The answer to a permitted `project-deregister`.
 *
 * `released` is false — not an error — when the daemon held no registration for
 * that project. Work is stopped by an operator and again by a session ending, and
 * a client that had to tell "already released" from a real failure would either
 * retry a no-op forever or swallow a refusal it needed to see.
 */
export interface RedskilledProjectDeregistered {
  readonly version: 1;
  readonly project_label: string;
  readonly released: boolean;
  readonly reach: RedskilledReachVerdict;
  readonly detail: string;
}

export function isRedskilledProjectDeregistered(value: unknown): value is RedskilledProjectDeregistered {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const released = value as Record<string, unknown>;
  return released.version === 1 &&
    typeof released.project_label === "string" &&
    typeof released.released === "boolean" &&
    typeof released.detail === "string" &&
    isRedskilledReachVerdict(released.reach);
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

/**
 * True when `value` is a rendered statusline.
 *
 * The line alone would have been enough to print, and is not enough to trust: a
 * consumer that could not tell a degraded line from a full one, or a stale one
 * from a current one, would have to read those facts back out of the text.
 */
export function isRedskilledStatuslineRender(value: unknown): value is RedskilledStatuslineRender {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const render = value as Record<string, unknown>;
  return render.version === 1 &&
    typeof render.line === "string" &&
    Array.isArray(render.lines) &&
    render.lines.every((line) => typeof line === "string") &&
    typeof render.verbose === "boolean" &&
    (render.mode === "local" || render.mode === "global") &&
    (render.project === null || typeof render.project === "string") &&
    typeof render.detail === "string" &&
    typeof render.degraded === "boolean" &&
    typeof render.stale === "boolean" &&
    typeof render.generated_at === "string";
}

/** True when `value` is a complete payload — re-exported so a client checks one surface. */
export { isRedskilledStatuslinePayload };

export type {
  RedskilledAdmissionVerdict,
  RedskilledHostState,
  RedskilledProjectRegistration,
  RedskilledProjectRegistrationRequest,
  RedskilledReachVerdict,
  RedskilledStatuslineMode,
  RedskilledStatuslinePayload,
  RedskilledStatuslineRender,
  RedskilledWorkerCommandName,
  RedskilledWorkerView,
  RedskilledWorkerSpec,
};
