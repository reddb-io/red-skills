// The queue poll follows the balance it is already told (ADR 0132 Amendment 2).
//
// RedskilledQueueDiscovery has carried a `rate_limit` since it existed, and the
// daemon read none of it while polling on a constant — asking at the same rate
// whether the token was full or one request from empty.
import { describe, expect, it } from "vitest";
import {
  emptyQueueDiscovery,
  nextQueuePollMs,
  REDSKILLED_QUEUE_MAX_BACKOFF_MS,
  type RedskilledQueueDiscovery,
} from "../src/queue-discovery.js";

const AT = "2026-08-03T03:00:00.000Z";

function discovery(rate: Partial<RedskilledQueueDiscovery["rate_limit"]>): RedskilledQueueDiscovery {
  return {
    ...emptyQueueDiscovery(AT),
    rate_limit: { remaining: null, reset_at: null, exhausted: false, ...rate },
  };
}

const NOW = Date.parse(AT);
const poll = (d: RedskilledQueueDiscovery, baseMs = 15_000, nowMs = NOW) =>
  nextQueuePollMs(d, baseMs, nowMs);

describe("queue poll cadence", () => {
  it("keeps the base interval when the balance is healthy", () => {
    expect(poll(discovery({ remaining: 4800 }))).toBe(15_000);
  });

  it("slows as the balance falls", () => {
    expect(poll(discovery({ remaining: 900 }))).toBe(20_000);
    expect(poll(discovery({ remaining: 100 }))).toBe(30_000);
  });

  it("waits for the reset once exhausted — no answer can change until then", () => {
    // A reset inside the bound is waited for exactly; one beyond it is clamped,
    // because the poll is what sustains a registration and may not outlive one.
    const resetAt = new Date(Date.parse(AT) + 60_000).toISOString();
    expect(poll(discovery({ exhausted: true, reset_at: resetAt }))).toBe(61_000);
  });

  it("clamps an absurd reset instant rather than sleeping forever", () => {
    const farOff = new Date(Date.parse(AT) + 86_400_000).toISOString();
    expect(poll(discovery({ exhausted: true, reset_at: farOff }))).toBe(REDSKILLED_QUEUE_MAX_BACKOFF_MS);
  });

  it("falls back to a bounded wait when the reset instant is missing or garbage", () => {
    expect(poll(discovery({ exhausted: true, reset_at: null }))).toBe(60_000);
    expect(poll(discovery({ exhausted: true, reset_at: "not-a-date" }))).toBe(60_000);
  });

  it("never polls FASTER than the base interval, whatever the balance says", () => {
    // The cadence may only slow down. Speeding up on a low balance would spend
    // more of exactly the budget it noticed was running out.
    for (const remaining of [0, 100, 900, 5000]) {
      expect(poll(discovery({ remaining }))).toBeGreaterThanOrEqual(15_000);
    }
  });

  it("keeps the base interval when no poll has reported a balance yet", () => {
    expect(poll(discovery({}))).toBe(15_000);
  });

  it("keeps the base interval when no poll has happened at all", () => {
    expect(nextQueuePollMs(null, 15_000, NOW)).toBe(15_000);
  });
});
