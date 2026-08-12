/**
 * activity-poller — the repository poll's loop, kept out of the lifecycle.
 *
 * The POLICY is `../activity-cadence.js` and is pure; this is the small amount
 * of state that policy needs to act on a running daemon: which timeout is
 * waiting, and what window it was armed with. Both live here rather than among
 * the lifecycle's other fields because the whole of what a caller does with them
 * is `arm`, `nudge`, `cadenceMs` and `stop`.
 *
 * **The window is chosen per poll, not once** (ADR 0141). The re-arm is a
 * timeout the poll itself schedules, exactly as the queue poller's is: a fixed
 * interval would have to choose between the attended and the idle host before
 * either existed.
 *
 * **Presence is read live, never copied in.** The registrations are handed over
 * as a thunk, so a session that registers between two polls is visible to the
 * next cadence question rather than to the next daemon.
 */
import {
  activityRateLimitBackoffMs,
  activityPollComesForward,
  interactiveSessionsHolding,
  nextActivityPollMs,
} from "../activity-cadence.js";
import type { RedskilledProjectRegistration } from "../project-registration.js";

export interface RedskilledActivityPollerOptions {
  /** Spend one interval's fetch. A rejection is the loop's to swallow. */
  readonly poll: () => Promise<unknown>;
  /** The registrations presence is read off — asked, never held. */
  readonly registrations: () => Iterable<RedskilledProjectRegistration>;
  readonly clock: () => string;
  /** The attended window; the cadence module's default at 0 or below. */
  readonly attendedMs: number;
  /** Whether this daemon has a repository to poll at all. */
  readonly armed: boolean;
  /** Whether the daemon has begun letting go of its session. */
  readonly stopping: () => boolean;
  /** Last remote quota answer; exhaustion parks the next cycle until reset. */
  readonly rateLimit?: () => { readonly exhausted: boolean; readonly reset_at: string | null } | null;
}

export interface RedskilledActivityPoller {
  /**
   * Fetch once, then run on the window presence asks for.
   *
   * The immediate fetch is why a daemon that just started is never empty; the
   * interval after it is the tracker's rather than the sampler's, because
   * repository activity moves at human speed and costs shared quota.
   */
  arm(): void;
  /** The window in force right now — what the payload's staleness is two of. */
  cadenceMs(): number;
  /** Bring a waiting poll forward, because a session just spoke. */
  nudge(): void;
  stop(): void;
}

export function createRedskilledActivityPoller(
  options: RedskilledActivityPollerOptions,
): RedskilledActivityPoller {
  let timer: NodeJS.Timeout | undefined;
  // The window the WAITING poll was armed with, so a session that attaches
  // mid-window can be told whether the wait it found is longer than the one
  // presence now asks for. `null` whenever no poll is armed.
  let armedWindowMs: number | null = null;
  let polling = false;

  function cadenceMs(): number {
    return nextActivityPollMs({
      attended: interactiveSessionsHolding(options.registrations(), Date.parse(options.clock())) > 0,
      attendedMs: options.attendedMs,
    });
  }

  function nextDelayMs(): number {
    const cadence = cadenceMs();
    return activityRateLimitBackoffMs(options.rateLimit?.() ?? null, cadence, Date.parse(options.clock()));
  }

  function schedule(delayMs: number): void {
    if (options.stopping()) return;
    armedWindowMs = delayMs;
    timer = setTimeout(() => {
      timer = undefined;
      armedWindowMs = null;
      polling = true;
      void options.poll()
        .catch(() => undefined)
        .finally(() => {
          polling = false;
          if (options.stopping()) return;
          schedule(nextDelayMs());
        });
    }, delayMs);
    timer.unref();
  }

  return {
    arm() {
      if (options.stopping() || timer != null || polling || !options.armed || options.attendedMs <= 0) return;
      polling = true;
      void options.poll()
        .catch(() => undefined)
        .finally(() => {
          polling = false;
          if (options.stopping()) return;
          schedule(nextDelayMs());
        });
    },

    cadenceMs,

    /**
     * The daemon holds no connection to a session, so presence arrives as a
     * registration message and nothing else. Without this, an operator who
     * attaches to an idle host ten seconds after its last poll is served
     * four-minute-old counters for four minutes more — the stale-line complaint
     * this cycle exists to end.
     *
     * Only ever forward, and only when the window actually shrank, so a session
     * renewing on a timer can never push a waiting poll away.
     */
    nudge() {
      if (options.stopping() || timer == null) return;
      const next = cadenceMs();
      if (!activityPollComesForward({ pendingWindowMs: armedWindowMs, cadenceMs: next })) return;
      clearTimeout(timer);
      timer = undefined;
      schedule(next);
    },

    stop() {
      if (timer != null) clearTimeout(timer);
      timer = undefined;
      armedWindowMs = null;
    },
  };
}
