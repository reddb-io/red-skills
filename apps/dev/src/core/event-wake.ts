// event-wake — the supervisor's wake source (issue #934). The fleet supervisor's
// health-check loop historically slept a FIXED poll interval between ticks
// (`deps.proc.sleep(pollIntervalS)`), so a worker whose state changed the instant
// after a tick waited a full interval before the supervisor noticed. Event-driven
// supervision races that timer against a worker-state-change EVENT: whichever
// fires first wakes the loop, so a state change is reacted to immediately while
// the timer is retained purely as a safety-net fallback (no regression when an
// event is missed or no event lane is wired).
//
// Everything here is PURE control flow over an injected `sleep` and an injected
// {@link WakeSource}. The real event source (an fs.watch over the worker state
// tree) lives in the runtime/command layer; this module never touches the
// filesystem, so the race + the wake accounting are unit-testable without timers.

/** Which lane woke the supervisor loop this iteration. */
export type WakeReason = "event" | "timer";

/**
 * A source of worker state-change events. `waitForEvent` resolves the moment the
 * next state change is observed (a worker writing its afk.state.toon / appending
 * a heartbeat-firehose record). The `signal` is aborted by {@link waitForNextWake}
 * when the OTHER lane (the timer) wins the race, so the implementation must tear
 * down its watcher on abort — never leak an fs.watch per loop iteration. A throw
 * on setup is swallowed by waitForNextWake and degrades to the timer (safety-net).
 */
export interface WakeSource {
  waitForEvent(signal: AbortSignal): Promise<void>;
}

/** Injected timer: sleeps `ms`, optionally honouring `signal` so the loser leg is
 * torn down when the event wins. The supervisor's real `proc.sleep` ignores the
 * signal (a stray setTimeout settling late is harmless), but a signal-aware sleep
 * lets a test prove the timer leg is cancelled. */
export type WakeSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface WaitForNextWakeOptions {
  /** The safety-net timer interval (ms) — the supervisor's poll cadence. The loop
   * is GUARANTEED to wake within this bound even if every event is missed. */
  fallbackMs: number;
  /** Injected timer. */
  sleep: WakeSleep;
  /** The event lane. Absent → pure-timer behaviour (back-compat / safety-net only). */
  wake?: WakeSource;
}

/**
 * Wait for the next supervisor wake, returning which lane fired. Races the
 * safety-net timer against the worker-state-change event; the loser's
 * AbortSignal is fired so its watcher/timer is torn down. When no {@link
 * WakeSource} is wired (or it throws on setup) this collapses to a plain
 * `sleep(fallbackMs)` and returns `"timer"` — identical to the pre-event loop, so
 * the timer poll is always retained as a fallback with no regression.
 */
export async function waitForNextWake(opts: WaitForNextWakeOptions): Promise<WakeReason> {
  const { fallbackMs, sleep, wake } = opts;

  if (!wake) {
    await sleep(fallbackMs);
    return "timer";
  }

  // Build the event leg first so a synchronous throw on setup (e.g. fs.watch
  // unavailable) degrades to the pure timer rather than rejecting the race.
  const controller = new AbortController();
  let eventLeg: Promise<void>;
  try {
    eventLeg = wake.waitForEvent(controller.signal);
  } catch {
    await sleep(fallbackMs);
    return "timer";
  }

  const TIMER = Symbol("timer");
  try {
    const winner = await Promise.race<symbol | void>([
      sleep(fallbackMs, controller.signal).then(() => TIMER),
      eventLeg.then(() => undefined),
    ]);
    return winner === TIMER ? "timer" : "event";
  } finally {
    // Tear down the losing leg (close the fs.watch, cancel a signal-aware sleep).
    // A signal-unaware leg is simply left to settle on its own — harmless.
    controller.abort();
  }
}

/**
 * Cumulative wake accounting, carried on the supervisor runtime so the fleet can
 * report — and a test can assert — how event-driven the loop actually ran. Pure
 * data; {@link recordWake} mutates it in place each iteration (matching the
 * supervisor's in-place slot bookkeeping).
 */
export interface WakeStats {
  /** Total loop wakes observed. */
  total: number;
  /** Wakes driven by a worker state-change event. */
  event: number;
  /** Wakes driven by the safety-net timer (idle polls under the baseline). */
  timer: number;
}

export function freshWakeStats(): WakeStats {
  return { total: 0, event: 0, timer: 0 };
}

/** Record one wake by its lane. */
export function recordWake(stats: WakeStats, reason: WakeReason): void {
  stats.total += 1;
  if (reason === "event") stats.event += 1;
  else stats.timer += 1;
}

/**
 * The fraction of wakes that were event-driven (0..1) — the measurable reduction
 * in idle wake-ups vs the pure-timer baseline. Under the baseline EVERY wake is a
 * timer poll (many of them idle, finding nothing changed); each event-driven wake
 * is one that instead fired exactly when a worker's state changed, displacing an
 * idle poll. So `event / total` is the share of the baseline's idle polls the
 * event lane eliminated. 0 when no wakes have happened yet (or none were events).
 */
export function idleWakeReduction(stats: WakeStats): number {
  return stats.total === 0 ? 0 : stats.event / stats.total;
}
