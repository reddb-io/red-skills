import { describe, expect, it } from "vitest";
import {
  renderCompactDashboard,
  renderCompactDashboardToon,
  renderFleetLine,
  renderSlotDetails,
  renderWorkerCompactLine,
  type FleetState,
  type CompactWorker,
  type MonitorRemote,
} from "../src/core/monitor.js";
import {
  monitorCommand,
  runMirrorPlan,
  parseTrackedJsonl,
  workersToDesired,
} from "../src/commands/monitor.js";
import type { MirrorCall, MirrorFallbackNotice } from "../src/core/mirror.js";

// Shared fixture fixtureEvents used across multiple test suites (tick_at, remote facts).
const fixtureEvents = [
  { event: "done" as const, epoch: 1780137000 },
  { event: "done" as const, epoch: 1780137000 },
  { event: "blocked" as const, epoch: 1780137000 },
];

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

const baseFleet = (over: Partial<FleetState> = {}): FleetState => ({
  ts: "2026-05-30T11:00:00Z",
  epoch: 1780138800,
  runner: "claude",
  readyForAgent: 0,
  slotsBusy: 0,
  slotsFree: 2,
  slotsTotal: 2,
  slotsParked: 0,
  spawnsThisTick: 0,
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

  it("appends per-worker token spend (and $cost when reported) when usage streamed", () => {
    const base = baseWorker();
    const withCost = baseWorker({
      state: {
        ...base.state,
        current: { ...base.state.current, input_tokens: 15479, output_tokens: 184, cost_usd: 0.07 },
      },
    });
    expect(renderWorkerCompactLine(withCost, 1780140600)).toContain("tok:15479/184 $0.07");
    // no cost reported → tokens only, no $ fragment
    const noUsd = baseWorker({
      state: {
        ...base.state,
        current: { ...base.state.current, input_tokens: 100, output_tokens: 20, cost_usd: 0 },
      },
    });
    const line = renderWorkerCompactLine(noUsd, 1780140600);
    expect(line).toContain("tok:100/20");
    expect(line).not.toContain("$");
    // no usage at all → no cost fragment (back-compat with the documented shape)
    expect(renderWorkerCompactLine(base, 1780140600)).not.toContain("tok:");
  });

  it("appends activity counters and cursor-backed log line counts", () => {
    const base = baseWorker();
    const line = renderWorkerCompactLine(
      baseWorker({
        state: {
          ...base.state,
          current: {
            ...base.state.current,
            tools_called_count: 39,
            reasoning_events: 4,
            text_chunk_count: 112,
            waiting_count: 2,
          },
        },
        logLines: 540,
        logNewLines: 12,
      }),
      1780140600,
    );
    expect(line).toContain("tools:39");
    expect(line).toContain("reason:4");
    expect(line).toContain("text:112");
    expect(line).toContain("wait:2");
    expect(line).toContain("log:540(+12)");
  });

  it("flags a non-live worker as stale", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ live: false }),
      1780140600,
    );
    expect(line).toContain("[stale]");
    expect(line).not.toContain("[live]");
  });

  it("live-fresh worker (active + pid-live) renders [live]", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ live: true, pidLive: true }),
      1780140600,
    );
    expect(line).toContain("[live]");
    expect(line).not.toContain("[stale]");
    expect(line).not.toContain("[quiet]");
  });

  it("live-quiet worker (pid-live but agent-lane stale) renders [quiet], not [stale]", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ live: false, pidLive: true }),
      1780140600,
    );
    expect(line).toContain("[quiet]");
    expect(line).not.toContain("[stale]");
    expect(line).not.toContain("[live]");
  });

  it("dead/finished worker (pid does not resolve, pid=0) renders [stale]", () => {
    const line = renderWorkerCompactLine(
      baseWorker({ live: false, pidLive: false }),
      1780140600,
    );
    expect(line).toContain("[stale]");
    expect(line).not.toContain("[live]");
    expect(line).not.toContain("[quiet]");
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
  // now = 1780140600; fixtureEvents one hour earlier are inside the 48h window.
  const fixtureEvents = [
    { event: "done" as const, epoch: 1780137000 },
    { event: "done" as const, epoch: 1780137000 },
    { event: "blocked" as const, epoch: 1780137000 },
  ];

  it("emits the 48h sparkline header as the first line", () => {
    const out = renderCompactDashboard([baseWorker()], fixtureEvents, 1780140600);
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
    const out = renderCompactDashboard([a, b], fixtureEvents, 1780140600);
    const lines = out.split("\n");
    expect(lines[0]).toContain("Δ fleet +338 -49");
  });

  it("renders the fleet total as +0 -0 even with zero workers", () => {
    const out = renderCompactDashboard([], fixtureEvents, 1780140600);
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
    const out = renderCompactDashboard([later, earlier], fixtureEvents, 1780140600);
    const lines = out.split("\n");
    const aIdx = lines.findIndex((l) => l.startsWith("wAAAA"));
    const bIdx = lines.findIndex((l) => l.startsWith("wBBBB"));
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it("renders a (none …) line when there are zero workers", () => {
    const out = renderCompactDashboard([], fixtureEvents, 1780140600);
    const lines = out.split("\n");
    expect(lines[0].startsWith("48h:")).toBe(true);
    expect(out).toContain("workers: (none");
  });

  describe("TOON (default agent-facing render)", () => {
    it("renders one worker as a tabular row, preserving aggregates and sparkline", () => {
      const out = renderCompactDashboardToon([baseWorker()], fixtureEvents, 1780140600);
      expect(out).toContain("sparkline:");
      expect(out).toContain("diff_added: 10");
      expect(out).toContain("diff_removed: 3");
      // The worker table names columns once, then one bare CSV row per worker.
      expect(out).toContain(
        "workers[1]{id,state,runner,issue,stage,done,total,blocked,failed,elapsed,added,removed,in_tok,out_tok,cost_usd,tools,reason,text,wait,log}:",
      );
      expect(out).toContain('wAAAA,live,claude,42,impl,1,4,0,0,"00:30:00",10,3,0,0,0,0,0,0,0,0');
    });

    it("preserves the per-source origin counts from #930 as a sources table", () => {
      const a = baseWorker({ state: { ...baseWorker().state, worker_id: "wA", origin: "afk" } });
      const b = baseWorker({ state: { ...baseWorker().state, worker_id: "wB", origin: "go" } });
      const c = baseWorker({ state: { ...baseWorker().state, worker_id: "wC", origin: "afk" } });
      const out = renderCompactDashboardToon([a, b, c], fixtureEvents, 1780140600);
      expect(out).toContain("sources[2]{origin,count}:");
      expect(out).toContain("  afk,2");
      expect(out).toContain("  go,1");
    });

    it("emits a definitive empty state for an empty fleet", () => {
      const out = renderCompactDashboardToon([], fixtureEvents, 1780140600);
      expect(out).toContain("workers[0]:");
      expect(out).toContain("sources[0]:");
    });

    it("includes the fleet status block when a fleet state is present", () => {
      const out = renderCompactDashboardToon([], fixtureEvents, 1780138815, baseFleet());
      expect(out).toContain("fleet:");
      expect(out).toContain("  status: idle");
      expect(out).toContain("  ready: 0");
    });

    it("is materially cheaper than JSON for a typical multi-worker board (#995)", () => {
      // The token win is the whole point of TOON as the default agent-facing
      // render (#995): the worker table names its 20 columns ONCE, where JSON
      // repeats every field name on every row. Guard the win so a future change
      // that regresses the encoder back toward per-row key repetition is caught.
      const board = Array.from({ length: 6 }, (_, i) =>
        baseWorker({ state: { ...baseWorker().state, worker_id: `w${i}` } }),
      );
      const toon = renderCompactDashboardToon(board, fixtureEvents, 1780140600);
      const json = JSON.stringify(board);
      expect(toon.length).toBeLessThan(json.length);
    });
  });

  it("surfaces a healthy idle fleet last-tick line", () => {
    const out = renderCompactDashboard([], fixtureEvents, 1780138815, baseFleet());
    expect(out.split("\n")[1]).toBe(
      "fleet [idle] last ticked 00:00:15 ago  ready:0  slots busy:0 free:2 parked:0  spawns:0",
    );
  });

  it("flags a stale fleet as wedged, distinct from healthy idle", () => {
    const line = renderFleetLine(baseFleet({ readyForAgent: 7, slotsBusy: 0, slotsFree: 2 }), 1780139001);
    expect(line).toContain("fleet [wedged]");
    expect(line).toContain("last ticked 00:03:21 ago");
    expect(line).toContain("ready:7");
    expect(line).toContain("parked:0");
  });

  it("shows a non-stale fleet with queued or busy work as draining", () => {
    const line = renderFleetLine(baseFleet({ readyForAgent: 7, slotsBusy: 1, slotsFree: 1, spawnsThisTick: 1 }), 1780138815);
    expect(line).toBe(
      "fleet [draining] last ticked 00:00:15 ago  ready:7  slots busy:1 free:1 parked:0  spawns:1",
    );
  });

  it("carries parked:N unconditionally — zero when all slots closed", () => {
    const line = renderFleetLine(baseFleet(), 1780138815);
    expect(line).toContain("parked:0");
  });

  it("carries parked:2 for a degraded fleet with two tripped slots", () => {
    const line = renderFleetLine(
      baseFleet({ slotsBusy: 1, slotsFree: 0, slotsTotal: 3, slotsParked: 2 }),
      1780138815,
    );
    expect(line).toContain("parked:2");
  });

  it("renders per-slot state for an open (circuit-tripped) slot with retry countdown", () => {
    const fleet = baseFleet({
      slotsParked: 1,
      slotDetails: [{ index: 1, status: "open", retryAt: 1780138815 + 83 }],
    });
    const lines = renderSlotDetails(fleet, 1780138815);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("  slot 1 open  retry in 00:01:23");
  });

  it("renders per-slot state for a half-open slot (probe running)", () => {
    const fleet = baseFleet({
      slotsParked: 1,
      slotDetails: [{ index: 0, status: "half-open" }],
    });
    const lines = renderSlotDetails(fleet, 1780138815);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("  slot 0 half-open  (probing)");
  });

  it("renders per-slot state for an idle-parked slot", () => {
    const fleet = baseFleet({
      slotsParked: 1,
      slotDetails: [{ index: 2, status: "idle-parked" }],
    });
    const lines = renderSlotDetails(fleet, 1780138815);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("  slot 2 idle-parked  (queue empty)");
  });

  it("returns no slot-detail lines when all slots are closed", () => {
    expect(renderSlotDetails(baseFleet(), 1780138815)).toHaveLength(0);
    expect(renderSlotDetails(baseFleet({ slotDetails: [] }), 1780138815)).toHaveLength(0);
  });

  it("compact dashboard includes slot details after the fleet line when slots are parked", () => {
    const fleet = baseFleet({
      slotsParked: 1,
      slotDetails: [{ index: 0, status: "open", retryAt: 1780138815 + 60 }],
    });
    const out = renderCompactDashboard([], fixtureEvents, 1780138815, fleet);
    const lines = out.split("\n");
    const fleetIdx = lines.findIndex((l) => l.startsWith("fleet "));
    expect(fleetIdx).toBeGreaterThanOrEqual(0);
    expect(lines[fleetIdx + 1]).toBe("  slot 0 open  retry in 00:01:00");
  });
});

describe("monitor — mirror plan", () => {
  const liveWorker = (
    worker_id: string,
    number: number,
    title: string,
    stage: string,
    live = true,
    phase = "coding",
  ): CompactWorker =>
    baseWorker({
      state: {
        ...baseWorker().state,
        worker_id,
        current: { number, title, slug: title, stage, phase, started_at: "2026-05-30T11:00:00Z" },
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
      title: "wAAAA [2/5 coding] #42 do thing",
      description: "stage: impl",
      state: "in_progress",
    });
  });

  it("stage change emits a TaskUpdate carrying the new stage", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl", phase: "coding" });
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "tests")], tracked);
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "TaskUpdate",
      key: "wAAAA:42",
      description: "stage: tests",
      title: "wAAAA [2/5 coding] #42 t",
      state: "in_progress",
    });
  });

  it("phase change emits a TaskUpdate that re-titles the macro phase", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl", phase: "coding" });
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "impl", true, "validating")], tracked);
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "TaskUpdate",
      key: "wAAAA:42",
      title: "wAAAA [3/5 validating] #42 t",
      state: "in_progress",
    });
  });

  it("terminal (non-live) tracked worker completes", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl", phase: "coding" });
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

  it("quiet but pid-live tracked worker stays in progress instead of completing", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "tests", phase: "validating" });
    const out = runMirrorPlan(
      [
        baseWorker({
          state: {
            ...baseWorker().state,
            worker_id: "wAAAA",
            current: {
              number: 42,
              title: "t",
              slug: "t",
              stage: "tests",
              phase: "validating",
              started_at: "2026-05-30T11:00:00Z",
            },
          },
          live: false,
          pidLive: true,
        }),
      ],
      tracked,
    );
    expect(out).toBe("");
  });

  it("terminal (non-live) blocked worker fails with a [blocked] title", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl", phase: "coding" });
    const out = runMirrorPlan(
      [liveWorker("wAAAA", 42, "t", "impl", false, "blocked")],
      tracked,
    );
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "TaskUpdate",
      key: "wAAAA:42",
      title: "wAAAA [blocked] #42 t",
      state: "failed",
    });
  });

  it("tracked worker absent from desired completes", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl", phase: "coding" });
    const out = runMirrorPlan([], tracked);
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: "TaskUpdate", key: "wAAAA:42", state: "completed" });
  });

  it("no change emits no output (idempotent)", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", stage: "impl", phase: "coding" });
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "impl")], tracked);
    expect(out).toBe("");
  });

  it("codex runner emits a fallback notice (no native task calls)", () => {
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "impl")], "", {
      codex: true,
    });
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    const notice = JSON.parse(lines[0]!) as MirrorFallbackNotice;
    expect(notice.signal).toBe("fallback-notice");
    expect(notice.message).toContain("no native task surface");
    // no task call descriptors — criterion 2
    expect(notice).not.toHaveProperty("call");
  });

  it("codex host (via host option) emits the same fallback notice", () => {
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "impl")], "", {
      host: "codex",
    });
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ signal: "fallback-notice" });
  });

  it("opencode is a headless runner: no native task calls are ever emitted", () => {
    // A fresh live worker would be a TaskCreate under Claude; under the headless
    // OpenCode runner there is no host session to mirror into, so the plan is empty.
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "impl")], "", {
      host: "opencode",
    });
    expect(out).toBe("");
  });

  it("claude host emits the native TaskCreate plan (matrix sanity)", () => {
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "do thing", "impl")], "", {
      host: "claude",
    });
    expect(parse(out)).toHaveLength(1);
    expect(parse(out)[0]).toMatchObject({ call: "TaskCreate", key: "wAAAA:42" });
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
      baseWorker({
        state: {
          ...baseWorker().state,
          worker_id: "wQUIET",
          current: { number: 8, title: "q", stage: "tests", started_at: "2026-05-30T11:00:00Z" },
        },
        live: false,
        pidLive: true,
      }),
    ]);
    expect(desired.map((d) => d.worker_id)).toEqual(["wAAAA", "wDEAD", "wQUIET"]);
    expect(desired[0]!.status).toBe("running");
    expect(desired[1]!.status).toBe("gone");
    expect(desired[2]!.status).toBe("running");
  });

  it("parseTrackedJsonl skips blank/garbage lines and tolerates missing stage/phase", () => {
    const text =
      '\n{"key":"a:1","stage":"impl","phase":"coding"}\nnot json\n{"stage":"x"}\n{"key":"b:2"}\n';
    expect(parseTrackedJsonl(text)).toEqual([
      { key: "a:1", stage: "impl", phase: "coding" },
      { key: "b:2", stage: "", phase: "" },
    ]);
  });
});

