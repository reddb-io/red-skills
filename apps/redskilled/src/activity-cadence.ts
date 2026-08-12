/**
 * activity-cadence — how often the repository poll runs, decided by who is watching.
 *
 * ADR 0141 moves every remote counter into the daemon's own poll, and the
 * operator's perceived reactivity comes from the per-render socket read rather
 * than from that poll. So the poll decides one thing only: **how fresh the cache
 * that read serves is** — and freshness is worth spending budget on exactly
 * while somebody is looking at it.
 *
 * **Presence is READ off the registrations, never invented here.** A session
 * that is alive renews the registration it holds, and
 * `registrationRenewalStatus` already calls that `renewing`; its two other
 * verdicts are a project the daemon holds up on its own observed work
 * (`self-renewing`) and one running on toward its deadline (`running-on`), which
 * are both work with nobody watching. A second notion of "attached" derived here
 * would be a second authority on the same silence.
 *
 * **Two windows, and both of them legal.** The attended window is the Spec's
 * ~15–30s; the unattended one is four minutes. Both sit inside the repo's
 * cache-warm cadence rule — at or under 270 seconds, or at or over twenty
 * minutes, and never in the roughly-300-second prompt-cache dead zone. The
 * rejected alternative was the wished-for 5s poll: that is line reactivity, and
 * the socket read already delivers it without spending GitHub budget.
 *
 * **The unattended window is a back-off, not a second speed.** It may only ever
 * be SLOWER than the attended one, for the same reason the queue cadence may
 * only slow: a host nobody is watching that polled harder than an attended one
 * would spend more of exactly the budget its idleness was meant to save.
 *
 * **Why four minutes rather than twenty.** A cadence is chosen when the last
 * poll finishes, so the unattended window is the worst case for how long an
 * operator who just attached waits for a fresh number. `activityPollComesForward`
 * closes most of that gap by re-arming a waiting poll the moment presence
 * appears; the shorter of the two legal bands keeps the bound small anyway,
 * because a back-off nobody nudged must still be honest.
 *
 * PURE.
 */

import {
  registrationRenewalStatus,
  type RedskilledProjectRegistration,
} from "./project-registration.js";
import { DEFAULT_REDSKILLED_ACTIVITY_MS } from "./repository-activity.js";

/**
 * The window between polls while nobody holds a registration open.
 *
 * At the cache-warm edge of the AFK polling cadence rule rather than in the
 * ~300s dead zone next to it, and short enough that an operator who attaches to
 * an idle host is never told a four-minute-old number for longer than that.
 */
export const REDSKILLED_ACTIVITY_UNATTENDED_MS = 240_000;

/** The longest a recurring poll may run and still be cache-warm. */
export const REDSKILLED_CACHE_WARM_MAX_MS = 270_000;

/** The shortest an intentionally amortized recurring poll may run. */
export const REDSKILLED_AMORTIZED_MIN_MS = 20 * 60_000;

/**
 * Whether a recurring cadence sits in one of the two legal bands. PURE.
 *
 * The rule is about DEFAULTS a daemon ships with, so this is a predicate a test
 * pins the declared constants against rather than a refusal in the poll path: a
 * caller that states its own interval — a test driving the loop at 10ms, an
 * operator who knows what they are doing — is not choosing a prompt-cache
 * cadence for anybody.
 */
export function isCacheWarmCadenceMs(everyMs: number): boolean {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return false;
  return everyMs <= REDSKILLED_CACHE_WARM_MAX_MS || everyMs >= REDSKILLED_AMORTIZED_MIN_MS;
}

/**
 * How many registrations a session is still speaking for, at one instant. PURE.
 *
 * An undatable clock counts NOBODY, which is the fail-closed answer: the cost of
 * reading absence as presence is a host spending budget on counters no operator
 * is reading, and the cost of the reverse is one slow window on a host whose
 * clock is already broken.
 */
