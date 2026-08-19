import { describe, expect, it } from "vitest";
import {
  createProcessDescendantProbe,
  evaluateLiveness,
  hasDescendantInSnapshot,
  parsePsSnapshot,
  resolveLivenessCrossCheckArming,
} from "./LivenessEvaluator.js";

describe("resolveLivenessCrossCheckArming", () => {
  it("arms only under no-sandbox (host process tree visible)", () => {
    expect(resolveLivenessCrossCheckArming({ sandboxTag: "none" })).toEqual({
      crossCheckArmed: true,
    });
  });

  it("disarms under docker/podman (bind-mount) and isolated containers", () => {
    expect(
      resolveLivenessCrossCheckArming({ sandboxTag: "bind-mount" }),
    ).toEqual({ crossCheckArmed: false });
    expect(resolveLivenessCrossCheckArming({ sandboxTag: "isolated" })).toEqual(
      {
        crossCheckArmed: false,
      },
    );
  });
});

describe("evaluateLiveness — lane recency alone", () => {
  it("fresh lane → alive, and the probe is never consulted", () => {
    let probed = false;
    const verdict = evaluateLiveness({
      laneRecencyMs: 9_000,
      now: 10_000,
      laneIdleMs: 5_000,
      crossCheckArmed: true,
      hasLiveDescendants: () => {
        probed = true;
        return false;
      },
    });
    expect(verdict.status).toBe("alive");
    expect(verdict.laneFresh).toBe(true);
    expect(verdict.laneAgeMs).toBe(1_000);
    expect(probed).toBe(false);
  });

  it("a record exactly at the idle threshold is still fresh", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 5_000,
      now: 10_000,
      laneIdleMs: 5_000,
      crossCheckArmed: true,
    });
    expect(verdict.status).toBe("alive");
  });

  it("clamps a future lane timestamp to age 0 rather than going negative", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 12_000,
      now: 10_000,
      laneIdleMs: 5_000,
      crossCheckArmed: true,
    });
    expect(verdict.laneAgeMs).toBe(0);
    expect(verdict.status).toBe("alive");
  });
});

describe("evaluateLiveness — lane idle, cross-check armed", () => {
  const idleInput = {
    laneRecencyMs: 1_000,
    now: 10_000,
    laneIdleMs: 5_000,
    crossCheckArmed: true,
  };

  it("wedged substrate but live agent descendants → alive (accurate verdict)", () => {
    const verdict = evaluateLiveness({
      ...idleInput,
      hasLiveDescendants: () => true,
    });
    expect(verdict.status).toBe("alive");
    expect(verdict.laneFresh).toBe(false);
    expect(verdict.laneAgeMs).toBe(9_000);
    expect(verdict.liveDescendants).toBe(true);
    expect(verdict.reason).toContain("wedged");
  });

  it("lane idle and no live descendants → stalled", () => {
    const verdict = evaluateLiveness({
      ...idleInput,
      hasLiveDescendants: () => false,
    });
    expect(verdict.status).toBe("stalled");
    expect(verdict.liveDescendants).toBe(false);
  });

  it("empty lane and no live descendants → stalled", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: undefined,
      now: 10_000,
      laneIdleMs: 5_000,
      crossCheckArmed: true,
      hasLiveDescendants: () => false,
    });
    expect(verdict.status).toBe("stalled");
    expect(verdict.laneAgeMs).toBeUndefined();
  });

  it("empty lane but live descendants → alive", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: undefined,
      now: 10_000,
      laneIdleMs: 5_000,
      crossCheckArmed: true,
      hasLiveDescendants: () => true,
    });
    expect(verdict.status).toBe("alive");
    expect(verdict.liveDescendants).toBe(true);
  });
});