// Helpers shared by the monitorCommand integration tests below.
function makeMockStdout(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Buffer) {
      chunks.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { chunks, stream };
}

// An async-iterable stdin that immediately ends (no piped input).
const emptyStdin = {
  async *[Symbol.asyncIterator]() {},
} as unknown as NodeJS.ReadableStream;

describe("monitorCommand — Codex fallback path (issue #887)", () => {
  it("--mirror-plan --runner codex writes the fallback notice to stdout", async () => {
    const { chunks, stream } = makeMockStdout();
    const code = await monitorCommand(
      ["--mirror-plan", "--runner", "codex"],
      "/tmp",
      stream,
      emptyStdin,
    );
    expect(code).toBe(0);
    const output = chunks.join("");
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const notice = records.find((r) => r["signal"] === "fallback-notice");
    expect(notice).toBeDefined();
    expect(String(notice!["message"])).toContain("no native task surface");
  });

  it("--mirror-plan --codex (legacy flag) also writes the fallback notice", async () => {
    const { chunks, stream } = makeMockStdout();
    await monitorCommand(["--mirror-plan", "--codex"], "/tmp", stream, emptyStdin);
    const output = chunks.join("");
    const records = output
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.some((r) => r["signal"] === "fallback-notice")).toBe(true);
  });

  it("codex fallback notice contains no TaskCreate or TaskUpdate call descriptors", async () => {
    const { chunks, stream } = makeMockStdout();
    await monitorCommand(
      ["--mirror-plan", "--runner", "codex"],
      "/tmp",
      stream,
      emptyStdin,
    );
    const output = chunks.join("");
    const records = output
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const taskCalls = records.filter(
      (r) => r["call"] === "TaskCreate" || r["call"] === "TaskUpdate",
    );
    expect(taskCalls).toHaveLength(0);
  });

  it("monitor --mirror-plan --runner codex is non-crashing and read-only (exit 0)", async () => {
    const { stream } = makeMockStdout();
    await expect(
      monitorCommand(["--mirror-plan", "--runner", "codex"], "/tmp", stream, emptyStdin),
    ).resolves.toBe(0);
  });
});

