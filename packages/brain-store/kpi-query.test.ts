import { describe, expect, it } from "vitest";
import { KpiQuery } from "./kpi-query.js";
import type { ArtifactKind, StoredBrainArtifact } from "./schema.js";

interface SeedEvent {
  rid: number;
  /** ISO timestamp carried by the channel event (metadata.timestamp). */
  timestamp?: string;
  /** Ingestion time (created_at, epoch ms). */
  createdAt?: number;
  platform?: string;
  eventType?: string;
  target?: string;
  kind?: ArtifactKind;
}

function eventArtifact(seed: SeedEvent): StoredBrainArtifact {
  const createdAt = seed.createdAt ?? Date.parse(seed.timestamp ?? "2026-01-01T00:00:00.000Z");
  const metadata: Record<string, unknown> = {};
  if (seed.timestamp != null) metadata.timestamp = seed.timestamp;
  if (seed.platform != null) metadata.platform = seed.platform;
  if (seed.eventType != null) metadata.event_type = seed.eventType;
  if (seed.target != null) metadata.target = seed.target;
  return {
    rid: seed.rid,
    label: `evt-${seed.rid}`,
    kind: seed.kind ?? "event",
    properties: {
      id: `evt-${seed.rid}`,
      title: `event ${seed.rid}`,
      content: "seeded event",
      tags: ["channel-event"],
      created_at: createdAt,
      updated_at: createdAt,
      hash: `hash-${seed.rid}`,
      metadata,
    },
  };
}

