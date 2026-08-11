/**
 * The visible state of the statusline's one read from redskilled.
 *
 * `live` is deliberately quiet: current data is its own evidence. Every other
 * state replaces the daemon tail with one compact token, except a deadline miss
 * with a last-known tail, where the old data stays visible beside its age and
 * the `degraded` token.
 */
import { formatAgeSeconds } from "@reddb-io/redskilled-render";

export type StatuslineLifecycleState =
  | "bedrock-only"
  | "connecting"
  | "registering"
  | "unregistered"
  | "live"
  | "degraded";

export type StatuslineSocketProbe = "disabled" | "connecting" | "unreachable" | "answered";
export type StatuslineRegistrationPresence = "pending" | "absent" | "present";

export interface StatuslineLifecycleInput {
  readonly probe: StatuslineSocketProbe;
  readonly registration?: StatuslineRegistrationPresence;
  readonly payloadAgeMs?: number | null;
  readonly stalenessWindowMs?: number;
  /** A daemon may call a payload stale for a reason other than age. */
  readonly payloadStale?: boolean;
}

/** Map wire facts to the one visible lifecycle state. PURE. */
export function resolveStatuslineLifecycle(input: StatuslineLifecycleInput): StatuslineLifecycleState {
  if (input.probe === "disabled" || input.probe === "unreachable") return "bedrock-only";
  if (input.probe === "connecting") return "connecting";
  if (input.registration === "pending") return "registering";
  if (input.registration !== "present") return "unregistered";

  const agePastWindow =
    input.payloadAgeMs != null &&
    Number.isFinite(input.payloadAgeMs) &&
    input.stalenessWindowMs != null &&
    input.payloadAgeMs > input.stalenessWindowMs;
  return input.payloadStale === true || agePastWindow ? "degraded" : "live";
}

/** The compact lifecycle token; healthy data carries no redundant badge. PURE. */
export function renderStatuslineLifecycleToken(state: StatuslineLifecycleState): string | null {
  return state === "live" ? null : `rsk=${state}`;
}

export interface LifecycleTailInput {
  readonly state: StatuslineLifecycleState;
  readonly tail?: readonly string[];
  /** Present only when `tail` is a last-known snapshot rather than this read. */
  readonly cachedAgeMs?: number;
}

/**
 * Render the lifecycle-owned tail segment. PURE.
 *
 * A live read passes the Shared render through untouched. A non-live read emits
 * only its state token, unless the deadline fallback supplied a cached tail; in
 * that case its head states both age and degradation while its Worker rows stay
 * intact.
 */
export function lifecycleTailLines(input: LifecycleTailInput): string[] {
  const tail = [...(input.tail ?? [])];
  if (input.state === "live") return tail;

  const token = renderStatuslineLifecycleToken(input.state)!;
  if (input.cachedAgeMs == null || tail.length === 0) return [token];

  const age = formatAgeSeconds(Math.max(0, input.cachedAgeMs)) ?? "0s";
  const [head, ...rest] = tail;
  return [`${head} · age=${age} · ${token}`, ...rest];
}
