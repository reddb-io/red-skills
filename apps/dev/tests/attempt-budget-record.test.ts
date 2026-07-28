// The attempt record carries what the attempt CONSUMED, and a budgeted
// termination is a third terminal record — not a stall, not a clean finish
// (ADR 0128 §8, #2707).
//
// The resident writes all three, which is the load-bearing half: the moment a
// record matters most is exactly when the worker is already gone. These tests
// drive the real supervisor paths (the poll/reap loop and the dead-slot
// reconcile) and assert on what reaches the record writer.

import { describe, expect, it, vi } from "vitest";
import {
  aliveVerdict,
  config,
  initSupervisorState,
  makeDeps,
  NOW,
  pollStallDetector,
  reconcileDeadWorkerClaim,
  stalledVerdict,
  wallClockVerdict,
  type AttemptCloseRecord,
  type IterDirInfo,
  type LivenessVerdict,
  type ProcessSnapshotEntry,
} from "./supervisor-test-helpers.js";
import { ATTEMPT_BUDGET_HANDOFF_MARKER } from "../src/core/attempt-budget.js";
import { LABEL_BUDGET, LABEL_HUMAN, LABEL_READY } from "../src/core/triage-labels.js";

const PID = 4242;
const CAP_S = 2700;

function info(over: Partial<IterDirInfo> = {}): IterDirInfo {
  return {
    path: "/w/wTEST/2707",
    issue: 2707,
    workerId: "wTEST",
    branch: "afk/wTEST/2707-budgets",
    logTail: "[afk] inner: toolCall edit apps/dev/src/core/attempt-budget.ts",
    notes: "4 commits, +210/-30",
    durationS: 900,
    attempt: 1,
    ...over,
  };
}

function busyState() {
  const state = initSupervisorState(1);
  const slot = state.slots[0]!;
  slot.pid = PID;
  slot.spawnEpoch = NOW - 900;
  return state;
}

function deps(over: Record<string, unknown> = {}) {
  return makeDeps({
    workerLivenessVerdict: vi.fn((): LivenessVerdict => aliveVerdict()),
    // Flat cpu, no build/test descendant — so the stall ladder, when it is the
    // path under test, is allowed to kill.
    inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
    resolveIterDir: vi.fn((): IterDirInfo => info()),
    attemptBranchHead: vi.fn(async () => "aaa111"),
    ...over,
  });
}

function closesOf(io: { recordAttemptClose: { mock: { calls: unknown[][] } } }): AttemptCloseRecord[] {
  return io.recordAttemptClose.mock.calls.map((call) => call[0] as AttemptCloseRecord);
}

function commentsOf(io: { comment: { mock: { calls: unknown[][] } } }): string[] {
  return io.comment.mock.calls.map((call) => String(call[1]));
}

describe("a budgeted termination names its budget (#2707)", () => {
  it("a memory-budget kill records `budget-exceeded` naming peak_rss_mb", async () => {
    const { deps: d, io } = deps({
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])),
    });

    const reaped = await pollStallDetector(
      busyState(),
      d,
      config({ attemptBudgets: { wall_clock_s: CAP_S, peak_rss_mb: 4096 } }),
    );

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(PID);
    const [close] = closesOf(io).slice(-1);
    expect(close!.outcome.kind).toBe("budget-exceeded");
    expect(close!.outcome.budget).toBe("peak_rss_mb");
    // Distinct from a stall AND from a clean finish.
    expect(close!.outcome.kind).not.toBe("killed");
    expect(close!.outcome.kind).not.toBe("done");
    // The envelope on the issue says the same thing — no stall-reap wording.
    expect(commentsOf(io).some((body) => body.includes("stall-reaped"))).toBe(false);
    expect(commentsOf(io).some((body) => body.includes("peak_rss_mb budget 4096MB reached"))).toBe(true);
  });

  it("the record carries peak RSS and wall clock for the terminated attempt", async () => {
    const { deps: d, io } = deps({
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])),
    });

    await pollStallDetector(
      busyState(),
      d,
      config({ attemptBudgets: { peak_rss_mb: 4096 } }),
    );

    const [close] = closesOf(io).slice(-1);
    expect(close!.resources.peak_rss_mb).toBe(5120);
    expect(close!.resources.wall_clock_s).toBe(900);
    expect(close!.issue).toBe(2707);
    expect(close!.workerId).toBe("wTEST");
    expect(close!.try).toBe(1);
  });

  it("attributes the consumption to the fleet's own cgroup (#2697)", async () => {
    const { deps: d, io } = deps({ sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])) });
    d.fleetAttribution = { fleet: "main", scope: "red-fleet-main-42.scope" };

    await pollStallDetector(busyState(), d, config({ attemptBudgets: { peak_rss_mb: 4096 } }));

    const [close] = closesOf(io).slice(-1);
    expect(close!.resources.fleet).toBe("main");
    expect(close!.resources.fleet_scope).toBe("red-fleet-main-42.scope");
  });

  it("hands the branch/PR forward so the retry adopts the work instead of restarting from main", async () => {
    const publishAttemptBranch = vi.fn(async (_branch: string) => true);
    const { deps: d, io } = deps({
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])),
      publishAttemptBranch,
      findAttemptPullRequest: vi.fn(async () => 4242),
    });

    await pollStallDetector(busyState(), d, config({ attemptBudgets: { peak_rss_mb: 4096 } }));

    // The ref reaches the remote BEFORE the labels rotate, so branch discovery
    // can actually see it.
    expect(publishAttemptBranch).toHaveBeenCalledWith("afk/wTEST/2707-budgets");
    const handoff = commentsOf(io).find((body) => body.includes(ATTEMPT_BUDGET_HANDOFF_MARKER))!;
    expect(handoff).toContain("resume-from-branch: `afk/wTEST/2707-budgets`");
    expect(handoff).toContain("do NOT start over from main");
    expect(handoff).toContain("PR #4242");
    expect(publishAttemptBranch.mock.invocationCallOrder[0]!).toBeLessThan(
      io.editLabels.mock.invocationCallOrder[0]!,
    );
    // The record points at the same artifacts the comment names.
    const [close] = closesOf(io).slice(-1);
    expect(close!.branch).toBe("afk/wTEST/2707-budgets");
    expect(close!.pr).toBe(4242);
  });

  it("pages a human with blocked:budget — a resource runaway is not blind-retried", async () => {
    const { deps: d, io } = deps({ sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])) });

    await pollStallDetector(busyState(), d, config({ attemptBudgets: { peak_rss_mb: 4096 } }));

    const [, add] = io.editLabels.mock.calls[0] as [number, string[], string[]];
    expect(add).toContain(LABEL_HUMAN);
    expect(add).toContain(LABEL_BUDGET);
    expect(add).not.toContain(LABEL_READY);
  });

  it("an unset budget is unlimited: a huge attempt is never terminated", async () => {
    const { deps: d, io } = deps({ sampleTreeRssMb: vi.fn(() => new Map([[PID, 65_536]])) });

    const reaped = await pollStallDetector(busyState(), d, config({ attemptBudgets: {} }));

    expect(reaped).toEqual([]);
    expect(io.killTree).not.toHaveBeenCalled();
    expect(io.recordAttemptClose).not.toHaveBeenCalled();
  });
});

