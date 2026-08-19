import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_POLL_S,
  resolveLaneIdleStallConfig,
  startLaneIdleReaper,
  type LaneIdleInfo,
  type LaneIdleReaperOptions,
} from "../src/core/lane-idle-reaper.js";
import type { LivenessVerdict } from "@reddb-io/worker";

/** A manual scheduler: captures the periodic fn so the test pumps ticks
 * synchronously (the lane reaper's poll body is synchronous — statSync / ps). */
function manualScheduler() {
  const fns: Array<() => void> = [];
  const schedule = (fn: () => void, _ms: number) => {
    fns.push(fn);
    return () => {
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    };
  };
  const tick = () => {
    for (const fn of [...fns]) fn();
  };
  return { schedule, tick };
}

const SOFT = 600;
const KILL = 1800;
// A realistic epoch anchor: the run spawned at BASE and the agent lane was last
// written at BASE (the fleet detector requires both spawnEpoch > 0 AND
// lane was recently written — a never-observed lane is never flagged as stalled).
const BASE = 1_000_000;

/**
 * Build a fake livenessVerdict probe driven by epoch-second lane-time and clock
 * functions. Mirrors the evaluator's logic without importing it: lane present
 * and idle ≥ SOFT (no live descendants) → stalled; idle < SOFT → alive. A zero
 * laneTimeS (unseen lane) → returns null (not-candidate).
 */
function makeVerdictFn(
  laneTimeS: () => number,
  clockFn: () => number,
  softS: number,
): () => LivenessVerdict | null {
  return (): LivenessVerdict | null => {
    const lt = laneTimeS();
    if (lt === 0) return null;
    const idleMs = (clockFn() - lt) * 1000;
    if (idleMs >= softS * 1000) {
      return {
        status: "stalled",
        laneFresh: false,
        laneAgeMs: idleMs,
        crossCheckArmed: false,
        reason: "lane idle",
      };
    }
    return {
      status: "alive",
      laneFresh: true,
      laneAgeMs: idleMs,
      crossCheckArmed: false,
      reason: "lane fresh",
    };
  };
}

/** Build reaper options anchored at BASE; `over` overrides per test. */
function makeOpts(over: Partial<LaneIdleReaperOptions> = {}): LaneIdleReaperOptions {
  const clock = () => BASE;
  return {
    spawnEpoch: BASE,
    stallThresholdS: SOFT,
    stallKillThresholdS: KILL,
    intervalMs: 30_000,
    livenessVerdict: makeVerdictFn(() => BASE, clock, SOFT),
    inspectTree: () => [],
    now: clock,
    schedule: () => () => {},
    abort: () => {},
    ...over,
  };
}

