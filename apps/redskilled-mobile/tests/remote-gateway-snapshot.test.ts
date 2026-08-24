import { describe, expect, it } from "vitest";

import { snapshotFromStateAnswer } from "../src/transport/remote-operator-gateway";

describe("the state answer maps onto the app snapshot", () => {
  it("carries the v2 host block and published Worker facts through", () => {
    const snapshot = snapshotFromStateAnswer({
      version: 2,
      daemon_version: "4.2.0",
      workers: [{
        worker_id: "W1",
        project_label: "reddb-io/red-skills",
        started_at: "2026-08-23T12:00:00.000Z",
        phase: "coding",
        heartbeat_age_ms: 30_000,
        repository: "reddb-io/red-skills",
        ticket: "4321",
      }],
      host: {
        daemon_version: "4.2.0",
        started_at: "2026-08-23T08:00:00.000Z",
        worker_ceiling: 4,
        staleness: { stale: false, age_ms: 5_000, threshold_ms: 30_000, reason: "measured 5s ago" },
        generated_at: "2026-08-23T12:10:00.000Z",
      },
    });

    expect(snapshot).toEqual({
      workers: [{
        workerId: "W1",
        repository: "reddb-io/red-skills",
        ticket: "4321",
        startedAt: "2026-08-23T12:00:00.000Z",
        phase: "coding",
        heartbeatAgeMs: 30_000,
      }],
      daemonVersion: "4.2.0",
      generatedAt: "2026-08-23T12:10:00.000Z",
      staleness: { stale: false, ageMs: 5_000, reason: "measured 5s ago" },
    });
  });

  it("a v1-shaped answer yields null extras — it told us nothing, it is not broken", () => {
    const snapshot = snapshotFromStateAnswer({
      version: 2,
      daemon_version: "4.1.0",
      workers: [{
        worker_id: "W1",
        project_label: "reddb-io/red-skills",
        started_at: "2026-08-23T12:00:00.000Z",
      }],
    } as never);

    expect(snapshot.workers[0]).toEqual({
      workerId: "W1",
      repository: "reddb-io/red-skills",
      ticket: undefined,
      startedAt: "2026-08-23T12:00:00.000Z",
      phase: null,
      heartbeatAgeMs: null,
    });
    expect(snapshot.daemonVersion).toBe("4.1.0");
    expect(snapshot.staleness).toBeNull();
  });

  it("refuses an answer that is not a Worker state", () => {
    expect(() => snapshotFromStateAnswer({
      version: 1,
      worker_id: "W1",
      applied: true,
      detail: "stopped",
    })).toThrow("invalid Worker state");
  });
});
