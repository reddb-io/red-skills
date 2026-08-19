// Wall-clock cap vs stall (#2701).
//
// Three attempts were reaped as `no-sentinel · stall-reaped` in one session
// while their own heartbeats showed tool calls and reasoning seconds earlier;
// one of them had 16 commits on its branch, another an open green PR. The reap
// re-queued each issue CLEAN, so the next worker branched fresh from main and
// redid finished work. These tests pin the separation: a fresh lane is never a
// stall, a cap names itself, and a cap hands its branch/PR forward.

import { describe, expect, it, vi } from "vitest";
import { evaluateLiveness } from "@reddb-io/worker";
import {
  buildWallClockCapEnvelope,
  config,
  initSupervisorState,
  makeDeps,
  NOW,
  pollStallDetector,
  wallClockVerdict,
  type IterDirInfo,
  type LivenessVerdict,
  type ProcessSnapshotEntry,
} from "./supervisor-test-helpers.js";
import { CAP_HANDOFF_MARKER, planCapHandoff } from "../src/core/wall-clock-cap.js";
import { dispose } from "../src/core/disposition.js";
import { isGateGreenBranch } from "../src/core/branch-resume.js";
import { LABEL_READY, LABEL_RUNNING, LABEL_STALLED, LABEL_WALL_CLOCK_CAPPED } from "../src/core/triage-labels.js";

const CAP_S = 2700;

/** The reaped attempt from #2663: long, productive, mid-flight when cut off. */
function cappedInfo(over: Partial<IterDirInfo> = {}): IterDirInfo {
  return {
    path: "/w/wTEST/2663",
    issue: 2663,
    workerId: "wTEST",
    branch: "afk/wTEST/2663-long-slice",
    logTail: "[afk] inner: toolCall edit apps/dev/src/core/x.ts",
    notes: "16 commits, +689/-113 across 15 files",
    durationS: 2775,
    attempt: 1,
    ...over,
  };
}

function cappedState() {
  const state = initSupervisorState(1);
  const slot = state.slots[0]!;
  slot.pid = 4242;
  slot.spawnEpoch = NOW - 2775;
  return state;
}

function cappedDeps(over: Record<string, unknown> = {}) {
  return makeDeps({
    workerLivenessVerdict: vi.fn((): LivenessVerdict => wallClockVerdict(2775)),
    // Flat cpu, no build/test descendant → the reaper-signal predicate allows
    // the kill, so the cap actually fires.
    inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
    resolveIterDir: vi.fn((): IterDirInfo => cappedInfo()),
    attemptBranchHead: vi.fn(async () => "aaa111"),
    ...over,
  });
}

function commentsOf(io: { comment: { mock: { calls: unknown[][] } } }): string[] {
  return io.comment.mock.calls.map((call) => String(call[1]));
}