describe("startLaneIdleReaper — reuses the fleet detector + reaper-signal predicate", () => {
  // ---- AC1: idle past KILL, no build/test descendant, flat cpu → reaped ----
  it("reaps a solo worker idle past the kill threshold with no active descendant and flat cpu", () => {
    let clock = BASE;
    let aborted = false;
    const sched = manualScheduler();
    // Lane last wrote at BASE (a sleep-only inner child: one turn then silence —
    // no further agent turns, no build/test descendant).
    const r = startLaneIdleReaper(
      makeOpts({
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => BASE, () => clock, SOFT),
        inspectTree: () => [{ command: "sleep", cpu: 0 }], // idle child, flat cpu
        schedule: sched.schedule,
        abort: () => {
          aborted = true;
        },
      }),
    );
    clock = BASE + 1200; // idle 1200 < kill 1800, but > soft → stalled, not reaped
    sched.tick();
    expect(aborted).toBe(false);
    expect(r.firedReap()).toBe(false);
    clock = BASE + 1800; // idle 1800 >= kill → genuinely stuck → reap
    sched.tick();
    expect(aborted).toBe(true);
    expect(r.firedReap()).toBe(true);
  });

  it("fires abort only once even across further ticks", () => {
    let clock = BASE + 1800;
    let aborts = 0;
    const sched = manualScheduler();
    startLaneIdleReaper(
      makeOpts({
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => BASE, () => clock, SOFT),
        inspectTree: () => [],
        schedule: sched.schedule,
        abort: () => {
          aborts += 1;
        },
      }),
    );
    sched.tick();
    clock = BASE + 3600;
    sched.tick();
    expect(aborts).toBe(1);
  });

  // ---- AC2: an active vitest/tsc descendant past threshold is NOT killed ----
  it("never reaps a worker with an active vitest descendant, even idle past the kill threshold", () => {
    let aborted = false;
    const clock = BASE + 99_999;
    const sched = manualScheduler();
    const r = startLaneIdleReaper(
      makeOpts({
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => BASE, () => clock, SOFT),
        inspectTree: () => [
          { command: "node", cpu: 0 },
          { command: "vitest", cpu: 0 }, // a test run blocked on I/O at ~0% cpu
        ],
        schedule: sched.schedule,
        abort: () => {
          aborted = true;
        },
      }),
    );
    sched.tick();
    expect(aborted).toBe(false);
    expect(r.firedReap()).toBe(false);
  });

  it("never reaps a worker with an active tsc descendant past the threshold", () => {
    let aborted = false;
    const clock = BASE + 99_999;
    const sched = manualScheduler();
    startLaneIdleReaper(
      makeOpts({
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => BASE, () => clock, SOFT),
        inspectTree: () => [{ command: "tsc", cpu: 0 }],
        schedule: sched.schedule,
        abort: () => {
          aborted = true;
        },
      }),
    );
    sched.tick();
    expect(aborted).toBe(false);
  });

  it("never reaps a worker showing non-trivial aggregate cpu (busy without a named tool)", () => {
    let aborted = false;
    const clock = BASE + 99_999;
    const sched = manualScheduler();
    startLaneIdleReaper(
      makeOpts({
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => BASE, () => clock, SOFT),
        inspectTree: () => [{ command: "node", cpu: 73.4 }],
        schedule: sched.schedule,
        abort: () => {
          aborted = true;
        },
      }),
    );
    sched.tick();
    expect(aborted).toBe(false);
  });

  // ---- candidacy gating (spawn epoch guard) ----
  it("does not reap a freshly-spawned worker (worker age below the soft threshold)", () => {
    let aborted = false;
    const sched = manualScheduler();
    const clock = BASE + 100;
    // worker only 100s old (now-spawnEpoch=100 < soft 600) → not a candidate even
    // though the lane is stale; the spawn guard fires before the verdict is consulted.
    startLaneIdleReaper(
      makeOpts({
        spawnEpoch: BASE,
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => BASE, () => clock, SOFT),
        inspectTree: () => [],
        schedule: sched.schedule,
        abort: () => {
          aborted = true;
        },
      }),
    );
    sched.tick();
    expect(aborted).toBe(false);
  });

  it("never treats an unseen lane (verdict null) as a stall", () => {
    let aborted = false;
    const sched = manualScheduler();
    const clock = BASE + 99_999;
    startLaneIdleReaper(
      makeOpts({
        spawnEpoch: BASE,
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => 0, () => clock, SOFT), // 0 → returns null
        inspectTree: () => [],
        schedule: sched.schedule,
        abort: () => {
          aborted = true;
        },
      }),
    );
    sched.tick();
    expect(aborted).toBe(false);
  });

  it("resets the idle window when the agent lane advances (live agent, no reap)", () => {
    let clock = BASE;
    let lane = BASE;
    let aborted = false;
    const sched = manualScheduler();
    startLaneIdleReaper(
      makeOpts({
        spawnEpoch: BASE,
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => lane, () => clock, SOFT),
        inspectTree: () => [],
        schedule: sched.schedule,
        abort: () => {
          aborted = true;
        },
      }),
    );
    clock = BASE + 1700; // idle 1700 < kill 1800
    sched.tick();
    expect(aborted).toBe(false);
    lane = BASE + 1700; // a fresh agent turn landed → lane advanced
    clock = BASE + 2000; // idle now only 300 < soft → not even stalled
    sched.tick();
    expect(aborted).toBe(false);
    clock = BASE + 3500; // idle 1800 from the new anchor → reap
    sched.tick();
    expect(aborted).toBe(true);
  });

  it("surfaces the verdict each tick via onTick", () => {
    let clock = BASE;
    const ticks: LaneIdleInfo[] = [];
    const sched = manualScheduler();
    startLaneIdleReaper(
      makeOpts({
        spawnEpoch: BASE,
        now: () => clock,
        livenessVerdict: makeVerdictFn(() => BASE, () => clock, SOFT),
        inspectTree: () => [],
        schedule: sched.schedule,
        onTick: (i) => ticks.push(i),
      }),
    );
    clock = BASE + 100; // worker age below soft → not-candidate (spawn guard)
    sched.tick();
    clock = BASE + 1000; // stalled, idle below kill → no-kill
    sched.tick();
    clock = BASE + 1800; // stuck → kill
    sched.tick();
    expect(ticks.map((t) => t.verdict)).toEqual(["not-candidate", "no-kill", "kill"]);
    expect(ticks[2]!.idleSeconds).toBe(1800);
    expect(ticks[2]!.stalled).toBe(true);
  });
});

