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
 * disagree only if a pure function is impure. `statusline-dashboard` is the third
 * of that family and widens the contract by no new FACT at all: it is the same
 * payload rendered with a vertical dimension, for the surfaces that have one — a
 * herdr pane and an editor panel. It is here rather than in each surface for the
 * reason `statusline-string` is: two surfaces doing their own Worker math are two
 * dashboards that lie in two different ways about one instant. `worker-heartbeat`
 * widens it by one more string, in the one direction the daemon has no other way
 * to learn: the Worker's own last logged line — and, since #3012, by one opaque
 * DISPLAY RECORD beside it. That record is stored and laid out, never read: the
 * pipeline bar is drawn from two integers a project published, so the daemon
 * reaches statusline parity without ever learning what a phase is. It is stored and echoed, never parsed — transport
 * is not semantics — which is what keeps the verbose statusline one read and keeps
 * the daemon ignorant of where a project's logs live. `worker-command`
 * carries the commanding verbs — stop, recycle, steer — as data rather than as
 * three ops, so the reach rule is decided once for all of them.
 *
 * `project-register` widens the contract by a query string and its typed REST
 * polling equivalent (ADR 0130 Amendment 4, ADR 0133). The project understands
 * selector facets and authors both; the daemon stores and passes them to their
 * transports without deriving either. The selector and argv remain opaque in
 * exactly the sense a Worker's last logged line already is: stored, echoed, never
 * read. The daemon still does not know what an Issue, a label, a Spec, a gate or
 * a Landing is, which keeps this a frozen transport surface rather than semantics.
 * `project-deregister` widens it by nothing at all: it names a project the daemon
 * already keys registrations by, and takes the record back out. `project-renew`
 * names that same project and obliges a client to state nothing further, because
 * a renewal is a session saying "I am still here" rather than a second chance to
 * restate what work it wants. It carries ONE optional field: the launch, which a
 * project may restate because a runner, a model tier and a slot-scoped env are
 * decided per birth and one frozen argv cannot express them (Amendment 5). That
 * field is opaque in the same sense the registered argv already is — stored,
 * expanded with the daemon's own facts, never read.
 *
 * `shutdown` is the daemon's own life rather than any project's, and it answers
 * with a REPORT rather than an acknowledgement: what the daemon is holding and
 * what survives its departure. That is the whole difference between asking a
 * daemon to stop and signalling its pid — a signal ends the same process and can
 * state nothing about what it was carrying (#2919).
 *
 * **Every request may name the project its session belongs to.** That single
 * opaque string is what makes reach asymmetric (ADR 0130 rule 9): a session reads
 * the whole host and writes only its own project.
 */
import { sendLineRequest } from "@reddb-io/shared/resident-core.js";
import { isRedskilledAdmissionVerdict, type RedskilledAdmissionVerdict } from "./admission.js";
import {
  isRedskilledDaemonStopped,
  type RedskilledDaemonStopped,
  type RedskilledStopReason,
} from "./daemon-stop.js";
import { isRedskilledWorkerView, type RedskilledHostState, type RedskilledWorkerView } from "./host-state.js";
import type { RedskilledLaunchTemplate } from "./launch-template.js";
import type { RedskilledReapExecution } from "./orphan-reaper.js";
import {
  isRedskilledProjectRegistration,
  type RedskilledProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "./project-registration.js";
import { isRedskilledReachVerdict, type RedskilledReachVerdict, type RedskilledWorkerCommandName } from "./session-reach.js";
import type {
  RedskilledMetricsWindow,
  RedskilledMetricValue,
  RedskilledMetricWindowName,
  RedskilledStatuslineMetrics,
  RedskilledUsageShare,
  RedskilledUsageShares,
} from "./live-metrics.js";
import {
  isRedskilledStatuslinePayload,
  type RedskilledStatuslineExtrasRequest,
  type RedskilledStatuslinePayload,
} from "./statusline-payload.js";
import type { RedskilledStatuslineMode, RedskilledStatuslineRender } from "@reddb-io/redskilled-render";
import { isRedskilledDashboard, type RedskilledDashboard } from "@reddb-io/redskilled-render";
import type { RedskilledWorkerDisplay } from "./worker-display.js";
import type { RedskilledWorkerSpec } from "./worker-launch.js";
import type { RedskilledResourceLease, RedskilledResourceLeaseRequest } from "./resource-lease.js";

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
  /**
   * What a surface should SHOW about this Worker, as its project says it.
   *
   * Opaque in exactly the sense `last_log_line` is: the daemon shape-checks the
   * record, stores it and lays it out, and nothing in this process ever asks what
   * a phase, an origin or an issue number MEANS. It is the frozen contract's one
   * concession to dashboard parity — a project that published nothing simply has
   * a row of absences, which is the honest render, not a broken one.
   */
  readonly display?: RedskilledWorkerDisplay;
  /**
   * A completed generated-surface cure, already classified by the project.
   *
   * This is deliberately the only work-semantic event the host accepts: ADR
   * 0138 names mechanical heals as a daemon-log fact, while the daemon still
   * does not interpret arbitrary Worker narration or castle kinds.
   */
  readonly mechanical_heal?: RedskilledMechanicalHealStamp;
  readonly session_project?: string;
}

/** Stable wire stamp for a mechanically proved stale-base cure. */
export interface RedskilledMechanicalHealStamp {
  readonly heal_kind: "mechanical-regeneration";
  readonly cause: string;
  readonly cycle: number;
  readonly cap: number;
  readonly free: boolean;
}

/**
 * How one dashboard read wants to be rendered.
 *
 * Taste already settled by the client, exactly as
 * {@link RedskilledStatuslineRenderRequest} carries it: `max_rows` is a table's
 * version of `max_workers`, because a pane has a height where a line has none.
 */
export interface RedskilledDashboardRenderRequest {
  readonly mode?: RedskilledStatuslineMode;
  readonly project?: string | null;
  readonly max_width?: number;
  readonly max_rows?: number;
  readonly max_height?: number;
  readonly show_death_details?: boolean;
}

export type RedskilledRequest =
  | { id: string; op: "ping"; self?: true }
  | { id: string; op: "host-state" }
  | { id: string; op: "reap"; report?: boolean }
  | { id: string; op: "statusline-payload"; session_project?: string; extras?: RedskilledStatuslineExtrasRequest }
  | { id: string; op: "statusline-string"; session_project?: string; render?: RedskilledStatuslineRenderRequest }
  | { id: string; op: "statusline-dashboard"; session_project?: string; dashboard?: RedskilledDashboardRenderRequest }
  | { id: string; op: "worker-start"; spec: RedskilledWorkerSpec; session_project?: string }
  | { id: string; op: "worker-command"; command: RedskilledWorkerCommandRequest }
  | { id: string; op: "worker-heartbeat"; heartbeat: RedskilledWorkerHeartbeatRequest }
  | { id: string; op: "resource-acquire"; request: RedskilledResourceLeaseRequest }
  | { id: string; op: "resource-renew"; lease_id: string; ttl_ms?: number }
  | { id: string; op: "resource-release"; lease_id: string }
  | { id: string; op: "project-register"; registration: RedskilledProjectRegistrationRequest; session_project?: string }
  | {
    id: string;
    op: "project-renew";
    project_label: string;
    renew_within_ms?: number;
    /** What the NEXT Worker is started with; the standing launch when absent. */
    launch?: RedskilledLaunchTemplate;
    session_project?: string;
  }
  | { id: string; op: "project-deregister"; project_label: string; session_project?: string }
  | {
    id: string;
    op: "project-reset";
    project_label: string;
    latch: "project-birth-breaker";
    session_project?: string;
  }
  // `detail` is the operator's own words for WHY — opaque to the daemon, recorded
  // with the stop on the event lane so the successor inherits the intent and not
  // just the fact (#2919).
  | { id: string; op: "shutdown"; detail?: string };

export type RedskilledResponse =
  | { id: string; ok: true; value: unknown }
  // `id: null` is the one failure shape a PARSED request without a usable id
  // may wear: a fresh string id is reserved as the rule-3 proof that the frame
  // was never parsed at all (`isUnintelligibleResponse`), and an ordinary
  // handler failure must never be able to counterfeit it.
  | { id: string | null; ok: false; error: string };

export interface RedskilledResourceLeaseReleased {
  readonly version: 1;
  readonly lease_id: string;
  readonly released: boolean;
}

export function isRedskilledResourceLeaseReleased(value: unknown): value is RedskilledResourceLeaseReleased {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const released = value as Record<string, unknown>;
  return released.version === 1 && typeof released.lease_id === "string" && typeof released.released === "boolean";
}

export type { RedskilledResourceLease };

export interface RedskilledPong {
  readonly pong: true;
  readonly protocol_version: number;
  readonly daemon_version: string;
  readonly pid: number;
}

/** Result of one operator-requested orphan census or immediate reap pass. */
export type RedskilledReapResult = RedskilledReapExecution;

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
  /** Exact admitted fork point; optional only for one-release daemon skew. */
  readonly fork_sha?: string;
  readonly warnings: readonly string[];
}