// now = 1780140600 → new Date(1780140600 * 1000).toISOString() = "2026-05-30T11:30:00.000Z"
const NOW_ISO = "2026-05-30T11:30:00.000Z";

describe("monitor — tick_at (standing wall-clock rule)", () => {
  it("TOON output includes tick_at with the ISO wall-clock time", () => {
    const out = renderCompactDashboardToon([], fixtureEvents, 1780140600);
    // TOON quotes strings that contain ':' — the ISO date is wrapped in quotes.
    expect(out).toContain(`tick_at: "${NOW_ISO}"`);
  });

  it("plain output includes tick at line with ISO wall-clock time", () => {
    const out = renderCompactDashboard([], fixtureEvents, 1780140600);
    expect(out).toContain(`tick at: ${NOW_ISO}`);
  });

  it("tick_at reflects the injected now (deterministic, no live clock)", () => {
    const out1 = renderCompactDashboardToon([], fixtureEvents, 1780138800);
    const out2 = renderCompactDashboardToon([], fixtureEvents, 1780140600);
    expect(out1).toContain('"2026-05-30T11:00:00.000Z"');
    expect(out2).toContain(`"${NOW_ISO}"`);
  });
});

describe("monitor — remote facts age markers (#1029)", () => {
  const freshRemote: MonitorRemote = { queue: 3, human: 1, cacheAgeS: 20, stale: false };
  const staleRemote: MonitorRemote = { queue: 5, human: 2, cacheAgeS: 90, stale: true };

  it("TOON output includes remote queue/human when provided", () => {
    const out = renderCompactDashboardToon([baseWorker()], fixtureEvents, 1780140600, null, freshRemote);
    expect(out).toContain("queue: 3");
    expect(out).toContain("human: 1");
    expect(out).toContain("cache_age_s: 20");
    expect(out).toContain("stale: 0");
  });

  it("TOON output marks remote as stale when cache age exceeds TTL", () => {
    const out = renderCompactDashboardToon([baseWorker()], fixtureEvents, 1780140600, null, staleRemote);
    expect(out).toContain("stale: 1");
    expect(out).toContain("cache_age_s: 90");
    expect(out).toContain("queue: 5");
  });

  it("plain output shows queue/human with stale marker when cache is old", () => {
    const out = renderCompactDashboard([baseWorker()], fixtureEvents, 1780140600, null, staleRemote);
    expect(out).toContain("queue:5");
    expect(out).toContain("human:2");
    expect(out).toContain("[stale");
  });

  it("plain output shows queue/human without stale marker when cache is fresh", () => {
    const out = renderCompactDashboard([baseWorker()], fixtureEvents, 1780140600, null, freshRemote);
    expect(out).toContain("queue:3");
    expect(out).toContain("human:1");
    expect(out).not.toContain("[stale");
  });

  it("TOON output has no remote block when remote is absent", () => {
    const out = renderCompactDashboardToon([baseWorker()], fixtureEvents, 1780140600);
    expect(out).not.toContain("remote:");
  });

  it("plain output has no queue/human line when remote is absent", () => {
    const out = renderCompactDashboard([baseWorker()], fixtureEvents, 1780140600);
    expect(out).not.toContain("queue:");
    expect(out).not.toContain("human:");
  });
});
