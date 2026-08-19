import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  detectSignals,
  throttle,
  watchStateOf,
  type NotificationPreferences,
} from "../src/watch/signals.js";
import type { HostSnapshot } from "../src/model/snapshot.js";
import type { RedskilledHostEvent } from "../src/redskilled/event-lane.js";
import { hostState, statuslinePayload, worker } from "./fixtures.js";

const PREFERENCES: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, workerBirth: true };

function snapshotOf(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    reachable: true,
    socketPath: "/tmp/rsk/d.sock",
    source: "a test",
    payload: statuslinePayload(),
    hostState: hostState(),
    dashboard: null,
    lane: { path: "/tmp/rsk/lane.toonl", exists: true, truncated: false, events: [] },
    error: null,
    readAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<RedskilledHostEvent>): RedskilledHostEvent {
  const kind = overrides.kind ?? overrides.event ?? "worker-death";
  return {
    version: 1,
    ts: "2026-08-01T10:00:00.000Z",
    kind,
    event: kind,
    worker_id: "wA1B2",
    project_label: "reddb-io/red-skills",
    pid: 4242,
    workspace_path: "/workspaces/red-skills",
    log_path: null,
    isolated: true,
    unit: null,
    memory_high: null,
    memory_max: null,
    cpu_weight: null,
    admission_verdict: null,
    phase: null,
    step: null,
    base_head_sha: null,
    base_commits_ahead: null,
    heal_kind: null,
    detail: null,
    reason: null,
    exit_code: 0,
    signal: null,
    systemd_result: null,
    memory_peak_bytes: null,
    memory_swap_peak_bytes: null,
    pids_peak: null,
    journal_tail: null,
    ...overrides,
  };
}

