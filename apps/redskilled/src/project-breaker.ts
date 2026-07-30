/**
 * project-breaker — the project's half of the circuit, driven by the host's deaths.
 *
 * The breaker is the clearest proof the seam sits in the right place: **the
 * daemon reports that a Worker died, and the project decides whether repeated
 * deaths park the work.** Neither half needs to know the other's business — a
 * death is a fact about a process, and parking a selector is a decision about
 * work, so the fact crosses the socket and the policy never does.
 *
 * The state machine is the one the fleet's slot circuit ran, minus the slot:
 *
 *   closed     — the selector is asked for Workers normally
 *   open       — K consecutive fast deaths tripped it; it waits out a cooldown
 *   half-open   — the cooldown elapsed, so the next request is a probe
 *
 * A probe that fast-dies re-parks with the cooldown doubled; a Worker that
 * *lived* closes the circuit outright. There is no half-open flag to store,
 * because "the cooldown elapsed and the selector has not been closed yet" is
 * already the whole of half-open, and a stored flag would be a second copy of a
 * fact the clock already holds.
 *
 * PURE: every function here takes its clock as an argument and returns new
 * state. Nothing in this file reads a process, a file or the environment.
 */

/** What the daemon reported, reduced to what the decision needs. */
export interface WorkerDeathReport {
  readonly worker_id: string;
  /** The selector whose demand produced this Worker — the breaker's unit. */
  readonly selector_id: string;
  /** Which host fact this was: an ordinary death, or a budget-driven kill. */
  readonly kind: "worker-death" | "worker-budget-kill";
  /** How long the Worker lived, in milliseconds. */
  readonly lived_ms: number;
  /** When the death was observed, in epoch milliseconds. */
  readonly at_ms: number;
  /** The host's own words for why — an exit status, a signal, a budget. */
  readonly detail: string | null;
  /**
   * The exit status the daemon witnessed, when it witnessed one.
   *
   * The breaker itself never reads it — a fast death is a fast death whatever it
   * exited with. It rides here because the project's OTHER policies do turn on
   * it (a permanent host-configuration exit is parked without retry, a clean
   * drain with an empty queue is not a crash), and the report is the one place
   * every one of those policies already receives the death.
   */
  readonly exit_code?: number | null;
}

export interface ProjectBreakerConfig {
  /** A Worker that died sooner than this never got to work; it died on birth. */
  readonly fastDeathMs: number;
  /** Consecutive fast deaths that park a selector. */
  readonly deathsToPark: number;
  readonly cooldownBaseMs: number;
  readonly cooldownCapMs: number;
}

export const PROJECT_BREAKER_DEFAULTS: ProjectBreakerConfig = {
  fastDeathMs: 60_000,
  deathsToPark: 3,
  cooldownBaseMs: 60_000,
  cooldownCapMs: 3_600_000,
};

/** One selector's circuit. `parked_until_ms` of 0 means closed. */
export interface SelectorBreaker {
  readonly selector_id: string;
  readonly consecutive_fast_deaths: number;
  readonly parked_until_ms: number;
  readonly backoff_step: number;
  /** Why it was last parked, in the host's words. `null` while closed. */
  readonly last_reason: string | null;
}

/** Every selector the project has an opinion about, by selector id. */
export type ProjectBreakerState = Readonly<Record<string, SelectorBreaker>>;

/** A selector nothing has tripped. PURE. */
export function closedBreaker(selectorId: string): SelectorBreaker {
  return {
    selector_id: selectorId,
    consecutive_fast_deaths: 0,
    parked_until_ms: 0,
    backoff_step: 0,
    last_reason: null,
  };
}

/** The cooldown for backoff step N: `base × 2^step`, capped. PURE. */
export function breakerCooldownMs(step: number, config: ProjectBreakerConfig = PROJECT_BREAKER_DEFAULTS): number {
  return Math.min(config.cooldownBaseMs * 2 ** step, config.cooldownCapMs);
}

/** True while this selector must not be asked for Workers. PURE. */
export function isSelectorParked(state: ProjectBreakerState, selectorId: string, nowMs: number): boolean {
  const breaker = state[selectorId];
  return breaker != null && breaker.parked_until_ms > nowMs;
}

/** Why the selector is parked, or `null` when it is not. PURE. */
export function selectorParkReason(
  state: ProjectBreakerState,
  selectorId: string,
  nowMs: number,
): string | null {
  if (!isSelectorParked(state, selectorId, nowMs)) return null;
  return state[selectorId]?.last_reason ?? null;
}

/**
 * Fold one reported death into the project's decision.
 *
 * A death that is *not* fast closes the circuit: the Worker lived long enough to
 * have done work, so whatever tripped the selector is over, and carrying the
 * count forward would park a selector for deaths that had nothing to do with
 * each other. A fast death while the circuit is already backed off re-parks
 * immediately, without waiting for K again — that death **was** the probe, and
 * demanding another K would spend the failure budget over and over. PURE.
 */
export function recordWorkerDeath(
  state: ProjectBreakerState,
  report: WorkerDeathReport,
  config: ProjectBreakerConfig = PROJECT_BREAKER_DEFAULTS,
): ProjectBreakerState {
  const previous = state[report.selector_id] ?? closedBreaker(report.selector_id);
  if (report.lived_ms >= config.fastDeathMs) {
    return { ...state, [report.selector_id]: closedBreaker(report.selector_id) };
  }

  const fastDeaths = previous.consecutive_fast_deaths + 1;
  const probing = previous.backoff_step > 0;
  if (!probing && fastDeaths < config.deathsToPark) {
    return {
      ...state,
      [report.selector_id]: { ...previous, consecutive_fast_deaths: fastDeaths },
    };
  }

  const cooldown = breakerCooldownMs(previous.backoff_step, config);
  const cause = report.detail ?? report.kind;
  return {
    ...state,
    [report.selector_id]: {
      selector_id: report.selector_id,
      consecutive_fast_deaths: 0,
      parked_until_ms: report.at_ms + cooldown,
      backoff_step: previous.backoff_step + 1,
      last_reason: probing
        ? `selector ${JSON.stringify(report.selector_id)} is parked for ${cooldown}ms: its probe Worker died in ${report.lived_ms}ms (${cause})`
        : `selector ${JSON.stringify(report.selector_id)} is parked for ${cooldown}ms after ${fastDeaths} fast deaths, the last of them ${cause}`,
    },
  };
}

/**
 * Close the circuit because a Worker of this selector is working.
 *
 * The half-open → closed edge. It is a separate report rather than an inference
 * from the next tick, because "no death arrived" is also what a selector nobody
 * asked for looks like, and closing on that would unpark a circuit no probe ever
 * tested. PURE.
 */
export function recordWorkerSurvival(state: ProjectBreakerState, selectorId: string): ProjectBreakerState {
  return { ...state, [selectorId]: closedBreaker(selectorId) };
}