describe("the three terminal records stay distinct (#2707)", () => {
  it("a stall reap records `killed`, naming no budget", async () => {
    const state = busyState();
    state.slots[0]!.spawnEpoch = NOW - 4000;
    const { deps: d, io } = deps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(2000)),
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 512]])),
    });

    await pollStallDetector(state, d, config({ attemptBudgets: { peak_rss_mb: 4096 } }));

    const [close] = closesOf(io).slice(-1);
    expect(close!.outcome.kind).toBe("killed");
    expect(close!.outcome.budget).toBeUndefined();
    expect(close!.outcome.detail).toContain("stall-reaped");
    // The stall record still carries what it consumed.
    expect(close!.resources.peak_rss_mb).toBe(512);
    expect(close!.resources.wall_clock_s).toBe(900);
  });

  it("a wall-clock cap records `budget-exceeded` naming wall_clock_s", async () => {
    const state = busyState();
    state.slots[0]!.spawnEpoch = NOW - 2775;
    const { deps: d, io } = deps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => wallClockVerdict(2775)),
      resolveIterDir: vi.fn((): IterDirInfo => info({ durationS: 2775 })),
    });

    await pollStallDetector(state, d, config({ issueWallClockMaxS: CAP_S }));

    const [close] = closesOf(io).slice(-1);
    expect(close!.outcome.kind).toBe("budget-exceeded");
    expect(close!.outcome.budget).toBe("wall_clock_s");
    expect(close!.resources.wall_clock_s).toBe(2775);
  });

  it("a completed attempt records `done` with its wall clock and peak RSS", async () => {
    const { deps: d, io } = deps({
      // The claim is no longer `running`: the worker conceded it and exited.
      crashedClaimState: vi.fn(async () => ({
        ghOk: true,
        stillRunning: false,
        envelopePosted: true,
      })),
    });

    const reconciled = await reconcileDeadWorkerClaim(info(), d, {
      wallClockS: 900,
      peakRssMb: 2048,
    });

    expect(reconciled).toBeNull();
    const [close] = closesOf(io).slice(-1);
    expect(close!.outcome.kind).toBe("done");
    expect(close!.resources.wall_clock_s).toBe(900);
    expect(close!.resources.peak_rss_mb).toBe(2048);
  });

  it("an unreadable claim records nothing — absence of evidence is not an outcome", async () => {
    const { deps: d, io } = deps({
      crashedClaimState: vi.fn(async () => {
        throw new Error("gh exploded");
      }),
    });

    await reconcileDeadWorkerClaim(info(), d, { wallClockS: 900 });

    expect(io.recordAttemptClose).not.toHaveBeenCalled();
  });

  it("a broken record lane never breaks the reap", async () => {
    const { deps: d, io } = deps({
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])),
      recordAttemptClose: vi.fn(async () => {
        throw new Error("lane unwritable");
      }),
    });

    const reaped = await pollStallDetector(
      busyState(),
      d,
      config({ attemptBudgets: { peak_rss_mb: 4096 } }),
    );

    expect(reaped).toEqual([0]);
    expect(io.editLabels).toHaveBeenCalled();
  });
});