/** The answer to an explicit reset of this project's in-memory birth latch. */
export interface RedskilledProjectReset {
  readonly version: 1;
  readonly project_label: string;
  readonly latch: "project-birth-breaker";
  readonly reset: boolean;
  readonly reach: RedskilledReachVerdict;
  readonly detail: string;
}

export function isRedskilledProjectReset(value: unknown): value is RedskilledProjectReset {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const reset = value as Record<string, unknown>;
  return reset.version === 1 &&
    typeof reset.project_label === "string" &&
    reset.latch === "project-birth-breaker" &&
    typeof reset.reset === "boolean" &&
    typeof reset.detail === "string" &&
    isRedskilledReachVerdict(reset.reach);
}

export function isRedskilledWorkerStarted(value: unknown): value is RedskilledWorkerStarted {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const started = value as Record<string, unknown>;
  return Array.isArray(started.warnings) &&
    isRedskilledWorkerView(started.worker) &&
    isRedskilledAdmissionVerdict(started.admission) &&
    (started.fork_sha === undefined || (typeof started.fork_sha === "string" && started.fork_sha !== ""));
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
 * The answer to an accepted `project-renew`.
 *
 * The whole renewed record travels back rather than the new deadline alone: a
 * session renewing is precisely the moment it should be able to see the record
 * the host is holding for it, and one that received only a timestamp would have
 * to ask a second question to check the host still holds what it thinks it does.
 */
export interface RedskilledProjectRenewed {
  readonly version: 1;
  readonly registration: RedskilledProjectRegistration;
  readonly reach: RedskilledReachVerdict;
  readonly detail: string;
}

export function isRedskilledProjectRenewed(value: unknown): value is RedskilledProjectRenewed {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const renewed = value as Record<string, unknown>;
  return renewed.version === 1 &&
    typeof renewed.detail === "string" &&
    isRedskilledProjectRegistration(renewed.registration) &&
    isRedskilledReachVerdict(renewed.reach);
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** Validate the public census before a client presents it as host truth. */
export function isRedskilledReapResult(value: unknown): value is RedskilledReapResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || (result.mode !== "report" && result.mode !== "reap")) return false;
  if (result.census === null || typeof result.census !== "object" || Array.isArray(result.census)) return false;
  if (result.actions === null || typeof result.actions !== "object" || Array.isArray(result.actions)) return false;
  const census = result.census as Record<string, unknown>;
  const actions = result.actions as Record<string, unknown>;
  return census.version === 1 &&
    isNonNegativeInteger(census.active_worker_units) &&
    isNonNegativeInteger(census.daemon_held_workers) &&
    isNonNegativeInteger(census.stamped_orphans) &&
    isNonNegativeInteger(census.unstamped_suspects) &&
    isNonNegativeInteger(census.dump_files) &&
    isNonNegativeInteger(actions.adopted) &&
    isNonNegativeInteger(actions.reaped) &&
    isNonNegativeInteger(actions.suspects);
}

