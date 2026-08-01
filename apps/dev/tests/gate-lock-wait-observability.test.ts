// The gate's two host-wide locks are the orchestrator's only silent waits: no
// child, no socket, no write, and up to an hour of `ep_poll` that every
// liveness surface reads as a healthy `live=true` worker (#2985). These tests
// pin the cure — the wait announces itself, and it announces its END.

import { describe, expect, it } from "vitest";
import {
  LOCK_WAIT_NOTICE_INTERVAL_MS,
  formatWaitDuration,
  lockWaitReporter,
  renderLockWaitNotice,
  type LockWaitNotice,
} from "../src/runtime/feedback-worktree.js";
import type { LandLockWaitInfo } from "../src/core/land-lock.js";

function wait(overrides: Partial<LandLockWaitInfo> = {}): LandLockWaitInfo {
  return {
    path: "/repo/.red/state/validation-gate.lock",
    holder: "validation-gate:2001",
    heldBy: "validation-gate:1007",
    heldByPid: 1007,
    heldForMs: 12 * 60_000,
    waitedMs: 0,
    remainingMs: 60 * 60_000,
    attempt: 1,
    ...overrides,
  };
}

describe("gate lock-wait notice", () => {
  it("names the lock, the holder, the wait's age and when it gives up", () => {
    const notice = renderLockWaitNotice("validation-gate", wait({ waitedMs: 90_000, remainingMs: 3_510_000 }));

    expect(notice.state).toBe("waiting");
    expect(notice.lock).toBe("validation-gate");
    expect(notice.heldByPid).toBe(1007);
    expect(notice.message).toContain("validation-gate");
    expect(notice.message).toContain("/repo/.red/state/validation-gate.lock");
    expect(notice.message).toContain("pid 1007");
    expect(notice.message).toContain("waited 1m30s");
    expect(notice.message).toContain("giving up in 58m30s");
  });

  it("stays legible when the lock record cannot be read", () => {
    const notice = renderLockWaitNotice(
      "feedback-worktree",
      wait({ heldBy: undefined, heldByPid: undefined, heldForMs: undefined }),
    );

    expect(notice.heldBy).toBeUndefined();
    expect(notice.message).toContain("unreadable lock record");
  });

  it("renders coarse durations", () => {
    expect(formatWaitDuration(0)).toBe("0m00s");
    expect(formatWaitDuration(9_400)).toBe("0m09s");
    expect(formatWaitDuration(30 * 60_000 + 5_000)).toBe("30m05s");
  });
});

describe("gate lock-wait reporter", () => {
  it("is absent entirely when no sink is wired", () => {
    expect(lockWaitReporter("validation-gate", undefined)).toBeUndefined();
  });

  it("speaks on the first poll, then no more often than the notice interval", () => {
    const seen: LockWaitNotice[] = [];
    const reporter = lockWaitReporter("validation-gate", (n) => seen.push(n))!;

    // A 500ms poll over three minutes: 360 observations.
    for (let i = 1; i <= 360; i++) reporter.onWait(wait({ attempt: i, waitedMs: (i - 1) * 500 }));

    expect(seen[0]?.waitedMs).toBe(0);
    // First poll + one per 30s across 179.5s of waiting.
    expect(seen).toHaveLength(1 + Math.floor((359 * 500) / LOCK_WAIT_NOTICE_INTERVAL_MS));
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.waitedMs - seen[i - 1]!.waitedMs).toBeGreaterThanOrEqual(
        LOCK_WAIT_NOTICE_INTERVAL_MS,
      );
    }
  });

  it("retires the banner when the lock is finally taken", () => {
    const seen: LockWaitNotice[] = [];
    const reporter = lockWaitReporter("validation-gate", (n) => seen.push(n))!;

    reporter.onWait(wait({ attempt: 1, waitedMs: 0 }));
    reporter.onWait(wait({ attempt: 2, waitedMs: 45_000 }));
    reporter.finish(true);

    const last = seen.at(-1)!;
    expect(last.state).toBe("acquired");
    expect(last.message).toContain("after waiting 0m45s");
  });

  it("says so out loud when the wait times out", () => {
    const seen: LockWaitNotice[] = [];
    const reporter = lockWaitReporter("feedback-worktree", (n) => seen.push(n))!;

    reporter.onWait(wait({ attempt: 1, waitedMs: 0 }));
    reporter.onWait(wait({ attempt: 2, waitedMs: 600_000 }));
    reporter.finish(false);

    const last = seen.at(-1)!;
    expect(last.state).toBe("timed-out");
    expect(last.message).toContain("gave up");
    expect(last.message).toContain("validation blocked");
  });

  it("emits nothing at all for an uncontended acquire", () => {
    const seen: LockWaitNotice[] = [];
    const reporter = lockWaitReporter("validation-gate", (n) => seen.push(n))!;

    reporter.finish(true);

    expect(seen).toEqual([]);
  });
});