describe("wall-clock cap is not a stall (#2701)", () => {
  it("AC1: an attempt with activity inside the liveness window is never classified stalled", () => {
    // #2663's last heartbeat reported seconds_since_progress: 0, with a toolCall
    // and a reasoning event in the two seconds before the reap. Duration alone
    // must never turn that into a stall.
    const verdict = evaluateLiveness({
      laneRecencyMs: 2_775_000 - 2_000, // activity 2s ago — exactly the #2663 trace
      now: 2_775_000,
      laneIdleMs: 300_000,
      issueClaimedAtMs: 0,
      issueWallClockMaxMs: CAP_S * 1000,
      crossCheckArmed: true,
      hasLiveDescendants: () => true,
    });

    expect(verdict.status).not.toBe("stalled");
    expect(verdict.status).toBe("capped");
    expect(verdict.laneFresh).toBe(true);
    expect(verdict.wallClockExceeded).toBe(true);
  });

  it("AC1: a silent attempt is still classified stalled — the stall path is untouched", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 0,
      now: 1_000_000,
      laneIdleMs: 300_000,
      crossCheckArmed: true,
      hasLiveDescendants: () => false,
    });

    expect(verdict.status).toBe("stalled");
  });

  it("AC2: a capped reap records `wall-clock-capped`, naming the cap — never `no-sentinel`", async () => {
    const { deps, io } = cappedDeps();

    const reaped = await pollStallDetector(cappedState(), deps, config({ issueWallClockMaxS: CAP_S }));

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
    const envelope = commentsOf(io).find((body) => body.includes("data-attempt-status="))!;
    expect(envelope).toContain('data-attempt-status="wall-clock-capped"');
    expect(envelope).not.toContain('data-attempt-status="no-sentinel"');
    expect(envelope).toContain(`wall-clock cap ${CAP_S}s reached`);
    expect(envelope).toContain("2775s");
    // And no comment claims a stall-reap.
    expect(commentsOf(io).some((body) => body.includes("stall-reaped"))).toBe(false);
  });

  it("AC2: the envelope builder itself is the distinct record", () => {
    const body = buildWallClockCapEnvelope(cappedInfo(), CAP_S);
    expect(body).toContain('data-attempt-status="wall-clock-capped"');
    expect(body).toContain("wall-clock cap 2700s reached");
    expect(body).toContain("16 commits");
  });

  it("AC3: a capped attempt with commits publishes its branch and hands the ref forward", async () => {
    const publishAttemptBranch = vi.fn(async (_branch: string) => true);
    const { deps, io } = cappedDeps({ publishAttemptBranch });

    await pollStallDetector(cappedState(), deps, config({ issueWallClockMaxS: CAP_S }));

    // The ref reaches the remote BEFORE the issue re-queues, so the next
    // worker's branch discovery can adopt it instead of branching from main.
    expect(publishAttemptBranch).toHaveBeenCalledWith("afk/wTEST/2663-long-slice");
    const handoff = commentsOf(io).find((body) => body.includes(CAP_HANDOFF_MARKER))!;
    expect(handoff).toContain("resume-from-branch: `afk/wTEST/2663-long-slice`");
    expect(handoff).toContain("do NOT start over");
    const publishCall = publishAttemptBranch.mock.invocationCallOrder[0]!;
    const requeueCall = io.editLabels.mock.invocationCallOrder[0]!;
    expect(publishCall).toBeLessThan(requeueCall);
  });

  it("AC3: a capped attempt with NO commits hands nothing forward", async () => {
    const publishAttemptBranch = vi.fn(async (_branch: string) => true);
    const { deps, io } = cappedDeps({
      attemptBranchHead: vi.fn(async () => undefined),
      publishAttemptBranch,
    });

    await pollStallDetector(cappedState(), deps, config({ issueWallClockMaxS: CAP_S }));

    expect(publishAttemptBranch).not.toHaveBeenCalled();
    const handoff = commentsOf(io).find((body) => body.includes(CAP_HANDOFF_MARKER))!;
    expect(handoff).toContain("nothing is handed forward");
    expect(handoff).not.toContain("resume-from-branch");
  });

  it("AC3: the retry continues the adopted branch instead of taking the land-only fast path", () => {
    // A capped run was stopped MID-GATE: its branch has commits but nothing
    // proves the gate passed, so the resume must not claim gate-green.
    expect(isGateGreenBranch("wall-clock-capped")).toBe(false);
  });

  it("AC4: a capped attempt with an open PR names it as the pending artifact and sheds `running`", async () => {
    const { deps, io } = cappedDeps({
      findAttemptPullRequest: vi.fn(async (_issue: number) => 2710),
    });

    await pollStallDetector(cappedState(), deps, config({ issueWallClockMaxS: CAP_S }));

    const handoff = commentsOf(io).find((body) => body.includes(CAP_HANDOFF_MARKER))!;
    expect(handoff).toContain("pending artifact: PR #2710");
    // Not silently `running`: the routing label rotates in the same edit.
    const [issue, add, remove] = io.editLabels.mock.calls[0]!;
    expect(issue).toBe(2663);
    expect(add).toContain(LABEL_READY);
    expect(remove).toContain(LABEL_RUNNING);
    // A cap never opens a retry contest — the ref is already handed forward.
    expect(add).not.toContain("contested");
  });

  it("AC4: an exhausted cap budget escalates carrying `blocked:wall-clock-capped`, not `blocked:stalled`", async () => {
    const { deps, io } = cappedDeps({
      resolveIterDir: vi.fn((): IterDirInfo => cappedInfo({ attempt: 9 })),
      findAttemptPullRequest: vi.fn(async (_issue: number) => 2710),
    });

    await pollStallDetector(cappedState(), deps, config({ issueWallClockMaxS: CAP_S }));

    expect(io.ensureLabel).toHaveBeenCalledWith(LABEL_WALL_CLOCK_CAPPED);
    const [, add] = io.editLabels.mock.calls[0]!;
    expect(add).toContain(LABEL_WALL_CLOCK_CAPPED);
    expect(add).not.toContain(LABEL_STALLED);
  });

  it("keeps the cap re-queue bounded by the same budget as a stall", () => {
    const under = dispose("wall-clock-capped", 1, {});
    const over = dispose("wall-clock-capped", 9, {});
    expect(under.decision).toBe("retry");
    expect(over.decision).toBe("escalate");
    expect(over.typedLabel).toBe(LABEL_WALL_CLOCK_CAPPED);
  });
});

describe("planCapHandoff (pure)", () => {
  it("names the PR even when the branch head is unresolvable — the work is already published", () => {
    const plan = planCapHandoff({
      issue: 2667,
      capSeconds: CAP_S,
      durationS: 2800,
      branch: "afk/wTEST/2667-slice",
      pullRequest: 2711,
    });
    expect(plan.resumeRef).toBeUndefined();
    expect(plan.pendingPullRequest).toBe(2711);
    expect(plan.handsWorkForward).toBe(true);
  });

  it("flags a local-only ref when the publish failed, instead of promising an adoptable branch", () => {
    const plan = planCapHandoff({
      issue: 2666,
      capSeconds: CAP_S,
      durationS: 2878,
      branch: "afk/wTEST/2666-slice",
      branchHead: "bbb222",
      branchPublished: false,
    });
    expect(plan.resumeRef).toBe("afk/wTEST/2666-slice");
    expect(plan.comment).toContain("local only");
  });
});