function isRepairArgument(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isRepairArgument(item, seen));
    return Object.values(value as Record<string, unknown>)
      .every((item) => isRepairArgument(item, seen));
  } finally {
    seen.delete(value);
  }
}

function hasValidRepair(render: Record<string, unknown>): boolean {
  const repair = render.repair;
  const reason = render.repair_reason;
  if (repair === undefined) return reason === undefined;
  if (repair === "none") return typeof reason === "string" && reason.length > 0;
  if (repair === null || typeof repair !== "object" || Array.isArray(repair)) return false;
  const action = repair as Record<string, unknown>;
  return reason === undefined &&
    typeof action.tool === "string" && action.tool.length > 0 &&
    typeof action.why === "string" && action.why.length > 0 &&
    action.args !== null && typeof action.args === "object" && !Array.isArray(action.args) &&
    isRepairArgument(action.args, new Set());
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
    // Checked only when present, for the reason every optional field here is: a
    // daemon predating the match verdict still serves a complete line, and a
    // client that rejected it would blank the statusline over a diagnostic.
    (render.project_match === undefined || typeof render.project_match === "string") &&
    hasValidRepair(render) &&
    typeof render.degraded === "boolean" &&
    typeof render.stale === "boolean" &&
    typeof render.generated_at === "string";
}

/** True when `value` is a complete payload — re-exported so a client checks one surface. */
export { isRedskilledStatuslinePayload };

/**
 * True when `value` is a dashboard — re-exported so a client checks one surface.
 *
 * Beside the payload guard for the reason that one is here: a surface that
 * speaks this wire reads every shape it trusts off one module, and a second
 * import path is how one consumer comes to trust a shape another rejects.
 */
export { isRedskilledDashboard };

/**
 * The answer to `shutdown`: what the daemon holds, and what survives it.
 *
 * Re-exported here for the same reason the payload guard is — a client that
 * speaks the wire checks the shapes it reads on one surface — and it is a whole
 * report rather than an acknowledgement because a stop an operator cannot see
 * the consequences of is the hand-sent signal this op exists to replace (#2919).
 */
export { isRedskilledDaemonStopped };

export type {
  RedskilledAdmissionVerdict,
  RedskilledDaemonStopped,
  RedskilledStopReason,
  RedskilledHostState,
  RedskilledLaunchTemplate,
  RedskilledProjectRegistration,
  RedskilledProjectRegistrationRequest,
  RedskilledReachVerdict,
  RedskilledStatuslineMode,
  RedskilledStatuslinePayload,
  RedskilledStatuslineRender,
  // The metrics block travels ON the payload, so its shapes are read off the
  // same surface the payload is: a consumer that had to reach into a second
  // module for the rates would be one import away from trusting a block the
  // payload guard never checked.
  RedskilledStatuslineMetrics,
  RedskilledMetricsWindow,
  RedskilledMetricWindowName,
  RedskilledMetricValue,
  RedskilledUsageShare,
  RedskilledUsageShares,
  RedskilledDashboard,
  RedskilledWorkerDisplay,
  RedskilledWorkerCommandName,
  RedskilledWorkerView,
  RedskilledWorkerSpec,
};
