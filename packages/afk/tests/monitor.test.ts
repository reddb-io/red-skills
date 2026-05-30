import { describe, expect, it } from "vitest";
import {
  renderCompactDashboard,
  renderWorkerCompactLine,
  type CompactWorker,
} from "../src/core/monitor.js";

const baseWorker = (over: Partial<CompactWorker> = {}): CompactWorker => ({
  state: {
    worker_id: "wAAAA",
    pid: 100,
    runner: "claude",
    started_at: "",
    total: 4,
    done: 1,
    blocked: 0,
    failed: 0,
    current: {
      number: 42,
      title: "do the thing",
      stage: "impl",
      started_at: "2026-05-30T11:00:00Z",
    },
  },
  live: true,
  diff: "+10 -3",
  ...over,
});

describe("monitor — compact line", () => {
  it("renders a single live worker line in the documented shape", () => {
    // started 2026-05-30T11:00:00Z = 1780138800; now +1800s (30 min)
    const line = renderWorkerCompactLine(baseWorker(), 1780140600);
    expect(line).toBe(
      "wAAAA [live] claude  1/4 (25%)  #42 do the thing  stage:impl  00:30:00  +10 -3",
    );
  });

  it("flags a non-live worker as stale", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ live: false }),
      1780140600,
    );
    expect(line).toContain("[stale]");
    expect(line).not.toContain("[live]");
  });

  it("rounds percent down via integer division like bash", () => {
    const w = baseWorker({
      state: { ...baseWorker().state, total: 3, done: 1 },
    });
    const line = renderWorkerCompactLine(w, 1780140600);
    expect(line).toContain("1/3 (33%)");
  });

  it("formats elapsed as zero-padded HH:MM:SS from current.started_at", () => {
    const w = baseWorker({
      state: {
        ...baseWorker().state,
        current: {
          number: 1,
          title: "t",
          stage: "tests",
          started_at: "2026-05-30T10:00:00Z",
        },
      },
    });
    // started 2026-05-30T10:00:00Z = 1780135200; now +3661s
    const line = renderWorkerCompactLine(w, 1780138861);
    expect(line).toContain("01:01:01");
  });

  it("appends the +A -R diff verbatim when provided", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ diff: "+0 -0" }),
      1780140600,
    );
    expect(line.endsWith("+0 -0")).toBe(true);
  });

  it("omits the diff suffix when no diff is given", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ diff: undefined }),
      1780140600,
    );
    expect(line).not.toContain("+");
  });

  it("appends blk: and fail: flags when present", () => {
    const w = baseWorker({
      state: { ...baseWorker().state, blocked: 2, failed: 1 },
      diff: undefined,
    });
    const line = renderWorkerCompactLine(w, 1780140600);
    expect(line).toContain("blk:2");
    expect(line).toContain("fail:1");
  });

  it("renders idle when there is no current issue", () => {
    const w = baseWorker({
      state: {
        ...baseWorker().state,
        current: { number: "", title: "", stage: "", started_at: "" },
      },
      diff: undefined,
    });
    const line = renderWorkerCompactLine(w, 1780140600);
    expect(line).toContain("idle");
    expect(line).not.toContain("#");
  });
});

describe("monitor — compact dashboard", () => {
  // now = 1780140600; events one hour earlier are inside the 48h window.
  const events = [
    { event: "done" as const, epoch: 1780137000 },
    { event: "done" as const, epoch: 1780137000 },
    { event: "blocked" as const, epoch: 1780137000 },
  ];

  it("emits the 48h sparkline header as the first line", () => {
    const out = renderCompactDashboard([baseWorker()], events, 1780140600);
    const lines = out.split("\n");
    expect(lines[0].startsWith("48h:")).toBe(true);
    expect(lines[0]).toContain("(2 closed");
  });

  it("renders one line per worker, sorted by started_at", () => {
    const later = baseWorker({
      state: {
        ...baseWorker().state,
        worker_id: "wBBBB",
        started_at: "2026-05-30T12:00:00Z",
        current: {
          number: 7,
          title: "later one",
          stage: "review",
          started_at: "2026-05-30T12:00:00Z",
        },
      },
    });
    const earlier = baseWorker({
      state: {
        ...baseWorker().state,
        worker_id: "wAAAA",
        started_at: "2026-05-30T09:00:00Z",
      },
    });
    const out = renderCompactDashboard([later, earlier], events, 1780140600);
    const lines = out.split("\n");
    const aIdx = lines.findIndex((l) => l.startsWith("wAAAA"));
    const bIdx = lines.findIndex((l) => l.startsWith("wBBBB"));
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it("renders a (none …) line when there are zero workers", () => {
    const out = renderCompactDashboard([], events, 1780140600);
    const lines = out.split("\n");
    expect(lines[0].startsWith("48h:")).toBe(true);
    expect(out).toContain("workers: (none");
  });
});
