// slot-circuit — pure half-open state machine for the AFK fleet circuit breaker.
//
// State machine:
//   closed    (parked=false)               — slot running workers normally
//   open      (parked=true, halfOpen=false) — tripped; waiting for cooldown
//   half-open (parked=true, halfOpen=true)  — probe worker spawned
//
// Transitions (all driven by the supervisor tick with injected clock):
//   closed → open         on K fast deaths in window (handled by recordDeath)
//   open → half-open      when cooldown expires (isHalfOpenDue)
//   half-open → closed    when probe does NOT fast-die (close-on-success)
//   half-open → open      when probe fast-dies (re-park, backoffStep++)
//
// Backoff formula: min(halfOpenBaseS * 2^step, halfOpenCapS).
// Step 0 = first probe after base cooldown; each re-park increments the step.
// Resetting to closed also resets the step to 0.

export interface SlotCircuitConfig {
  /** RED_AFK_HALF_OPEN_BASE_S — base cooldown for the first half-open probe
   * after a circuit trip (default 60s). */
  halfOpenBaseS: number;
  /** RED_AFK_HALF_OPEN_CAP_S — maximum cooldown cap for exponential backoff
   * (default 3600s = 1 hour). */
  halfOpenCapS: number;
}

export const SLOT_CIRCUIT_DEFAULTS: SlotCircuitConfig = {
  halfOpenBaseS: 60,
  halfOpenCapS: 3600,
};

/**
 * Compute the cooldown duration for backoff step N (seconds).
 * Formula: min(halfOpenBaseS × 2^step, halfOpenCapS).
 * Examples with defaults: step 0 → 60s, step 1 → 120s, step 2 → 240s, …
 */
export function computeHalfOpenBackoff(step: number, config: SlotCircuitConfig): number {
  return Math.min(config.halfOpenBaseS * Math.pow(2, step), config.halfOpenCapS);
}

/**
 * Returns true when the half-open probe for a tripped slot is due.
 * tripEpoch is when the circuit last entered open state (tripped or re-parked).
 * A tripEpoch of 0 means the slot has never tripped — never due.
 */
export function isHalfOpenDue(
  tripEpoch: number,
  backoffStep: number,
  now: number,
  config: SlotCircuitConfig,
): boolean {
  if (tripEpoch <= 0) return false;
  return now - tripEpoch >= computeHalfOpenBackoff(backoffStep, config);
}
