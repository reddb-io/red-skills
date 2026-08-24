import { describe, expect, it } from "vitest";

import { PENDING_DISPATCH_GRACE_MS, reconcilePendingWorkers } from "../src/domain/worker-reconcile";

const now = Date.parse("2026-08-23T12:00:30.000Z");
const receipt = {
  workerId: "W42",
  repository: "reddb-io/red-skills",
  ticket: 42,
  startedAt: "2026-08-23T12:00:25.000Z",
  pending: true as const,
};

describe("pending dispatch rows reconcile against the Host's own list", () => {
  it("keeps a young receipt the Host has not listed yet", () => {
    const merged = reconcilePendingWorkers([], [receipt], now);
    expect(merged).toEqual([receipt]);
  });

  it("the Host's published row replaces the receipt the moment it appears", () => {
    const published = {
      workerId: "W42",
      repository: "reddb-io/red-skills",
      ticket: "42",
      startedAt: "2026-08-23T12:00:26.000Z",
      phase: "boot",
      heartbeatAgeMs: 1_000,
    };
    const merged = reconcilePendingWorkers([published], [receipt], now);
    expect(merged).toEqual([published]);
  });

  it("a receipt past the grace window is dropped, not kept as fiction", () => {
    const merged = reconcilePendingWorkers([], [receipt], now + PENDING_DISPATCH_GRACE_MS);
    expect(merged).toEqual([]);
  });
});
