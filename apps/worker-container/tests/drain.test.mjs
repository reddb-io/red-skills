import { describe, expect, it } from "vitest";

import { drainVerdict, nextBackoffSeconds } from "../src/drain.mjs";

const status = (queue) => ({ context: { queue } });

describe("what a Project status snapshot means for the container's exit", () => {
  it("ends the run when the daemon holds no registration", () => {
    expect(drainVerdict(status({ registered: false, depth: 0, live: 0, freshness: "fresh" })).state)
      .toBe("unregistered");
  });

  it("keeps waiting while the reading is not fresh — an empty stale queue is not a drained one", () => {
    expect(drainVerdict(status({ registered: true, depth: 0, live: 0, freshness: "stale" })).state)
      .toBe("draining");
    expect(drainVerdict(status({ registered: true, depth: null, live: 0, freshness: "fresh" })).state)
      .toBe("draining");
  });

  it("keeps waiting while a Worker is live, even with an empty queue", () => {
    expect(drainVerdict(status({ registered: true, depth: 0, live: 1, freshness: "fresh" })).state)
      .toBe("draining");
  });

  it("is drained only when the queue is empty and nothing is live", () => {
    expect(drainVerdict(status({ registered: true, depth: 0, live: 0, freshness: "fresh" })).state)
      .toBe("drained");
  });

  it("reports the same empty queue as idle in loop mode, so the run does not end", () => {
    expect(drainVerdict(status({ registered: true, depth: 0, live: 0, freshness: "fresh" }), { loop: true }).state)
      .toBe("idle");
  });

  it("treats a snapshot with no queue at all as still draining", () => {
    expect(drainVerdict(undefined).state).toBe("draining");
  });

  it("doubles the idle backoff up to its ceiling", () => {
    expect(nextBackoffSeconds(60, 900)).toBe(120);
    expect(nextBackoffSeconds(800, 900)).toBe(900);
  });
});
