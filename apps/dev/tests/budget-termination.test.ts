// A budgeted termination NAMES its budget, and hands its work forward (#2707).
//
// The attempt record these facts used to be written into is gone (Spec #2772):
// a Worker already is one Worker × one Ticket × one try, so the record published
// a second copy of what the issue thread and git already say. What must survive
// its removal is everything an operator can act on — the kill itself, the
// envelope that names the budget rather than a stall, the branch and PR handed
// forward, and the label that pages a human instead of blind-retrying.
//
// These tests drive the real supervisor paths (the poll/reap loop and the
// dead-slot reconcile) and assert on what reaches the issue.

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
  type IterDirInfo,
  type LivenessVerdict,
  type ProcessSnapshotEntry,
} from "./supervisor-test-helpers.js";
import { WORKER_BUDGET_HANDOFF_MARKER } from "../src/core/worker-budget.js";
import { LABEL_BUDGET, LABEL_HUMAN, LABEL_READY } from "../src/core/triage-labels.js";

const PID = 4242;
const CAP_S = 2700;

function info(over: Partial<IterDirInfo> = {}): IterDirInfo {
  return {
    path: "/w/wTEST/2707",
    issue: 2707,
    workerId: "wTEST",
    branch: "afk/wTEST/2707-budgets",
    logTail: "[afk] inner: toolCall edit apps/dev/src/core/worker-budget.ts",
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

function commentsOf(io: { comment: { mock: { calls: unknown[][] } } }): string[] {
  return io.comment.mock.calls.map((call) => String(call[1]));
}

describe("a budgeted termination names its budget (#2707)", () => {
  it("a memory-budget kill says so on the issue, in budget words and not stall words", async () => {
    const { deps: d, io } = deps({
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])),
    });

    const reaped = await pollStallDetector(
      busyState(),
      d,
      config({ workerBudgets: { wall_clock_s: CAP_S, peak_rss_mb: 4096 } }),
    );

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(PID);
    // A budgeted cut-off is policy. Calling it a stall would send the reader
    // hunting for a hang that never happened.
    expect(commentsOf(io).some((body) => body.includes("stall-reaped"))).toBe(false);
    expect(commentsOf(io).some((body) => body.includes("peak_rss_mb budget 4096MB reached"))).toBe(true);
  });

  it("hands the branch/PR forward so the retry adopts the work instead of restarting from main", async () => {
    const publishAttemptBranch = vi.fn(async (_branch: string) => true);
    const { deps: d, io } = deps({
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])),
      publishAttemptBranch,
      findAttemptPullRequest: vi.fn(async () => 4242),
    });

    await pollStallDetector(busyState(), d, config({ workerBudgets: { peak_rss_mb: 4096 } }));

    // The ref reaches the remote BEFORE the labels rotate, so branch discovery
    // can actually see it.
    expect(publishAttemptBranch).toHaveBeenCalledWith("afk/wTEST/2707-budgets");
    const handoff = commentsOf(io).find((body) => body.includes(WORKER_BUDGET_HANDOFF_MARKER))!;
    expect(handoff).toContain("resume-from-branch: `afk/wTEST/2707-budgets`");
    expect(handoff).toContain("do NOT start over from main");
    expect(handoff).toContain("PR #4242");
    expect(publishAttemptBranch.mock.invocationCallOrder[0]!).toBeLessThan(
      io.editLabels.mock.invocationCallOrder[0]!,
    );
  });

  it("pages a human with blocked:budget — a resource runaway is not blind-retried", async () => {
    const { deps: d, io } = deps({ sampleTreeRssMb: vi.fn(() => new Map([[PID, 5120]])) });

    await pollStallDetector(busyState(), d, config({ workerBudgets: { peak_rss_mb: 4096 } }));

    const [, add] = io.editLabels.mock.calls[0] as [number, string[], string[]];
    expect(add).toContain(LABEL_HUMAN);
    expect(add).toContain(LABEL_BUDGET);
    expect(add).not.toContain(LABEL_READY);
  });

  it("an unset budget is unlimited: a huge worker is never terminated", async () => {
    const { deps: d, io } = deps({ sampleTreeRssMb: vi.fn(() => new Map([[PID, 65_536]])) });

    const reaped = await pollStallDetector(busyState(), d, config({ workerBudgets: {} }));

    expect(reaped).toEqual([]);
    expect(io.killTree).not.toHaveBeenCalled();
  });
});

describe("the three terminations stay distinct (#2707)", () => {
  it("a stall reap says stall-reaped, naming no budget", async () => {
    const state = busyState();
    state.slots[0]!.spawnEpoch = NOW - 4000;
    const { deps: d, io } = deps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(2000)),
      sampleTreeRssMb: vi.fn(() => new Map([[PID, 512]])),
    });

    await pollStallDetector(state, d, config({ workerBudgets: { peak_rss_mb: 4096 } }));

    const bodies = commentsOf(io);
    expect(bodies.some((body) => body.includes("stall-reaped"))).toBe(true);
    expect(bodies.some((body) => body.includes(WORKER_BUDGET_HANDOFF_MARKER))).toBe(false);
  });

  it("a wall-clock cap hands its work forward under the cap's own comment", async () => {
    const state = busyState();
    state.slots[0]!.spawnEpoch = NOW - 2775;
    const { deps: d, io } = deps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => wallClockVerdict(2775)),
      resolveIterDir: vi.fn((): IterDirInfo => info({ durationS: 2775 })),
    });

    const reaped = await pollStallDetector(state, d, config({ issueWallClockMaxS: CAP_S }));

    expect(reaped).toEqual([0]);
    const bodies = commentsOf(io);
    expect(bodies.some((body) => body.includes("stall-reaped"))).toBe(false);
    expect(bodies.some((body) => body.includes("wall-clock"))).toBe(true);
  });

  it("a worker that conceded its own claim before exiting needs no reconcile", async () => {
    const { deps: d } = deps({
      // The claim is no longer `running`: the worker conceded it and exited.
      crashedClaimState: vi.fn(async () => ({
        ghOk: true,
        stillRunning: false,
        envelopePosted: true,
      })),
    });

    expect(
      await reconcileDeadWorkerClaim(info(), d, { wallClockS: 900, peakRssMb: 2048 }),
    ).toBeNull();
  });

  it("an unreadable claim posts nothing — absence of evidence is not an outcome", async () => {
    const { deps: d, io } = deps({
      crashedClaimState: vi.fn(async () => {
        throw new Error("gh exploded");
      }),
    });

    await reconcileDeadWorkerClaim(info(), d, { wallClockS: 900 });

    expect(io.comment).not.toHaveBeenCalled();
  });
});