describe("resolveLaneIdleStallConfig — boot validation + env consistency with fleet", () => {
  // ---- AC3: kill <= soft fails fast at boot ----
  it("throws when the kill threshold equals the soft threshold", () => {
    expect(() =>
      resolveLaneIdleStallConfig({
        RED_AFK_STALL_THRESHOLD_S: "600",
        RED_AFK_STALL_KILL_THRESHOLD_S: "600",
      }),
    ).toThrow(/must be >/);
  });

  it("throws when the kill threshold is less than the soft threshold", () => {
    expect(() =>
      resolveLaneIdleStallConfig({
        RED_AFK_STALL_THRESHOLD_S: "900",
        RED_AFK_STALL_KILL_THRESHOLD_S: "300",
      }),
    ).toThrow(/must be >/);
  });

  it("defaults to the fleet thresholds (600 / 1800) and a 30s poll", () => {
    expect(resolveLaneIdleStallConfig({})).toEqual({
      stallThresholdS: 600,
      stallKillThresholdS: 1800,
      stallPollS: DEFAULT_STALL_POLL_S,
      issueWallClockMaxS: 2700,
    });
  });

  it("honours valid overrides", () => {
    expect(
      resolveLaneIdleStallConfig({
        RED_AFK_STALL_THRESHOLD_S: "300",
        RED_AFK_STALL_KILL_THRESHOLD_S: "900",
        RED_AFK_STALL_POLL_S: "15",
      }),
    ).toEqual({ stallThresholdS: 300, stallKillThresholdS: 900, stallPollS: 15, issueWallClockMaxS: 2700 });
  });

  it("resolves the per-issue wall-clock ceiling and floors typo values (#2286)", () => {
    expect(resolveLaneIdleStallConfig({ RED_AFK_ISSUE_WALL_CLOCK_MAX_S: "3600" }).issueWallClockMaxS).toBe(3600);
    expect(resolveLaneIdleStallConfig({ RED_AFK_ISSUE_WALL_CLOCK_MAX_S: "0" }).issueWallClockMaxS).toBe(2700);
    expect(resolveLaneIdleStallConfig({ RED_AFK_ISSUE_WALL_CLOCK_MAX_S: "nope" }).issueWallClockMaxS).toBe(2700);
  });

  it("floors a zero / non-numeric poll back to the default (never busy-spins)", () => {
    expect(resolveLaneIdleStallConfig({ RED_AFK_STALL_POLL_S: "0" }).stallPollS).toBe(DEFAULT_STALL_POLL_S);
    expect(resolveLaneIdleStallConfig({ RED_AFK_STALL_POLL_S: "abc" }).stallPollS).toBe(DEFAULT_STALL_POLL_S);
  });

  it("falls back to defaults on non-numeric threshold overrides (typo-safe)", () => {
    // garbage thresholds collapse to 600 / 1800, which is a valid pair.
    expect(
      resolveLaneIdleStallConfig({
        RED_AFK_STALL_THRESHOLD_S: "xyz",
        RED_AFK_STALL_KILL_THRESHOLD_S: "-5",
      }),
    ).toEqual({
      stallThresholdS: 600,
      stallKillThresholdS: 1800,
      stallPollS: DEFAULT_STALL_POLL_S,
      issueWallClockMaxS: 2700,
    });
  });
});
