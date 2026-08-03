import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
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
      activity: "impl",
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
      "wAAAA [live] claude org=afk  issues 1/4  #42 do the thing  activity:impl  00:30:00  +10 -3",
    );
  });

  it("renders org=<afk|go> on the compact line (issue #1219), defaulting to afk when unstamped", () => {
    // Unstamped → org=afk.
    expect(renderWorkerCompactLine(baseWorker(), 1780140600)).toContain(" org=afk  ");
    // A /go worker carries origin: "go".
    const go = baseWorker({ state: { ...baseWorker().state, origin: "go" } });
    expect(renderWorkerCompactLine(go, 1780140600)).toContain(" org=go  ");
  });

  it("shows the classifier-selected model tier on the active worker row", () => {
    const base = baseWorker();
    const routed = baseWorker({
      state: {
        ...base.state,
        current: { ...base.state.current, model_tier: "simple" },
      },
    });

    expect(renderWorkerCompactLine(routed, 1780140600)).toContain(" tier:simple");
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
    expect(line).toContain("tls:39");
    expect(line).toContain("rsn:4");
    expect(line).toContain("txt:112");
    expect(line).not.toContain("tools:");
    expect(line).not.toContain("reason:");
    expect(line).not.toContain("text:");
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
          activity: "tests",
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
        current: { number: "", title: "", activity: "", started_at: "" },
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
          activity: "review",
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
      const decoded = decode(out) as {
        sparkline: string;
        diff_added: number;
        diff_removed: number;
        workers: Array<Record<string, unknown>>;
        summary: string;
      };
      expect(out).toContain("sparkline:");
      expect(decoded.diff_added).toBe(10);
      expect(decoded.diff_removed).toBe(3);
      // The worker table names columns once, then one bare CSV row per worker.
      // `activity` and `phase` stay separate columns here: the TOON board is
      // agent-facing, so it keeps the two dimensions addressable rather than
      // collapsing them into the statusline's `phase·activity` cell.
      expect(out).toContain(
        "workers[1]{id,state,runner,issue,activity,phase,done,total,blocked,failed,elapsed,added,removed,in_tok,out_tok,cost_usd,tls,rsn,txt,wait,log}:",
      );
      expect(decoded.workers[0]).toMatchObject({
        id: "wAAAA",
        state: "live",
        runner: "claude",
        issue: 42,
        activity: "impl",
        phase: "",
        done: 1,
        total: 4,
        blocked: 0,
        failed: 0,
        elapsed: "00:30:00",
        added: 10,
        removed: 3,
      });
      // The proving-drain counter is part of the agent-facing monitor summary,
      // not only the structured TOON payload, so operators can see Wave 3
      // readiness progress from the compact castle lane surface.
      expect(decoded.summary).toBe("1 workers · 1 active · 2 closed · proving 2/20 · +10 -3");
    });

    it("preserves the per-source origin counts from #930 as a sources table", () => {
      const a = baseWorker({ state: { ...baseWorker().state, worker_id: "wA", origin: "afk" } });
      const b = baseWorker({ state: { ...baseWorker().state, worker_id: "wB", origin: "go" } });
      const c = baseWorker({ state: { ...baseWorker().state, worker_id: "wC", origin: "afk" } });
      const out = renderCompactDashboardToon([a, b, c], fixtureEvents, 1780140600);
      const decoded = decode(out) as { sources: Array<{ origin: string; count: number }> };
      expect(out).toContain("sources[2]{origin,count}:");
      expect(decoded.sources).toEqual([{ origin: "afk", count: 2 }, { origin: "go", count: 1 }]);
    });

    it("emits a definitive empty state for an empty fleet", () => {
      const out = renderCompactDashboardToon([], fixtureEvents, 1780140600);
      const decoded = decode(out) as { workers: unknown[]; sources: unknown[]; summary: string };
      expect(decoded.workers).toEqual([]);
      expect(decoded.sources).toEqual([]);
      // Keep the empty-fleet summary on the same visible proving-drain contract
      // as the populated board.
      expect(decoded.summary).toBe("0 workers · 0 active · 2 closed · proving 2/20 · +0 -0");
    });

    it("includes the fleet status block when a fleet state is present", () => {
      const out = renderCompactDashboardToon([], fixtureEvents, 1780138815, baseFleet());
      const decoded = decode(out) as { fleet: { status: string; ready: number } };
      expect(decoded.fleet.status).toBe("idle");
      expect(decoded.fleet.ready).toBe(0);
    });

    it("includes fleet bundle version and skew in the fleet status block", () => {
      const out = renderCompactDashboardToon([], fixtureEvents, 1780138815, {
        ...baseFleet(),
        bundleVersion: "2.60.2",
        latestBundleVersion: "2.61.0",
      });
      const decoded = decode(out) as {
        fleet: { bundle_version: string; latest_bundle_version: string; version_skew: number };
      };
      expect(decoded.fleet.bundle_version).toBe("2.60.2");
      expect(decoded.fleet.latest_bundle_version).toBe("2.61.0");
      expect(decoded.fleet.version_skew).toBe(1);
    });

    it("includes trunk freshness fields in the fleet status block", () => {
      const out = renderCompactDashboardToon([], fixtureEvents, 1780138815, {
        ...baseFleet(),
        trunkFreshness: {
          status: "refreshed",
          refreshedAtEpoch: 1780138800,
          intervalS: 60,
          remoteRef: "origin/main",
          mirrorRef: "red-trunk",
          sha: "abc123",
        },
      });
      const decoded = decode(out) as {
        fleet: {
          trunk_freshness_status: string;
          trunk_freshness_refreshed_at: string;
          trunk_freshness_remote_ref: string;
          trunk_freshness_mirror_ref: string;
          trunk_freshness_sha: string;
        };
      };
      expect(decoded.fleet.trunk_freshness_status).toBe("refreshed");
      expect(decoded.fleet.trunk_freshness_refreshed_at).toBe("00:00:15");
      expect(decoded.fleet.trunk_freshness_remote_ref).toBe("origin/main");
      expect(decoded.fleet.trunk_freshness_mirror_ref).toBe("red-trunk");
      expect(decoded.fleet.trunk_freshness_sha).toBe("abc123");
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

  it("surfaces fleet bundle version skew on the plain fleet line", () => {
    const out = renderCompactDashboard([], fixtureEvents, 1780138815, {
      ...baseFleet(),
      bundleVersion: "2.60.2",
      latestBundleVersion: "2.61.0",
    });
    expect(out.split("\n")[1]).toBe(
      "fleet [idle] last ticked 00:00:15 ago  ready:0  slots busy:0 free:2 parked:0  spawns:0  bundle:2.60.2<2.61.0",
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

  it("states the interactive reservation whenever it reports slots", () => {
    const line = renderFleetLine(baseFleet({ interactiveReservation: 1 }), 1780138815);
    expect(line).toContain("slots busy:0 free:2 parked:0 reserve:1 interactive");

    const toon = renderCompactDashboardToon([], fixtureEvents, 1780138815, {
      ...baseFleet(),
      interactiveReservation: 1,
    });
    expect(toon).toContain("slots_interactive_reservation: 1");
  });

  it("marks busy fleet state degraded when no active worker corroborates it", () => {
    const out = renderCompactDashboard(
      [],
      fixtureEvents,
      1780138815,
      baseFleet({ readyForAgent: 7, slotsBusy: 2, slotsFree: 0 }),
    );
    expect(out.split("\n")[1]).toContain("fleet [degraded]");
  });

  it("surfaces recent supervisor churn on the fleet line", () => {
    const line = renderFleetLine(
      baseFleet({
        readyForAgent: 7,
        slotsBusy: 1,
        slotsFree: 1,
        churnDeaths: 2,
        churnRespawns: 2,
        churnWindowS: 300,
      }),
      1780138815,
    );
    expect(line).toContain("churn deaths:2 respawns:2/300s");
  });

  it("surfaces the trunk freshness outcome on the fleet line", () => {
    const line = renderFleetLine(
      baseFleet({
        trunkFreshness: {
          status: "refreshed",
          refreshedAtEpoch: 1780138800,
          intervalS: 60,
          remoteRef: "origin/main",
          mirrorRef: "red-trunk",
          sha: "abc123",
        },
      }),
      1780138815,
    );

    expect(line).toContain("trunk:refreshed");
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
    activity: string,
    live = true,
    phase = "coding",
  ): CompactWorker =>
    baseWorker({
      state: {
        ...baseWorker().state,
        worker_id,
        current: { number, title, slug: title, activity, phase, started_at: "2026-05-30T11:00:00Z" },
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
      description: "activity: impl",
      state: "in_progress",
    });
  });

  it("stage change emits a TaskUpdate carrying the new stage", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", activity: "impl", phase: "coding" });
    const out = runMirrorPlan([liveWorker("wAAAA", 42, "t", "tests")], tracked);
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "TaskUpdate",
      key: "wAAAA:42",
      description: "activity: tests",
      title: "wAAAA [2/5 coding] #42 t",
      state: "in_progress",
    });
  });

  it("phase change emits a TaskUpdate that re-titles the macro phase", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", activity: "impl", phase: "coding" });
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
    const tracked = JSON.stringify({ key: "wAAAA:42", activity: "impl", phase: "coding" });
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
    const tracked = JSON.stringify({ key: "wAAAA:42", activity: "tests", phase: "validating" });
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
              activity: "tests",
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
    const tracked = JSON.stringify({ key: "wAAAA:42", activity: "impl", phase: "coding" });
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
    const tracked = JSON.stringify({ key: "wAAAA:42", activity: "impl", phase: "coding" });
    const out = runMirrorPlan([], tracked);
    const calls = parse(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: "TaskUpdate", key: "wAAAA:42", state: "completed" });
  });

  it("no change emits no output (idempotent)", () => {
    const tracked = JSON.stringify({ key: "wAAAA:42", activity: "impl", phase: "coding" });
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
          current: { number: "", title: "", activity: "", started_at: "" },
        },
      }),
      liveWorker("wDEAD", 7, "t", "impl", false),
      baseWorker({
        state: {
          ...baseWorker().state,
          worker_id: "wQUIET",
          current: { number: 8, title: "q", activity: "tests", started_at: "2026-05-30T11:00:00Z" },
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
      { key: "a:1", activity: "impl", phase: "coding" },
      { key: "b:2", activity: "", phase: "" },
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
  it("--legend emits the token decode table and does not render the dashboard", async () => {
    const { chunks, stream } = makeMockStdout();
    const code = await monitorCommand(["--legend"], "/tmp", stream, emptyStdin);
    expect(code).toBe(0);
    const output = chunks.join("");
    expect(output).toContain("token  name");
    expect(output).toContain("tls");
    expect(output).toContain("tools_called_count");
    expect(output).toContain("rsn");
    expect(output).toContain("reasoning_events");
    expect(output).toContain("txt");
    expect(output).toContain("text_chunk_count");
    expect(output).not.toContain("sparkline:");
    expect(output).not.toContain("workers[");
  });

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
    expect((decode(out) as { tick_at: string }).tick_at).toBe(NOW_ISO);
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
  const freshRemote: MonitorRemote = { queue: 3, human: 1, quarantine: 4, cacheAgeS: 20, stale: false };
  const staleRemote: MonitorRemote = { queue: 5, human: 2, cacheAgeS: 90, stale: true };

  it("TOON output includes remote queue/human when provided", () => {
    const out = renderCompactDashboardToon([baseWorker()], fixtureEvents, 1780140600, null, freshRemote);
    expect(out).toContain("queue: 3");
    expect(out).toContain("human: 1");
    expect(out).toContain("quarantine: 4");
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
    expect(out).toContain("quarantine:4");
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
