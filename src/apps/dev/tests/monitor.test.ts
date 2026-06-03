import { describe, expect, it } from "vitest";
import {
  renderCompactDashboard,
  renderWorkerCompactLine,
  type CompactWorker,
} from "../src/core/monitor.js";
import {
  runMirrorPlan,
  parseTrackedJsonl,
  workersToDesired,
} from "../src/commands/monitor.js";
import type { MirrorCall } from "../src/core/mirror.js";

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
  diffAdded: 10,
  diffRemoved: 3,
  ...over,
});

describe("monitor — compact line", () => {
  it("renders a single live worker line in the documented shape", () => {
    // started 2026-05-30T11:00:00Z = 1780138800; now +1800s (30 min)
    const line = renderWorkerCompactLine(baseWorker(), 1780140600);
    expect(line).toBe(
      "wAAAA [live] claude  issues 1/4  #42 do the thing  stage:impl  00:30:00  +10 -3",
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

  it("labels the counter as issues closed/total, with no misleading percent", () => {
    const w = baseWorker({
      state: { ...baseWorker().state, total: 3, done: 1 },
    });
    const line = renderWorkerCompactLine(w, 1780140600);
    expect(line).toContain("issues 1/3");
    expect(line).not.toContain("%");
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

  it("renders the +A -R diff volume from the numeric fields", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ diffAdded: 320, diffRemoved: 47 }),
      1780140600,
    );
    expect(line.endsWith("+320 -47")).toBe(true);
  });

  it("always renders the diff volume, defaulting to +0 -0 when absent", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ diffAdded: undefined, diffRemoved: undefined }),
      1780140600,
    );
    expect(line.endsWith("+0 -0")).toBe(true);
  });

  it("appends blk: and fail: flags when present", () => {
    const w = baseWorker({
      state: { ...baseWorker().state, blocked: 2, failed: 1 },
    });
    const line = renderWorkerCompactLine(w, 1780140600);
    expect(line).toContain("blk:2");
    expect(line).toContain("fail:1");
  });

  it("renders idle when there is no current issue, still carrying the diff volume", () => {
    const w = baseWorker({
      state: {
        ...baseWorker().state,
        current: { number: "", title: "", stage: "", started_at: "" },
      },
      diffAdded: 18,
      diffRemoved: 2,
    });
    const line = renderWorkerCompactLine(w, 1780140600);
    expect(line).toContain("idle");
    expect(line).not.toContain("#");
    expect(line.endsWith("+18 -2")).toBe(true);
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

  it("suffixes the header with the fleet-wide diff total, summed over workers", () => {
    const a = baseWorker({ diffAdded: 320, diffRemoved: 47 });
    const b = baseWorker({
      state: { ...baseWorker().state, worker_id: "wBBBB" },
      diffAdded: 18,
      diffRemoved: 2,
    });
    const out = renderCompactDashboard([a, b], events, 1780140600);
    const lines = out.split("\n");
    expect(lines[0]).toContain("Δ fleet +338 -49");
  });

  it("renders the fleet total as +0 -0 even with zero workers", () => {
    const out = renderCompactDashboard([], events, 1780140600);
    const lines = out.split("\n");
    expect(lines[0]).toContain("Δ fleet +0 -0");
    expect(out).toContain("workers: (none");
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

describe("monitor — mirror plan", () => {
  const liveWorker = (
    worker_id: string,
    number: number,
    title: string,
    stage: string,
    live = true,
  ): CompactWorker =>
    baseWorker({
      state: {
        ...baseWorker().state,
        worker_id,
        current: { number, title, stage, started_at: "2026-05-30T11:00:00Z" },
      },
      live,
    });

  const parse = (out: string): MirrorCall[] =>
    out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as MirrorCall);

  it("cold reconcile: a new live worker emits a TaskCreate", () => {
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "do thing", "impl")], "");
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "TaskCreate",
      key: "wAAAA:42",
      title: "#42 wAAAA — do thing",
      description: "stage: impl",
      state: "in_progress",
    });
  });

  it("stage change emits a TaskUpdate carrying the new stage", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl" });
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "tests")], tracked);
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "TaskUpdate",
      key: "wAAAA:42",
      description: "stage: tests",
      state: "in_progress",
    });
  });

  it("terminal (non-live) tracked worker completes", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl" });
    const out = runMirrorPlan(
      [liveWorker("wAAAA", 42, "t", "impl", false)],
      tracked,
    );
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "TaskUpdate",
      key: "wAAAA:42",
      state: "completed",
    });
  });

  it("tracked worker absent from desired completes", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl" });
    const out = runMirrorPlan([], tracked);
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: "TaskUpdate", key: "wAAAA:42", state: "completed" });
  });

  it("no change emits no output (idempotent)", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl" });
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "impl")], tracked);
    expect(out).toBe("");
  });

  it("codex runner falls back to an empty plan (no native surface)", () => {
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "impl")], "", {
      codex: true,
    });
    expect(out).toBe("");
  });

  it("workersToDesired omits idle workers and maps liveness", () => {
    const desired = workersToDesired([
      liveWorker("wAAAA", 42, "t", "impl"),
      baseWorker({
        state: {
          ...baseWorker().state,
          worker_id: "wIDLE",
          current: { number: "", title: "", stage: "", started_at: "" },
        },
      }),
      liveWorker("wDEAD", 7, "t", "impl", false),
    ]);
    expect(desired.map((d) => d.worker_id)).toEqual(["wAAAA", "wDEAD"]);
    expect(desired[0]!.status).toBe("running");
    expect(desired[1]!.status).toBe("gone");
  });

  it("parseTrackedJsonl skips blank/garbage lines and tolerates missing stage", () => {
    const text = '\n{"key":"a:1","stage":"impl"}\nnot json\n{"stage":"x"}\n{"key":"b:2"}\n';
    expect(parseTrackedJsonl(text)).toEqual([
      { key: "a:1", stage: "impl" },
      { key: "b:2", stage: "" },
    ]);
  });
});
