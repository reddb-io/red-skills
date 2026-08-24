// statusline-staleness — the payload's one freshness verdict.
//
// **Staleness travels inside the payload** (see `./statusline-payload.js`),
// and this module owns HOW it is judged: against the Worker sample while
// Workers exist, and against the daemon's own request-health beat when none
// do. The zero-worker arm exists because a hardcoded `stale: false` there made
// the one global freshness bit unusable exactly when it mattered — an
// idle-but-broken daemon rendered a green "live" badge on every consumer.
import type { RedskilledRequestHealth } from "./host-state.js";

export interface RedskilledStatuslineStaleness {
  readonly sampled_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly stale: boolean;
  readonly measured_worker_count: number;
  /** Live Workers the last sample did not measure, by id. */
  readonly unmeasured_workers: readonly string[];
  readonly reason: string;
}

export interface BuildStatuslineStalenessInput {
  readonly sampledAt: string | null;
  readonly ageMs: number | null;
  readonly threshold: number;
  readonly workerCount: number;
  readonly measuredCount: number;
  readonly unmeasured: readonly string[];
  readonly now?: string;
  readonly health?: RedskilledRequestHealth;
}

/** Judge one payload's freshness. PURE. */
export function buildStatuslineStaleness(
  input: BuildStatuslineStalenessInput,
): RedskilledStatuslineStaleness {
  const common = {
    sampled_at: input.sampledAt,
    age_ms: input.ageMs,
    threshold_ms: input.threshold,
    measured_worker_count: input.measuredCount,
    unmeasured_workers: input.unmeasured,
  };
  if (input.workerCount === 0) {
    // With zero Workers the daemon's own beat is the only thing left to age,
    // so it is what this arm ages. A daemon reporting no beat at all keeps the
    // old calm answer — older hosts must not cry wolf.
    const health = input.health;
    if (health == null) {
      return { ...common, stale: false, reason: "the host holds no Workers, so there is nothing to measure and nothing to age" };
    }
    const beatAge = input.now == null || health.last_success_at == null
      ? null
      : beatAgeBetween(input.now, health.last_success_at);
    if (health.status === "degraded") {
      return {
        ...common,
        stale: true,
        reason: `this answer is stale: the host holds no Workers and the daemon's own beat is degraded — ${health.detail}`,
      };
    }
    if (beatAge == null) {
      return {
        ...common,
        stale: true,
        reason: "this answer is stale: the host holds no Workers and the daemon's own beat is unproven",
      };
    }
    return {
      ...common,
      stale: false,
      reason: `the host holds no Workers; the daemon's own beat is ${beatAge}ms old and healthy`,
    };
  }
  if (input.sampledAt == null || input.ageMs == null) {
    return {
      ...common,
      stale: true,
      reason: `this answer is stale: the daemon has taken no measurement of its ${input.workerCount} live Worker(s) yet`,
    };
  }
  if (input.ageMs > input.threshold) {
    return {
      ...common,
      stale: true,
      reason: `this answer is stale: its measurement is ${input.ageMs}ms old, past the ${input.threshold}ms staleness window`,
    };
  }
  return {
    ...common,
    stale: false,
    reason: `measured ${input.ageMs}ms ago, within the ${input.threshold}ms staleness window`,
  };
}

/** Non-negative age between two instants, or `null` when either is not one. PURE. */
function beatAgeBetween(now: string, then: string): number | null {
  const nowMs = Date.parse(now);
  const thenMs = Date.parse(then);
  return Number.isFinite(nowMs) && Number.isFinite(thenMs) ? Math.max(0, nowMs - thenMs) : null;
}