describe("KpiQuery — time-windowed aggregation over kind:event artifacts", () => {
  it("returns a zero-filled daily series across the event time span", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-06-01T08:00:00.000Z" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-01T20:30:00.000Z" }),
      // gap on 2026-06-02 with no events
      eventArtifact({ rid: 3, timestamp: "2026-06-03T09:15:00.000Z" }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "day" });

    expect(result.kind).toBe("event");
    expect(result.interval).toBe("day");
    expect(result.timeField).toBe("event");
    expect(result.total).toBe(3);
    expect(result.series).toHaveLength(1);

    const overall = result.series[0];
    expect(overall.group).toBeNull();
    expect(overall.total).toBe(3);
    expect(overall.buckets.map((b) => ({ iso: b.startIso, count: b.count }))).toEqual([
      { iso: "2026-06-01T00:00:00.000Z", count: 2 },
      { iso: "2026-06-02T00:00:00.000Z", count: 0 },
      { iso: "2026-06-03T00:00:00.000Z", count: 1 },
    ]);
  });

  it("buckets into UTC-aligned hourly windows", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-06-01T08:05:00.000Z" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-01T08:55:00.000Z" }),
      eventArtifact({ rid: 3, timestamp: "2026-06-01T10:01:00.000Z" }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "hour" });

    expect(result.series[0].buckets).toEqual([
      { start: Date.UTC(2026, 5, 1, 8), startIso: "2026-06-01T08:00:00.000Z", count: 2 },
      { start: Date.UTC(2026, 5, 1, 9), startIso: "2026-06-01T09:00:00.000Z", count: 0 },
      { start: Date.UTC(2026, 5, 1, 10), startIso: "2026-06-01T10:00:00.000Z", count: 1 },
    ]);
  });

  it("aligns weekly windows to the ISO Monday", () => {
    // 2026-06-03 is a Wednesday → week start Monday 2026-06-01.
    // 2026-06-08 is the following Monday → its own week.
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-06-03T12:00:00.000Z" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-07T23:59:00.000Z" }),
      eventArtifact({ rid: 3, timestamp: "2026-06-08T00:00:00.000Z" }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "week" });

    expect(result.series[0].buckets).toEqual([
      { start: Date.UTC(2026, 5, 1), startIso: "2026-06-01T00:00:00.000Z", count: 2 },
      { start: Date.UTC(2026, 5, 8), startIso: "2026-06-08T00:00:00.000Z", count: 1 },
    ]);
  });

  it("aligns monthly windows to the first of each month", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-01-15T00:00:00.000Z" }),
      eventArtifact({ rid: 2, timestamp: "2026-03-02T00:00:00.000Z" }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "month" });

    expect(result.series[0].buckets).toEqual([
      { start: Date.UTC(2026, 0, 1), startIso: "2026-01-01T00:00:00.000Z", count: 1 },
      { start: Date.UTC(2026, 1, 1), startIso: "2026-02-01T00:00:00.000Z", count: 0 },
      { start: Date.UTC(2026, 2, 1), startIso: "2026-03-01T00:00:00.000Z", count: 1 },
    ]);
  });

  it("splits into per-group series sorted by total descending", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-06-01T01:00:00.000Z", platform: "slack" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-01T02:00:00.000Z", platform: "slack" }),
      eventArtifact({ rid: 3, timestamp: "2026-06-02T01:00:00.000Z", platform: "slack" }),
      eventArtifact({ rid: 4, timestamp: "2026-06-01T03:00:00.000Z", platform: "discord" }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "day", groupBy: "platform" });

    expect(result.total).toBe(4);
    expect(result.series.map((s) => ({ group: s.group, total: s.total }))).toEqual([
      { group: null, total: 4 },
      { group: "slack", total: 3 },
      { group: "discord", total: 1 },
    ]);
    // Every series shares the same window axis so the dashboard can align them.
    const widths = new Set(result.series.map((s) => s.buckets.length));
    expect(widths.size).toBe(1);
    const slack = result.series.find((s) => s.group === "slack");
    expect(slack?.buckets.map((b) => b.count)).toEqual([2, 1]);
    const discord = result.series.find((s) => s.group === "discord");
    expect(discord?.buckets.map((b) => b.count)).toEqual([1, 0]);
  });

  it("filters by platform, event type, and target before aggregating", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-06-01T01:00:00.000Z", platform: "slack", eventType: "message", target: "#eng" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-01T02:00:00.000Z", platform: "slack", eventType: "reaction", target: "#eng" }),
      eventArtifact({ rid: 3, timestamp: "2026-06-01T03:00:00.000Z", platform: "discord", eventType: "message", target: "#ops" }),
    ];

    const result = new KpiQuery(artifacts).events({
      interval: "day",
      platform: "slack",
      eventType: "message",
    });

    expect(result.total).toBe(1);
    expect(result.series[0].buckets).toEqual([
      { start: Date.UTC(2026, 5, 1), startIso: "2026-06-01T00:00:00.000Z", count: 1 },
    ]);
  });

  it("clamps the window axis to an explicit from/to range", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-05-01T00:00:00.000Z" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-02T00:00:00.000Z" }),
      eventArtifact({ rid: 3, timestamp: "2026-06-04T00:00:00.000Z" }),
      eventArtifact({ rid: 4, timestamp: "2026-07-01T00:00:00.000Z" }),
    ];

    const result = new KpiQuery(artifacts).events({
      interval: "day",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-05T00:00:00.000Z",
    });

    expect(result.total).toBe(2);
    expect(result.range).toEqual({
      from: Date.parse("2026-06-01T00:00:00.000Z"),
      to: Date.parse("2026-06-05T00:00:00.000Z"),
    });
    expect(result.series[0].buckets.map((b) => b.startIso)).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
      "2026-06-03T00:00:00.000Z",
      "2026-06-04T00:00:00.000Z",
      "2026-06-05T00:00:00.000Z",
    ]);
  });

  it("ignores non-event artifacts", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-06-01T00:00:00.000Z" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-01T00:00:00.000Z", kind: "decision" }),
      eventArtifact({ rid: 3, timestamp: "2026-06-01T00:00:00.000Z", kind: "note" }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "day" });

    expect(result.total).toBe(1);
  });

  it("falls back to created_at when an event carries no timestamp", () => {
    const artifacts = [
      eventArtifact({ rid: 1, createdAt: Date.UTC(2026, 5, 1, 6) }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "day" });

    expect(result.total).toBe(1);
    expect(result.series[0].buckets[0].startIso).toBe("2026-06-01T00:00:00.000Z");
  });

  it("buckets on ingestion time when timeField is 'ingested'", () => {
    const artifacts = [
      eventArtifact({
        rid: 1,
        timestamp: "2026-06-01T00:00:00.000Z",
        createdAt: Date.UTC(2026, 5, 5, 0),
      }),
    ];

    const result = new KpiQuery(artifacts).events({ interval: "day", timeField: "ingested" });

    expect(result.timeField).toBe("ingested");
    expect(result.series[0].buckets[0].startIso).toBe("2026-06-05T00:00:00.000Z");
  });

  it("returns an empty axis and zero total when there are no events", () => {
    const result = new KpiQuery([]).events({ interval: "day" });

    expect(result.total).toBe(0);
    expect(result.range).toEqual({ from: null, to: null });
    expect(result.series).toEqual([{ group: null, total: 0, buckets: [] }]);
  });

  it("is deterministic across repeated calls", () => {
    const artifacts = [
      eventArtifact({ rid: 1, timestamp: "2026-06-01T01:00:00.000Z", platform: "slack" }),
      eventArtifact({ rid: 2, timestamp: "2026-06-02T01:00:00.000Z", platform: "discord" }),
    ];
    const query = new KpiQuery(artifacts);

    const a = query.events({ interval: "day", groupBy: "platform" });
    const b = query.events({ interval: "day", groupBy: "platform" });

    expect(a).toEqual(b);
  });
});
