import { describe, expect, it } from "vitest";
import {
  FLEET_HEARTBEAT_KIND,
  SILENT_HOST_THRESHOLD_S,
  aggregateFederatedFleetView,
} from "./federated-fleet-view.js";

const NOW_MS = Date.parse("2026-07-23T12:00:00.000Z");
const NOW_ISO = "2026-07-23T12:00:00.000Z";

function heartbeat(
  machineIdHash: string,
  at: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    at,
    kind: FLEET_HEARTBEAT_KIND,
    payload: {
      machine_id_hash: machineIdHash,
      fleet_name: "default",
      runner: "claude",
      target: 4,
      bundle_version: "2.78.0",
      slots: { busy: 2, free: 2, total: 4, parked: 0 },
      workers: [{ id: "wTST1", issue: "2344", activity: "editing" }],
      ready_for_agent: 6,
      ...overrides,
    },
  };
}

describe("aggregateFederatedFleetView", () => {
  it("returns empty output when no fleet heartbeat events exist", () => {
    expect(aggregateFederatedFleetView([], { nowMs: NOW_MS })).toEqual({
      hosts: [],
      total_busy: 0,
      total_free: 0,
      total_workers: 0,
    });
  });

  it("ignores events with kinds other than fleet heartbeat", () => {
    const result = aggregateFederatedFleetView(
      [
        {
          at: NOW_ISO,
          kind: "host.capability-profile.registered",
          payload: { machine_id_hash: "abc123def456" },
        },
        { at: NOW_ISO, kind: "github.delivery", payload: {} },
        { at: NOW_ISO, kind: "janitor.completed" },
      ],
      { nowMs: NOW_MS },
    );
    expect(result.hosts).toHaveLength(0);
  });

  it("ignores fleet heartbeat events missing machine_id_hash", () => {
    const result = aggregateFederatedFleetView(
      [{ at: NOW_ISO, kind: FLEET_HEARTBEAT_KIND, payload: { runner: "claude" } }],
      { nowMs: NOW_MS },
    );
    expect(result.hosts).toHaveLength(0);
  });

  // --- single-host degenerate case (AC2) ---

  it("single-host case: emits exactly one entry with the host marker and zero staleness", () => {
    const result = aggregateFederatedFleetView(
      [heartbeat("abc123def456", NOW_ISO)],
      { nowMs: NOW_MS },
    );

    expect(result.hosts).toHaveLength(1);
    const host = result.hosts[0]!;
    expect(host.machine_id_hash).toBe("abc123def456");
    expect(host.last_event_at).toBe(NOW_ISO);
    expect(host.last_event_age_s).toBe(0);
    expect(host.silent).toBe(false);
  });

  it("single-host degenerate case is byte-stable (pinned snapshot)", () => {
    const at = "2026-07-23T12:00:00.000Z";
    const nowMs = Date.parse(at);
    const result = aggregateFederatedFleetView(
      [
        heartbeat("abc123def456", at, {
          fleet_name: "default",
          runner: "claude",
          target: 4,
          bundle_version: "2.78.0",
          slots: { busy: 1, free: 3, total: 4, parked: 0 },
          workers: [{ id: "wTST1", issue: "2344", activity: "editing" }],
          ready_for_agent: 6,
        }),
      ],
      { nowMs },
    );

    expect(result).toEqual({
      hosts: [
        {
          machine_id_hash: "abc123def456",
          fleet_name: "default",
          runner: "claude",
          target: 4,
          bundle_version: "2.78.0",
          slots: { busy: 1, free: 3, total: 4, parked: 0 },
          workers: [{ id: "wTST1", issue: "2344", activity: "editing" }],
          ready_for_agent: 6,
          last_event_at: "2026-07-23T12:00:00.000Z",
          last_event_age_s: 0,
          silent: false,
        },
      ],
      total_busy: 1,
      total_free: 3,
      total_workers: 1,
    });
  });

  // --- multi-host aggregation (AC1) ---

  it("multi-host case: aggregates all hosts, ordered by last_event_at descending", () => {
    const events = [
      heartbeat("aaa000bbb111", "2026-07-23T12:00:00.000Z", {
        runner: "claude",
        slots: { busy: 2, free: 2, total: 4, parked: 0 },
        workers: [{ id: "wA01", issue: "2344", activity: "editing" }],
      }),
      heartbeat("ccc222ddd333", "2026-07-23T11:55:00.000Z", {
        runner: "codex",
        slots: { busy: 1, free: 1, total: 2, parked: 0 },
        workers: [],
      }),
      heartbeat("eee444fff555", "2026-07-23T11:50:00.000Z", {
        runner: "claude",
        slots: { busy: 0, free: 2, total: 2, parked: 2 },
        workers: [],
      }),
    ];
    const result = aggregateFederatedFleetView(events, { nowMs: NOW_MS });

    expect(result.hosts).toHaveLength(3);
    expect(result.hosts.map((h) => h.machine_id_hash)).toEqual([
      "aaa000bbb111",
      "ccc222ddd333",
      "eee444fff555",
    ]);
    expect(result.total_busy).toBe(3);
    expect(result.total_free).toBe(5);
    expect(result.total_workers).toBe(1);
  });

  it("multi-host case: every host entry carries a distinct host marker", () => {
    const result = aggregateFederatedFleetView(
      [
        heartbeat("aaa000bbb111", "2026-07-23T12:00:00.000Z"),
        heartbeat("ccc222ddd333", "2026-07-23T11:55:00.000Z"),
      ],
      { nowMs: NOW_MS },
    );
    const hashes = result.hosts.map((h) => h.machine_id_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("multi-host case: health and staleness fields are present on every entry", () => {
    const result = aggregateFederatedFleetView(
      [
        heartbeat("aaa000bbb111", "2026-07-23T12:00:00.000Z"),
        heartbeat("ccc222ddd333", "2026-07-23T11:55:00.000Z"),
      ],
      { nowMs: NOW_MS },
    );
    for (const host of result.hosts) {
      expect(host).toHaveProperty("last_event_at");
      expect(typeof host.last_event_age_s).toBe("number");
      expect(typeof host.silent).toBe("boolean");
    }
  });

  it("picks the latest event per host when multiple events exist for the same machine", () => {
    const events = [
      heartbeat("abc123def456", "2026-07-23T11:00:00.000Z", {
        runner: "codex",
        slots: { busy: 0, free: 2, total: 2, parked: 0 },
      }),
      heartbeat("abc123def456", "2026-07-23T12:00:00.000Z", {
        runner: "claude",
        slots: { busy: 1, free: 1, total: 2, parked: 0 },
      }),
    ];
    const result = aggregateFederatedFleetView(events, { nowMs: NOW_MS });

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]!.runner).toBe("claude");
    expect(result.hosts[0]!.last_event_at).toBe("2026-07-23T12:00:00.000Z");
  });

  // --- silent-host detection (AC3) ---

  it("silent-host detection: marks hosts whose age exceeds the threshold", () => {
    const events = [
      heartbeat("stale000host1", "2026-07-23T11:00:00.000Z"), // 3600s ago
      heartbeat("fresh000host2", "2026-07-23T11:59:00.000Z"), // 60s ago
    ];
    const result = aggregateFederatedFleetView(events, {
      nowMs: NOW_MS,
      silentThresholdS: 300,
    });

    const stale = result.hosts.find((h) => h.machine_id_hash === "stale000host1")!;
    const fresh = result.hosts.find((h) => h.machine_id_hash === "fresh000host2")!;

    expect(stale.silent).toBe(true);
    expect(stale.last_event_age_s).toBe(3600);
    expect(fresh.silent).toBe(false);
    expect(fresh.last_event_age_s).toBe(60);
  });

  it("silent-host threshold is exclusive: exactly at threshold is NOT silent", () => {
    const events = [
      heartbeat("borderhost11", "2026-07-23T11:55:00.000Z"), // exactly 300s ago
    ];
    const result = aggregateFederatedFleetView(events, {
      nowMs: NOW_MS,
      silentThresholdS: 300,
    });

    expect(result.hosts[0]!.last_event_age_s).toBe(300);
    expect(result.hosts[0]!.silent).toBe(false);
  });

  it("silent-host detection: default threshold is SILENT_HOST_THRESHOLD_S", () => {
    const events = [
      heartbeat("stale000host1", "2026-07-23T11:00:00.000Z"), // 3600s > 300s
    ];
    const result = aggregateFederatedFleetView(events, { nowMs: NOW_MS });

    expect(SILENT_HOST_THRESHOLD_S).toBe(300);
    expect(result.hosts[0]!.silent).toBe(true);
  });
});