describe("evaluateLiveness — hard-silence backstop (#2203)", () => {
  it("lane silent past the hard cap → stalled even with live descendants", () => {
    // A wedged agent (a live child at flat cpu that stops advancing the lane)
    // must never hold a slot forever: past laneHardIdleMs the descendant check
    // is overridden, and the probe is not even consulted.
    let probed = false;
    const verdict = evaluateLiveness({
      laneRecencyMs: 1_000,
      now: 2_000_000, // laneAgeMs = 1_999_000ms, well past the hard cap
      laneIdleMs: 5_000,
      laneHardIdleMs: 1_800_000, // 30 min
      crossCheckArmed: true,
      hasLiveDescendants: () => {
        probed = true;
        return true;
      },
    });
    expect(verdict.status).toBe("stalled");
    expect(verdict.reason).toContain("hard-silence");
    expect(probed).toBe(false);
  });

  it("fires under a disarmed cross-check too (container silent past the hard cap)", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 1_000,
      now: 2_000_000,
      laneIdleMs: 5_000,
      laneHardIdleMs: 1_800_000,
      crossCheckArmed: false,
    });
    expect(verdict.status).toBe("stalled");
  });

  it("does not fire before the hard cap — live descendants still read alive", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 1_000,
      now: 100_000, // laneAgeMs = 99_000ms: past soft idle, under the hard cap
      laneIdleMs: 5_000,
      laneHardIdleMs: 1_800_000,
      crossCheckArmed: true,
      hasLiveDescendants: () => true,
    });
    expect(verdict.status).toBe("alive");
  });

  it("undefined laneHardIdleMs preserves the pre-#2203 behaviour", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 1_000,
      now: 2_000_000,
      laneIdleMs: 5_000,
      crossCheckArmed: true,
      hasLiveDescendants: () => true,
    });
    expect(verdict.status).toBe("alive");
  });
});

describe("evaluateLiveness — issue wall-clock ceiling (#2286)", () => {
  it("never reports STALLED for an attempt whose lane is fresh, whatever its duration (#2701)", () => {
    // AC1: a heartbeat inside the liveness window proves the attempt was
    // working. Total duration may exceed the ceiling — that is a `capped`
    // verdict (a policy deadline), never a stall.
    for (const issueAgeMs of [1_800_001, 2_775_000, 86_400_000]) {
      const verdict = evaluateLiveness({
        laneRecencyMs: issueAgeMs - 1_000, // last activity 1s ago
        now: issueAgeMs,
        laneIdleMs: 300_000,
        issueClaimedAtMs: 0,
        issueWallClockMaxMs: 1_800_000,
        crossCheckArmed: true,
        hasLiveDescendants: () => true,
      });
      expect(verdict.status).not.toBe("stalled");
      expect(verdict.status).toBe("capped");
      expect(verdict.laneFresh).toBe(true);
    }
  });

  it("fresh lane + live descendants but age past the ceiling → capped", () => {
    // Activity-independence: neither a fresh lane nor a live agent tree may
    // veto the per-issue wall-clock ceiling. The descendant probe is not even
    // consulted, because activity is irrelevant to an age-based cap.
    let probed = false;
    const verdict = evaluateLiveness({
      laneRecencyMs: 1_999_000,
      now: 2_000_000, // laneAgeMs = 1_000ms → lane fresh
      laneIdleMs: 5_000,
      issueClaimedAtMs: 0, // claimed 2_000_000ms ago
      issueWallClockMaxMs: 1_800_000, // 30 min
      crossCheckArmed: true,
      hasLiveDescendants: () => {
        probed = true;
        return true;
      },
    });
    expect(verdict.status).toBe("capped");
    expect(verdict.laneFresh).toBe(true);
    expect(verdict.wallClockExceeded).toBe(true);
    expect(verdict.issueAgeMs).toBe(2_000_000);
    expect(probed).toBe(false);
  });

  it("uses a reason distinct from the silence-based caps", () => {
    const wallClock = evaluateLiveness({
      laneRecencyMs: 1_999_000,
      now: 2_000_000,
      laneIdleMs: 5_000,
      issueClaimedAtMs: 0,
      issueWallClockMaxMs: 1_800_000,
      crossCheckArmed: true,
    });
    const hardSilence = evaluateLiveness({
      laneRecencyMs: 1_000,
      now: 2_000_000,
      laneIdleMs: 5_000,
      laneHardIdleMs: 1_800_000,
      crossCheckArmed: true,
    });
    expect(wallClock.reason).toContain("issue wall-clock ceiling");
    expect(wallClock.reason).not.toContain("hard-silence");
    expect(hardSilence.reason).not.toContain("issue wall-clock ceiling");
  });

  it("fires under a disarmed cross-check too (container past the ceiling)", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 1_999_000,
      now: 2_000_000,
      laneIdleMs: 5_000,
      issueClaimedAtMs: 0,
      issueWallClockMaxMs: 1_800_000,
      crossCheckArmed: false,
    });
    expect(verdict.status).toBe("capped");
    expect(verdict.wallClockExceeded).toBe(true);
  });

  it("does not fire under the ceiling — a fresh lane still reads alive", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 999_000,
      now: 1_000_000,
      laneIdleMs: 5_000,
      issueClaimedAtMs: 0, // 1_000_000ms old, under the 30-min ceiling
      issueWallClockMaxMs: 1_800_000,
      crossCheckArmed: true,
    });
    expect(verdict.status).toBe("alive");
    expect(verdict.wallClockExceeded).toBeUndefined();
    expect(verdict.issueAgeMs).toBeUndefined();
  });

  it("an unset ceiling or unknown claim epoch disables the cap", () => {
    const noCeiling = evaluateLiveness({
      laneRecencyMs: 1_999_000,
      now: 2_000_000,
      laneIdleMs: 5_000,
      issueClaimedAtMs: 0,
      crossCheckArmed: true,
    });
    const noClaimEpoch = evaluateLiveness({
      laneRecencyMs: 1_999_000,
      now: 2_000_000,
      laneIdleMs: 5_000,
      issueWallClockMaxMs: 1_800_000,
      crossCheckArmed: true,
    });
    expect(noCeiling.status).toBe("alive");
    expect(noClaimEpoch.status).toBe("alive");
  });
});

