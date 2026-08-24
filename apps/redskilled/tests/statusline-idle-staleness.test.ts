// `staleness.stale` was hardcoded `false` whenever the host held zero Workers
// — so the one global freshness bit was unusable exactly when it mattered, and
// every consumer of the payload (herdr's "● live" badge included) rendered an
// idle-but-broken daemon as green. With no Workers the daemon's own beat is
// the only thing left to age, so it is what the zero-worker arm now ages.
import { describe, expect, it } from "vitest";

import { buildHostState, type RedskilledRequestHealth } from "../src/host-state.js";
import { buildStatuslinePayload } from "../src/statusline-payload.js";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";

function idlePayload(health?: RedskilledRequestHealth) {
  return buildStatuslinePayload({
    hostState: buildHostState({
      daemonVersion: "9.9.9",
      machineIdHash: "mach",
      sessionKeyHash: "sess",
      pid: 99,
      startedAt: "2026-08-24T00:00:00.000Z",
      workers: [],
      registrations: [],
      ...(health == null ? {} : { requestHealth: health }),
    }),
    ceiling: UNBOUNDED_HOST_CEILING,
    rss: {},
    sampledAt: null,
    now: "2026-08-24T12:00:00.000Z",
  });
}

const beat = (overrides: Partial<RedskilledRequestHealth>): RedskilledRequestHealth => ({
  status: "healthy",
  consecutive_misses: 0,
  miss_threshold: 3,
  last_probe_at: "2026-08-24T11:59:58.000Z",
  last_success_at: "2026-08-24T11:59:58.000Z",
  last_failure_at: null,
  detail: "the daemon answered its own socket",
  ...overrides,
});

describe("an idle host's staleness derives from the daemon's own beat", () => {
  it("stays fresh with a healthy beat, and says why", () => {
    const staleness = idlePayload(beat({})).staleness;

    expect(staleness.stale).toBe(false);
    expect(staleness.reason).toContain("the daemon's own beat is 2000ms old and healthy");
  });

  it("is stale, not calm, when the daemon's own beat is degraded", () => {
    const staleness = idlePayload(beat({
      status: "degraded",
      consecutive_misses: 4,
      detail: "the daemon has missed 4 probes of its own socket",
    })).staleness;

    expect(staleness.stale).toBe(true);
    expect(staleness.reason).toContain("degraded");
    expect(staleness.reason).toContain("missed 4 probes");
  });

  it("is stale when the beat exists but never succeeded", () => {
    const staleness = idlePayload(beat({ last_success_at: null })).staleness;

    expect(staleness.stale).toBe(true);
    expect(staleness.reason).toContain("unproven");
  });

  it("keeps the old calm answer when the daemon reports no beat at all", () => {
    // A daemon from before request health existed still serves this payload;
    // inventing staleness for it would cry wolf on every older host.
    const staleness = idlePayload().staleness;

    expect(staleness.stale).toBe(false);
    expect(staleness.reason).toContain("nothing to measure");
  });
});