export function interactiveSessionsHolding(
  registrations: Iterable<RedskilledProjectRegistration>,
  nowMs: number,
): number {
  if (!Number.isFinite(nowMs)) return 0;
  let held = 0;
  for (const registration of registrations) {
    if (registrationRenewalStatus(registration, nowMs) === "renewing") held += 1;
  }
  return held;
}

export interface RedskilledActivityCadenceInput {
  /** Whether at least one interactive session holds a registration right now. */
  readonly attended: boolean;
  /** The tight window; the module default when absent or not a positive number. */
  readonly attendedMs?: number;
  /** The backed-off window; the module default under the same condition. */
  readonly unattendedMs?: number;
}

/**
 * The window between repository polls, given who is watching. PURE.
 *
 * Presence is the only input: the budget-aware client already refuses what the
 * token cannot afford, and the rate-limit shape belongs to the poll that meets
 * it (`nextQueuePollMs` reads that one). This answers the other question —
 * whether the freshness is worth asking for at all.
 */
export function nextActivityPollMs(input: RedskilledActivityCadenceInput): number {
  const attendedMs = positiveOr(input.attendedMs, DEFAULT_REDSKILLED_ACTIVITY_MS);
  const unattendedMs = positiveOr(input.unattendedMs, REDSKILLED_ACTIVITY_UNATTENDED_MS);
  // Never faster than the attended window when unattended: the back-off may only
  // ever slow down, whatever a caller states.
  return input.attended ? attendedMs : Math.max(attendedMs, unattendedMs);
}

/** The longest blind retry hold when GitHub supplied no usable reset instant. */
export const REDSKILLED_ACTIVITY_RATE_LIMIT_MAX_BACKOFF_MS = REDSKILLED_AMORTIZED_MIN_MS;

/**
 * Turn an exhausted remote answer into the poller's next sleep.
 *
 * The reset is the next instant at which another answer can differ. A malformed
 * or absent reset still slows the loop by four ordinary windows, while the cap
 * prevents a corrupt timestamp from retiring the poller indefinitely.
 */
export function activityRateLimitBackoffMs(
  limit: { readonly exhausted: boolean; readonly reset_at: string | null } | null,
  baseMs: number,
  nowMs: number,
): number {
  if (limit?.exhausted !== true) return baseMs;
  const resetAtMs = limit.reset_at == null ? Number.NaN : Date.parse(limit.reset_at);
  const waitMs = Number.isFinite(resetAtMs) && Number.isFinite(nowMs)
    ? resetAtMs - nowMs + 1_000
    : baseMs * 4;
  return Math.min(REDSKILLED_ACTIVITY_RATE_LIMIT_MAX_BACKOFF_MS, Math.max(baseMs, waitMs));
}

export interface RedskilledActivityForwardInput {
  /** The window the pending poll was armed with; `null` when none is armed. */
  readonly pendingWindowMs: number | null;
  /** The window in force now, as {@link nextActivityPollMs} answers it. */
  readonly cadenceMs: number;
}

/**
 * Whether a poll already waiting should be brought forward. PURE.
 *
 * **A cadence chosen when the last poll finished is deaf to what happened
 * since.** An unattended host arms four minutes; a session that attaches ten
 * seconds later would be served four-minute-old counters for four minutes more,
 * which is exactly the stale-line complaint this whole cycle was written about.
 *
 * Only ever FORWARD, and only when the window actually shrank. A session going
 * quiet leaves the tight poll already armed to run once more — one extra fetch,
 * against re-arming logic that could otherwise push a waiting poll away
 * indefinitely while a session renewed on a timer.
 */
export function activityPollComesForward(input: RedskilledActivityForwardInput): boolean {
  if (input.pendingWindowMs == null) return false;
  if (!Number.isFinite(input.pendingWindowMs) || !Number.isFinite(input.cadenceMs)) return false;
  return input.cadenceMs < input.pendingWindowMs;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback;
}
