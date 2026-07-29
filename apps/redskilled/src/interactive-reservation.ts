/**
 * interactive-reservation — how a one-off dispatch takes the next slot without
 * killing anything.
 *
 * A ticket-slicing run can queue days of autonomous work, so an interactive
 * request that waits behind it waits for days. The cure is **soft preemption**:
 * the project reserves the next slot by *declining to admit the next queued
 * birth* — it holds room back from autonomous demand and lets the interactive
 * selector take the slot the next natural death frees. Nothing in flight is lost
 * to impatience, and the cost is bounded to one Worker's remaining run.
 *
 * There is deliberately no kill path here, and none anywhere on the producer's
 * side: **a reservation removes future births, never present Workers.** A
 * reservation that could terminate a live Worker would trade a bounded wait for
 * an unbounded loss of work, which is the opposite of the bargain.
 *
 * The policy lives in the project because deciding whose work matters is
 * repository knowledge and the daemon holds none (ADR 0130). The daemon sees
 * only that fewer Workers were asked for this tick.
 *
 * Every function here is PURE: state in, state out.
 */

/** One outstanding claim on the next free slot. */
export interface InteractiveReservation {
  readonly reservation_id: string;
  /** When the claim was first made. A renewal does not move it — see below. */
  readonly reserved_at_ms: number;
  readonly reason: string | null;
}

export interface InteractiveReservationState {
  readonly reservations: readonly InteractiveReservation[];
}

/**
 * How long an unclaimed reservation survives before it lapses.
 *
 * A withdrawal is the intended release, but a caller that dies mid-request
 * never withdraws, so the hold also expires on its own. Without the lapse a
 * crashed client would keep a slot empty for as long as the project runs.
 */
export const INTERACTIVE_RESERVATION_TTL_MS = 5 * 60_000;

export const NO_INTERACTIVE_RESERVATIONS: InteractiveReservationState = { reservations: [] };

/**
 * Claim the next free slot for an interactive dispatch.
 *
 * Re-reserving an id already held is idempotent and **keeps the original
 * timestamp**: a client that renewed on a timer could otherwise hold a slot
 * forever, which is exactly the indefinite hold the lapse exists to prevent.
 */
export function reserveInteractiveSlot(
  state: InteractiveReservationState,
  input: { readonly reservation_id: string; readonly at_ms: number; readonly reason?: string | null },
): InteractiveReservationState {
  if (state.reservations.some((held) => held.reservation_id === input.reservation_id)) return state;
  return {
    reservations: [
      ...state.reservations,
      {
        reservation_id: input.reservation_id,
        reserved_at_ms: input.at_ms,
        reason: input.reason ?? null,
      },
    ],
  };
}

/**
 * Withdraw a claim — the request was served, cancelled, or abandoned.
 *
 * Releasing an id that is not held is not an error: a withdrawal races the
 * lapse, and a caller that had to know which of the two won would have to hold
 * the producer's clock.
 */
export function releaseInteractiveSlot(
  state: InteractiveReservationState,
  reservationId: string,
): InteractiveReservationState {
  const kept = state.reservations.filter((held) => held.reservation_id !== reservationId);
  return kept.length === state.reservations.length ? state : { reservations: kept };
}

/** Drop every reservation whose hold has run out. */
export function expireLapsedReservations(
  state: InteractiveReservationState,
  nowMs: number,
  ttlMs: number = INTERACTIVE_RESERVATION_TTL_MS,
): InteractiveReservationState {
  const kept = state.reservations.filter((held) => !hasLapsed(held, nowMs, ttlMs));
  return kept.length === state.reservations.length ? state : { reservations: kept };
}

/** How many slots are held back from autonomous demand right now. */
export function reservedSlotCount(
  state: InteractiveReservationState,
  nowMs: number,
  ttlMs: number = INTERACTIVE_RESERVATION_TTL_MS,
): number {
  return state.reservations.filter((held) => !hasLapsed(held, nowMs, ttlMs)).length;
}

/** Whether this specific claim is still standing. */
export function isReservationHeld(
  state: InteractiveReservationState,
  reservationId: string,
  nowMs: number,
  ttlMs: number = INTERACTIVE_RESERVATION_TTL_MS,
): boolean {
  const held = state.reservations.find((entry) => entry.reservation_id === reservationId);
  return held != null && !hasLapsed(held, nowMs, ttlMs);
}

/** The words a held-back selector is skipped with, for the lifecycle lane. */
export function heldBackReason(reserved: number): string {
  return `${reserved} slot(s) held back for an interactive dispatch; no live Worker was terminated to make room`;
}

function hasLapsed(held: InteractiveReservation, nowMs: number, ttlMs: number): boolean {
  return nowMs - held.reserved_at_ms >= ttlMs;
}