describe("evaluateLiveness — lane idle, cross-check disarmed (container)", () => {
  it("cannot corroborate without the host tree → unknown, probe never called", () => {
    let probed = false;
    const verdict = evaluateLiveness({
      laneRecencyMs: 1_000,
      now: 10_000,
      laneIdleMs: 5_000,
      crossCheckArmed: false,
      hasLiveDescendants: () => {
        probed = true;
        return true;
      },
    });
    expect(verdict.status).toBe("unknown");
    expect(verdict.crossCheckArmed).toBe(false);
    expect(verdict.liveDescendants).toBeUndefined();
    expect(verdict.reason).toContain("container isolation");
    expect(probed).toBe(false);
  });
});

describe("process-tree descendant probe", () => {
  const snapshot = [
    "1 0",
    "100 1", // agent
    "200 100", // child of agent
    "300 200", // grandchild
    "400 1", // unrelated
  ].join("\n");

  it("parsePsSnapshot reads pid/ppid pairs and skips junk lines", () => {
    const entries = parsePsSnapshot("  10   3  \n\nheader junk\n20 10\n");
    expect(entries).toEqual([
      { pid: 10, ppid: 3 },
      { pid: 20, ppid: 10 },
    ]);
  });

  it("hasDescendantInSnapshot finds direct and transitive descendants", () => {
    const entries = parsePsSnapshot(snapshot);
    expect(hasDescendantInSnapshot(100, entries)).toBe(true); // has children
    expect(hasDescendantInSnapshot(200, entries)).toBe(true); // grandchild path
    expect(hasDescendantInSnapshot(300, entries)).toBe(false); // leaf
    expect(hasDescendantInSnapshot(400, entries)).toBe(false); // no children
    expect(hasDescendantInSnapshot(999, entries)).toBe(false); // absent pid
  });

  it("createProcessDescendantProbe wires a fake snapshot into a bool probe", () => {
    const aliveProbe = createProcessDescendantProbe({
      agentPid: 100,
      snapshot: () => snapshot,
    });
    const deadProbe = createProcessDescendantProbe({
      agentPid: 300,
      snapshot: () => snapshot,
    });
    expect(aliveProbe()).toBe(true);
    expect(deadProbe()).toBe(false);
  });

  it("a probe whose snapshot throws degrades to false", () => {
    const probe = createProcessDescendantProbe({
      agentPid: 100,
      snapshot: () => {
        throw new Error("no ps");
      },
    });
    expect(probe()).toBe(false);
  });

  it("wires end-to-end into evaluateLiveness as the wedged-substrate verdict", () => {
    const verdict = evaluateLiveness({
      laneRecencyMs: 0,
      now: 10_000,
      laneIdleMs: 5_000,
      ...resolveLivenessCrossCheckArming({ sandboxTag: "none" }),
      hasLiveDescendants: createProcessDescendantProbe({
        agentPid: 100,
        snapshot: () => snapshot,
      }),
    });
    expect(verdict.status).toBe("alive");
    expect(verdict.liveDescendants).toBe(true);
  });
});
