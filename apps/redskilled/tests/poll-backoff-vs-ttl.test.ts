// The poll backoff must stay below the registration TTL (#3133).
//
// `sustainRegistrations` runs INSIDE the queue poll, so the poll is the only
// thing that holds a registration up. A backoff as long as the TTL therefore
// lets a project expire in the gap before the next poll could sustain it.
//
// This is a regression test in the literal sense: the adaptive cadence added in
// #3121 set the maximum backoff to 300_000ms, exactly REDSKILLED_REGISTRATION_TTL_MS,
// and a healthy project with a full queue and a Worker still landing was retired
// three times in one session. Nothing in the suite objected, because the two
// numbers lived in different modules and neither knew about the other.
import { describe, expect, it } from "vitest";
import { REDSKILLED_REGISTRATION_TTL_MS } from "../src/project-registration.js";
import {
  DEFAULT_REDSKILLED_QUEUE_MS,
  nextQueuePollMs,
  REDSKILLED_QUEUE_MAX_BACKOFF_MS,
  emptyQueueDiscovery,
  type RedskilledQueueDiscovery,
} from "../src/queue-discovery.js";

const AT = "2026-08-03T06:00:00.000Z";
const NOW = Date.parse(AT);

function spent(resetInMs: number): RedskilledQueueDiscovery {
  return {
    ...emptyQueueDiscovery(AT),
    rate_limit: {
      remaining: 0,
      reset_at: new Date(NOW + resetInMs).toISOString(),
      exhausted: true,
    },
  };
}

describe("the poll backoff is bounded by the registration TTL", () => {
  it("leaves room for more than one missed poll", () => {
    // Two, at this ratio. One would mean a single hiccup retires a project.
    expect(REDSKILLED_QUEUE_MAX_BACKOFF_MS).toBeLessThan(REDSKILLED_REGISTRATION_TTL_MS);
    expect(REDSKILLED_QUEUE_MAX_BACKOFF_MS * 2).toBeLessThanOrEqual(REDSKILLED_REGISTRATION_TTL_MS);
  });

  it("never returns a delay that could outlive a registration, whatever the reset says", () => {
    // A reset an hour away, a reset in the past, a reset that is nonsense: none
    // of them may produce a sleep long enough to lose the project.
    for (const resetInMs of [1_000, 60_000, 3_600_000, 86_400_000]) {
      const delay = nextQueuePollMs(spent(resetInMs), DEFAULT_REDSKILLED_QUEUE_MS, NOW);
      expect(delay, `reset in ${resetInMs}ms`).toBeLessThan(REDSKILLED_REGISTRATION_TTL_MS);
    }
  });

  it("still waits for a near reset rather than spinning", () => {
    const delay = nextQueuePollMs(spent(30_000), DEFAULT_REDSKILLED_QUEUE_MS, NOW);
    expect(delay).toBe(31_000);
  });

  it("clamps a far reset to the bounded maximum", () => {
    expect(nextQueuePollMs(spent(86_400_000), DEFAULT_REDSKILLED_QUEUE_MS, NOW))
      .toBe(REDSKILLED_QUEUE_MAX_BACKOFF_MS);
  });
});