describe("what is worth interrupting for", () => {
  it("says nothing on the first read of a healthy host", () => {
    const snapshot = snapshotOf();
    const signals = detectSignals({
      previous: null,
      current: watchStateOf(snapshot),
      snapshot,
      preferences: PREFERENCES,
    });
    expect(signals).toEqual([]);
  });

  it("says the daemon is down on a first read that reached nothing", () => {
    const snapshot = snapshotOf({
      reachable: false,
      payload: null,
      hostState: null,
      error: { name: "RedskilledUnreachableError", message: "no host answered" },
    });
    const signals = detectSignals({
      previous: null,
      current: watchStateOf(snapshot),
      snapshot,
      preferences: PREFERENCES,
    });
    expect(signals.map((signal) => signal.key)).toEqual(["daemon-reach:down"]);
  });

  it("treats a daemon coming back as a fresh baseline, not a burst of news", () => {
    const down = snapshotOf({ reachable: false, payload: null, hostState: null, error: { name: "E", message: "gone" } });
    const up = snapshotOf({ payload: statuslinePayload({ workers: [worker({ worker_id: "wNEW1" })] }) });

    const signals = detectSignals({
      previous: watchStateOf(down),
      current: watchStateOf(up),
      snapshot: up,
      preferences: PREFERENCES,
    });

    // The host is back — and the Worker it holds is NOT announced as newly born.
    expect(signals.map((signal) => signal.key)).toEqual(["daemon-reach:up"]);
  });

  it("prefers the lane's account of a death over the set diff's silence", () => {
    const before = snapshotOf({ payload: statuslinePayload({ workers: [worker({ worker_id: "wDIES" })] }) });
    const after = snapshotOf({
      payload: statuslinePayload({ workers: [] }),
      lane: {
        path: "/tmp/rsk/lane.toonl",
        exists: true,
        truncated: false,
        events: [event({ worker_id: "wDIES", exit_code: 0 })],
      },
    });

    const signals = detectSignals({
      previous: watchStateOf(before),
      current: watchStateOf(after),
      snapshot: after,
      preferences: PREFERENCES,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.title).toBe("Worker finished");
    expect(signals[0]!.body).toContain("exit 0");
  });

  it("falls back to the set diff, and says the lane did not explain it", () => {
    const before = snapshotOf({ payload: statuslinePayload({ workers: [worker({ worker_id: "wGONE" })] }) });
    const after = snapshotOf({ payload: statuslinePayload({ workers: [] }) });

    const signals = detectSignals({
      previous: watchStateOf(before),
      current: watchStateOf(after),
      snapshot: after,
      preferences: PREFERENCES,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.body).toContain("the event lane did not say how it ended");
  });

  it("calls a budget kill by its name and not a death", () => {
    const before = snapshotOf({ payload: statuslinePayload({ workers: [worker({ worker_id: "wFAT1" })] }) });
    const after = snapshotOf({
      payload: statuslinePayload({ workers: [] }),
      lane: {
        path: "/tmp/rsk/lane.toonl",
        exists: true,
        truncated: false,
        events: [event({ worker_id: "wFAT1", event: "worker-budget-kill", detail: "2.4G over MemoryMax", exit_code: null })],
      },
    });

    const signals = detectSignals({
      previous: watchStateOf(before),
      current: watchStateOf(after),
      snapshot: after,
      preferences: PREFERENCES,
    });

    expect(signals.map((signal) => signal.kind)).toEqual(["worker-budget-kill"]);
    expect(signals[0]!.body).toContain("2.4G over MemoryMax");
  });

  it("fires budget pressure on the crossing, and never again while it holds", () => {
    const calm = snapshotOf({ payload: statuslinePayload({ workers: [worker({ used_fraction: 0.5 })] }) });
    const crossed = snapshotOf({ payload: statuslinePayload({ workers: [worker({ used_fraction: 0.94 })] }) });
    const stillHigh = snapshotOf({ payload: statuslinePayload({ workers: [worker({ used_fraction: 0.96 })] }) });

    const first = detectSignals({
      previous: watchStateOf(calm),
      current: watchStateOf(crossed),
      snapshot: crossed,
      preferences: PREFERENCES,
    });
    expect(first.map((signal) => signal.kind)).toEqual(["budget-pressure"]);
    expect(first[0]!.body).toContain("94%");

    const second = detectSignals({
      previous: watchStateOf(crossed),
      current: watchStateOf(stillHigh),
      snapshot: stillHigh,
      preferences: PREFERENCES,
    });
    expect(second).toEqual([]);
  });

  it("announces a daemon restart rather than an evacuation", () => {
    const before = snapshotOf({ payload: statuslinePayload({ pid: 1 }) });
    const after = snapshotOf({ payload: statuslinePayload({ pid: 2 }) });

    const signals = detectSignals({
      previous: watchStateOf(before),
      current: watchStateOf(after),
      snapshot: after,
      preferences: PREFERENCES,
    });

    expect(signals.map((signal) => signal.key)).toEqual(["daemon-reach:pid:2"]);
    expect(signals[0]!.title).toBe("redskilled restarted");
  });

  it("reports a rising pull-request count, never the standing one", () => {
    const before = snapshotOf({ payload: statuslinePayload({ openPullRequests: 12 }) });
    const same = snapshotOf({ payload: statuslinePayload({ openPullRequests: 12 }) });
    const more = snapshotOf({ payload: statuslinePayload({ openPullRequests: 14 }) });

    expect(detectSignals({ previous: watchStateOf(before), current: watchStateOf(same), snapshot: same, preferences: PREFERENCES })).toEqual([]);

    const signals = detectSignals({ previous: watchStateOf(before), current: watchStateOf(more), snapshot: more, preferences: PREFERENCES });
    expect(signals.map((signal) => signal.kind)).toEqual(["pull-requests"]);
    expect(signals[0]!.body).toContain("2 more");
  });

  it("says a newer version was published, once", () => {
    const before = snapshotOf({ hostState: hostState({ newerPublished: 0 }) });
    const after = snapshotOf({ hostState: hostState({ newerPublished: 1, publishedVersion: "0.5.0" }) });

    const signals = detectSignals({
      previous: watchStateOf(before),
      current: watchStateOf(after),
      snapshot: after,
      preferences: PREFERENCES,
    });
    expect(signals.map((signal) => signal.kind)).toEqual(["upgrade"]);
    expect(signals[0]!.body).toBe("0.4.1 → 0.5.0");
  });

  it("obeys the operator: a disabled kind never reaches the editor", () => {
    const before = snapshotOf({ payload: statuslinePayload({ workers: [] }) });
    const after = snapshotOf({ payload: statuslinePayload({ workers: [worker({ worker_id: "wBORN" })] }) });

    const off = detectSignals({
      previous: watchStateOf(before),
      current: watchStateOf(after),
      snapshot: after,
      preferences: { ...PREFERENCES, workerBirth: false },
    });
    expect(off).toEqual([]);

    const on = detectSignals({
      previous: watchStateOf(before),
      current: watchStateOf(after),
      snapshot: after,
      preferences: PREFERENCES,
    });
    expect(on.map((signal) => signal.kind)).toEqual(["worker-birth"]);
  });
});

describe("the renotify window", () => {
  it("drops a repeat inside the window and lets it through after", () => {
    const signal = { kind: "staleness" as const, key: "staleness:on", title: "t", body: "b", severity: "warning" as const };

    const first = throttle([signal], {}, { renotifyMs: 60_000, now: "2026-08-01T10:00:00.000Z" });
    expect(first.signals).toHaveLength(1);

    const inside = throttle([signal], first.sentAt, { renotifyMs: 60_000, now: "2026-08-01T10:00:30.000Z" });
    expect(inside.signals).toEqual([]);

    const after = throttle([signal], first.sentAt, { renotifyMs: 60_000, now: "2026-08-01T10:02:00.000Z" });
    expect(after.signals).toHaveLength(1);
  });
});
