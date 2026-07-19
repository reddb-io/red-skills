import { describe, it, expect } from "vitest";
import {
  buildRunOptions,
  buildContinuousPushHook,
  buildNoLeakCommitMsgHook,
  interpretOutcome,
  interpretCompletion,
  enforceStructuredOutput,
  isExhaustionError,
  isTransientRunnerError,
  extractSignalKill,
  runAgent,
  effortForProvider,
  buildAgent,
  OPENROUTER_API_KEY_ENV,
  type AgentFactories,
  DONE_SIGNAL,
  BLOCKED_SIGNAL,
  COMPLETION_SIGNALS,
  DEFAULT_IDLE_TIMEOUT_S,
  DEFAULT_REMOTE,
  DEFAULT_MAX_ITERATIONS,
  CODEX_EFFORTS,
  CLAUDE_EFFORTS,
  MINIMAX_EFFORTS,
  parseMaxIterations,
  parseIdleTimeout,
  startAttemptGuard,
  exceedsBudget,
  type AttemptBudget,
  type AttemptBudgetUsage,
  type AgentStreamEvent,
  type AttemptProgressInfo,
} from "../src/core/execution.js";

import {
  baseInput,
  fakeAgent,
  fakeResult,
  makeDeps,
} from "./execution-test-helpers.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A manual scheduler: captures the periodic fn so the test pumps ticks. */
function manualScheduler() {
  const fns: Array<() => void> = [];
  const schedule = (fn: () => void, _ms: number) => {
    fns.push(fn);
    return () => {
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    };
  };
  const tick = async () => {
    for (const fn of [...fns]) fn();
    await flush();
  };
  return { schedule, tick };
}

describe("startAttemptGuard — commit-anchored progress watchdog", () => {
  it("aborts once the cap elapses with no new commit", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // t=1000 anchor: head observed, deadline = 1000
    expect(aborted).toBe(false);
    clock = 1050;
    await sched.tick(); // 50ms < cap → alive
    expect(aborted).toBe(false);
    clock = 1100;
    await sched.tick(); // 100ms >= cap, head unchanged → abort
    expect(aborted).toBe(true);
    expect(g.firedTimeout()).toBe(true);
    g.stop();
  });

  it("resets the deadline when HEAD advances (a new commit is real progress)", async () => {
    let clock = 0;
    let head = "sha1";
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => head,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    clock = 10;
    await sched.tick(); // anchor at sha1, deadline=10
    clock = 90;
    head = "sha2";
    await sched.tick(); // commit advanced → deadline resets to 90
    clock = 150;
    await sched.tick(); // 150-90=60 < cap → alive
    expect(aborted).toBe(false);
    clock = 200;
    await sched.tick(); // 200-90=110 >= cap, no further commit → abort
    expect(aborted).toBe(true);
  });

  it("treats an unresolved HEAD (no commit yet) as no progress and still caps", async () => {
    let clock = 0;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => undefined,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    clock = 50;
    await sched.tick();
    expect(aborted).toBe(false);
    clock = 100;
    await sched.tick(); // 100 >= cap from start → abort
    expect(aborted).toBe(true);
  });
});

describe("exceedsBudget — per-attempt budget predicate (#908)", () => {
  const zero: AttemptBudgetUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolsCalled: 0, waiting: 0 };
  it("an empty budget never fires (today's behaviour)", () => {
    expect(exceedsBudget({ ...zero, inputTokens: 9e9, toolsCalled: 9999 }, {})).toBeUndefined();
  });
  it("token ceiling fires on input+output total at-or-above the cap", () => {
    const b: AttemptBudget = { maxTotalTokens: 1000 };
    expect(exceedsBudget({ ...zero, inputTokens: 600, outputTokens: 399 }, b)).toBeUndefined();
    expect(exceedsBudget({ ...zero, inputTokens: 600, outputTokens: 400 }, b)).toBe("tokens");
  });
  it("cost ceiling fires at-or-above the cap", () => {
    expect(exceedsBudget({ ...zero, costUsd: 4.99 }, { maxCostUsd: 5 })).toBeUndefined();
    expect(exceedsBudget({ ...zero, costUsd: 5 }, { maxCostUsd: 5 })).toBe("cost");
  });
  it("runner-agnostic proxy ceilings fire with ZERO token usage (the claude/minimax case)", () => {
    // claude/minimax stream 0 live tokens, so only the proxy ceilings protect them.
    expect(exceedsBudget({ ...zero, toolsCalled: 200 }, { maxToolCalls: 200 })).toBe("tool-calls");
    expect(exceedsBudget({ ...zero, waiting: 30 }, { maxWaitingWindows: 30 })).toBe("waiting-windows");
  });
});

describe("startAttemptGuard — resource budget (#908)", () => {
  it("aborts with reason 'budget' once a ceiling is breached, independent of commits", async () => {
    let clock = 0;
    const sched = manualScheduler();
    let reason: string | undefined;
    let usage: AttemptBudgetUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolsCalled: 0, waiting: 0 };
    const g = startAttemptGuard({
      capMs: 1_000_000, // huge: the wall-clock cap must NOT be what fires
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      budget: { maxToolCalls: 5 },
      budgetUsage: () => usage,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // under budget
    expect(reason).toBeUndefined();
    clock = 100;
    usage = { ...usage, toolsCalled: 5 };
    await sched.tick(); // ceiling reached → abort('budget')
    expect(reason).toBe("budget");
    expect(g.firedBudget()).toBe(true);
    expect(g.firedTimeout()).toBe(false); // a budget abort is NOT a stall
    expect(g.firedGoalMoot()).toBe(false);
    g.stop();
  });

  it("is a no-op when no budget is supplied", async () => {
    let clock = 0;
    const sched = manualScheduler();
    let reason: string | undefined;
    const g = startAttemptGuard({
      capMs: 1_000_000,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    clock = 500;
    await sched.tick();
    expect(reason).toBeUndefined();
    expect(g.firedBudget()).toBe(false);
    g.stop();
  });
});

describe("startAttemptGuard — goal predicate (ADR 0057)", () => {
  it("aborts 'goal-moot' once the claimed issue is observed CLOSED", async () => {
    let clock = 0;
    let closed = false;
    const sched = manualScheduler();
    let reason: string | undefined;
    const g = startAttemptGuard({
      capMs: 100_000, // huge cap so only the goal predicate can fire here
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      goalProbe: async () => closed,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // open → no-op
    expect(reason).toBeUndefined();
    expect(g.firedGoalMoot()).toBe(false);
    closed = true;
    clock = 50;
    await sched.tick(); // CLOSED observed → moot
    expect(reason).toBe("goal-moot");
    expect(g.firedGoalMoot()).toBe(true);
    expect(g.firedTimeout()).toBe(false); // a goal-moot is NOT a stall
    g.stop();
  });

  it("never aborts while the issue is open or the read fails (uncertainty is a no-op)", async () => {
    let clock = 0;
    const states: Array<boolean | undefined> = [false, undefined];
    let i = 0;
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100_000,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      goalProbe: async () => states[i++],
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // false → no-op
    clock = 50;
    await sched.tick(); // undefined (read failed) → no-op
    expect(aborted).toBe(false);
    expect(g.firedGoalMoot()).toBe(false);
    g.stop();
  });

  it("swallows a goalProbe rejection and treats it as uncertainty (no abort)", async () => {
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100_000,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => 0,
      schedule: sched.schedule,
      goalProbe: async () => {
        throw new Error("gh exploded");
      },
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick();
    expect(aborted).toBe(false);
    expect(g.firedGoalMoot()).toBe(false);
    g.stop();
  });
});

describe("runAgent — attempt guard wiring", () => {
  it("returns the 'goal-moot' outcome when the goal predicate aborts the run", async () => {
    let closed = false;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => 0,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      attemptTimeoutSeconds: 1,
      headProbe: async () => "static",
      goalProbe: async () => closed,
    });
    await sched.tick(); // open → run continues
    closed = true;
    await sched.tick(); // CLOSED → abort with goal-moot
    const res = await p;
    expect(res.outcome).toBe("goal-moot");
    expect(res.branch).toBe(baseInput.branch);
    expect(res.commits).toEqual([]);
  });

  it("returns the 'timeout' outcome when the guard aborts a stalled run", async () => {
    let clock = 0;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, { ...baseInput, attemptTimeoutSeconds: 1, headProbe: async () => "static" });
    await sched.tick(); // anchor (capMs = 1000, deadline = 0)
    clock = 1000;
    await sched.tick(); // 1000 >= cap → abort → run rejects
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(res.branch).toBe(baseInput.branch);
    expect(res.commits).toEqual([]);
  });

  it("does not arm the guard (normal completion) when no timeout/headProbe is supplied", async () => {
    const deps = makeDeps(async () => fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await runAgent(deps, baseInput); // no attemptTimeoutSeconds / headProbe
    expect(res.outcome).toBe("done");
  });

  it("passes the abort signal through to sandcastle's run options when armed", async () => {
    let seenSignal: AbortSignal | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(async (o) => {
        seenSignal = o.signal;
        return fakeResult({ completionSignal: DONE_SIGNAL });
      }),
      schedule: manualScheduler().schedule,
    };
    await runAgent(deps, { ...baseInput, attemptTimeoutSeconds: 60, headProbe: async () => "x" });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("fires the proof-of-life heartbeat AND aborts a stall under docker isolation (issue #405)", async () => {
    // The guard arms identically regardless of sandbox mode — runAgent gates only
    // on (attemptTimeoutSeconds + headProbe), never on sandboxMode. So under
    // docker/podman the externalized heartbeat (onHeartbeat) fires each poll and a
    // stalled-but-busy agent is aborted the same as no-sandbox (AC1 + AC2).
    let clock = 0;
    const sched = manualScheduler();
    const controller = new AbortController();
    const ticks: AttemptProgressInfo[] = [];
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      sandboxMode: "docker",
      cwd: "/red/tmp/workers/w1/42-a1",
      attemptTimeoutSeconds: 1,
      headProbe: async () => "static",
      onHeartbeat: (info) => ticks.push(info),
    });
    await sched.tick(); // anchor; heartbeat fires
    expect(ticks).toHaveLength(1);
    clock = 1000;
    await sched.tick(); // cap elapsed, head static → abort
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(ticks.length).toBeGreaterThanOrEqual(2); // proof-of-life fired under isolation
  });
});

describe("startAttemptGuard — diff-anchored progress (ADR 0051, codex false-stall fix)", () => {
  it("resets the deadline when the worktree diff GROWS even with no new commit (the #895 case)", async () => {
    // codex edits without committing: head static, but changed-line volume climbs
    // each poll. The guard must treat that as progress and never false-stall.
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // t=0 anchor (volume=10)
    for (const [t, v] of [
      [50, 60],
      [120, 140],
      [220, 300],
      [400, 497],
    ] as const) {
      clock = t;
      volume = v;
      await sched.tick(); // volume changed since last poll → deadline resets
      expect(aborted).toBe(false);
    }
  });

  it("still aborts when neither a commit NOR an edit lands within the cap (a genuine stall)", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => 42, // volume frozen → no edit signal
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // anchor
    clock = 1050;
    await sched.tick();
    expect(aborted).toBe(false);
    clock = 1100;
    await sched.tick(); // cap elapsed, no commit + frozen volume → abort
    expect(aborted).toBe(true);
    expect(g.firedTimeout()).toBe(true);
  });

  it("does not abort at the soft cap while a dirty worktree is under active validation", async () => {
    let clock = 0;
    let activeDescendant = true;
    const sched = manualScheduler();
    let reason: string | undefined;
    const g = startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 1_000,
      headProbe: async () => "sha-static",
      progressProbe: async () => 40, // real uncommitted work, but no further LOC growth
      activeDescendantProbe: () => activeDescendant,
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // anchor: dirty worktree and validation already running
    clock = 100;
    await sched.tick(); // soft cap reached, but active build/test descendant is productive
    expect(reason).toBeUndefined();
    clock = 200;
    await sched.tick(); // still productive; do not abort solely for no new commit
    expect(reason).toBeUndefined();
    activeDescendant = false;
    clock = 300;
    await sched.tick(); // validation gone, diff flat, no commit → now it is a real stall
    expect(reason).toBe("stalled");
    expect(g.firedTimeout()).toBe(true);
    g.stop();
  });

  it("extends the soft deadline on heartbeat tool activity even when diff volume is flat", async () => {
    let clock = 0;
    let toolsCalled = 0;
    const sched = manualScheduler();
    let reason: string | undefined;
    const g = startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 1_000,
      headProbe: async () => "sha-static",
      progressProbe: async () => 25,
      activityUsage: () => ({
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolsCalled,
        waiting: 0,
      }),
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // anchor
    clock = 90;
    toolsCalled = 1;
    await sched.tick(); // tool activity resets soft progress
    expect(reason).toBeUndefined();
    clock = 170;
    await sched.tick(); // 80ms since tool activity, still under cap
    expect(reason).toBeUndefined();
    clock = 190;
    await sched.tick(); // 100ms since last activity, no commit/edit/activity → stall
    expect(reason).toBe("stalled");
    expect(g.firedTimeout()).toBe(true);
    g.stop();
  });

  it("does not reset the deadline for shrinking diff volume, but stays alive while still within the cap", async () => {
    let clock = 0;
    let volume = 100;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // anchor (100)
    clock = 80;
    volume = 60; // shrink is activity, but not diff growth
    await sched.tick();
    clock = 90;
    await sched.tick(); // only 90ms since anchor → alive even though shrink did not reset
    expect(aborted).toBe(false);
  });

  it("aborts an edit-loop whose diff volume oscillates without a new high-water mark", async () => {
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    let reason: string | undefined;
    const g = startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 1000,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // anchor at volume=10
    clock = 50;
    volume = 20;
    await sched.tick(); // new high-water mark → real progress
    expect(reason).toBeUndefined();
    clock = 100;
    volume = 10;
    await sched.tick(); // shrink: activity, no progress reset
    expect(reason).toBeUndefined();
    clock = 150;
    volume = 20;
    await sched.tick(); // oscillates back to the old high-water mark → abort before hard cap
    expect(reason).toBe("edit-loop-stall");
    expect(g.firedTimeout()).toBe(true);
    g.stop();
  });

  it("degrades to commit-anchored when progressProbe rejects (never the cause of a false reset)", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => {
        throw new Error("worktree gone");
      },
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick();
    clock = 1100;
    await sched.tick(); // probe throws → no edit signal → commit-anchored abort
    expect(aborted).toBe(true);
  });
});

describe("startAttemptGuard — commit-anchored hard cap (issue #637, busy-but-unproductive loop)", () => {
  it("aborts at the hard cap when periodic edits keep resetting the soft deadline but no commit lands", async () => {
    // The #579 worker: code committed, then an open-ended re-validation loop
    // that occasionally touches a test file. Every edit resets the soft
    // deadline, so without the hard cap the guard never fires.
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    let reason: string | undefined;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 200,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // t=0 anchor (first head = spawn commit anchor)
    for (const [t, v] of [
      [50, 60],
      [100, 140],
      [150, 300],
    ] as const) {
      clock = t;
      volume = v;
      await sched.tick(); // edit each poll → soft deadline resets, still under the hard cap
      expect(reason).toBeUndefined();
    }
    clock = 200;
    volume = 999;
    await sched.tick(); // edits continue, but 200ms since last commit >= hardCapMs → abort
    expect(reason).toBe("hard-cap");
  });

  it("a new commit re-anchors the hard cap", async () => {
    let clock = 0;
    let head = "sha1";
    let volume = 10;
    const sched = manualScheduler();
    let reason: string | undefined;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 200,
      headProbe: async () => head,
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // t=0 anchor at sha1
    clock = 150;
    head = "sha2";
    await sched.tick(); // commit → hard cap re-anchors to 150
    clock = 300;
    volume = 20;
    await sched.tick(); // 300-150=150 < 200 → alive (edits within the re-anchored cap)
    expect(reason).toBeUndefined();
    clock = 350;
    volume = 30;
    await sched.tick(); // 350-150=200 >= hardCapMs, no further commit → abort
    expect(reason).toBe("hard-cap");
  });

  it("reports 'stalled' (not 'hard-cap') when the plain soft deadline expires first", async () => {
    let clock = 0;
    const sched = manualScheduler();
    let reason: string | undefined;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 200,
      headProbe: async () => "sha-static",
      progressProbe: async () => 42, // frozen volume → no edit signal
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // anchor
    clock = 100;
    await sched.tick(); // soft cap expires with no commit and no edit
    expect(reason).toBe("stalled");
  });

  it("without hardCapMs, continuous diff growth extends indefinitely (ADR 0051 behaviour unchanged)", async () => {
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick();
    for (const [t, v] of [
      [90, 20],
      [180, 30],
      [600, 40],
      [1200, 50],
    ] as const) {
      clock = t;
      volume = v;
      await sched.tick();
      expect(aborted).toBe(false);
    }
  });
});

describe("runAgent — hard cap wiring (issue #637)", () => {
  it("returns timeout with edit-loop-stall when oscillating edits do not grow the diff", async () => {
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      attemptTimeoutSeconds: 1,
      attemptHardCapSeconds: 90,
      headProbe: async () => "static",
      progressProbe: async () => volume,
    });
    await sched.tick(); // anchor
    clock = 500;
    volume = 20;
    await sched.tick(); // growth → alive
    clock = 1000;
    volume = 10;
    await sched.tick(); // shrink → no reset
    clock = 1500;
    volume = 20;
    await sched.tick(); // no new high-water mark → soft abort, well before 90s hard cap
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(res.timeoutReason).toBe("edit-loop-stall");
    expect(String((controller.signal.reason as Error).message)).toContain("edit-loop-stall");
  });

  it("returns the 'timeout' outcome when the hard cap aborts an editing-but-never-committing run", async () => {
    let clock = 0;
    let volume = 0;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      attemptTimeoutSeconds: 1,
      attemptHardCapSeconds: 2,
      headProbe: async () => "static",
      progressProbe: async () => ++volume, // an edit every poll → soft deadline never expires
    });
    await sched.tick(); // anchor
    clock = 1000;
    await sched.tick(); // soft cap held open by the edit signal → alive
    clock = 2000;
    await sched.tick(); // hard cap (2s) since anchor with no commit → abort
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(controller.signal.reason).toBeInstanceOf(Error);
    expect(String((controller.signal.reason as Error).message)).toContain("hard cap");
  });
});

// ---- lane-idle stall reaper wiring (issue #363) ----

describe("runAgent — lane-idle reaper wiring", () => {
  // The reaper reasons in epoch SECONDS; `now` here is ms (runAgent divides /1000).
  const BASE_MS = 1_000_000_000;
  const BASE_S = BASE_MS / 1000;

  it("returns the 'no-sentinel' outcome when the lane-idle reaper reaps an idle run", async () => {
    let clock = BASE_MS;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    // Probe: lane was last written at spawn (BASE_MS). Returns stalled once
    // clock passes the stallThresholdS (600s = 600_000ms).
    const livenessVerdictProbe = (): LivenessVerdict | null => {
      const idleMs = clock - BASE_MS;
      if (idleMs >= 600_000) {
        return { status: "stalled", laneFresh: false, laneAgeMs: idleMs, crossCheckArmed: false, reason: "lane idle" };
      }
      return { status: "alive", laneFresh: true, laneAgeMs: idleMs, crossCheckArmed: false, reason: "lane fresh" };
    };
    const p = runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      laneIdlePollSeconds: 30,
      // Lane last wrote at spawn; a sleep-only inner child — no agent turns, no
      // build/test descendant under the tree, flat cpu.
      livenessVerdictProbe,
      inspectTree: () => [{ command: "sleep", cpu: 0 }],
    });
    await sched.tick(); // worker age 0 → not yet a candidate
    clock = BASE_MS + 1800_000; // idle 1800s ≥ kill, no active descendant → reap
    await sched.tick();
    const res = await p;
    expect(res.outcome).toBe("no-sentinel");
    expect(res.branch).toBe(baseInput.branch);
    expect(res.commits).toEqual([]);
  });

  it("does NOT reap when an active vitest descendant is under the tree (busy-predicate)", async () => {
    let clock = BASE_MS;
    const sched = manualScheduler();
    const controller = new AbortController();
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(() => new Promise<RunResult>((res) => (resolveRun = res))),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const livenessVerdictProbe2 = (): LivenessVerdict | null => {
      const idleMs = clock - BASE_MS;
      if (idleMs >= 600_000) {
        return { status: "stalled", laneFresh: false, laneAgeMs: idleMs, crossCheckArmed: false, reason: "lane idle" };
      }
      return { status: "alive", laneFresh: true, laneAgeMs: idleMs, crossCheckArmed: false, reason: "lane fresh" };
    };
    const p = runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      livenessVerdictProbe: livenessVerdictProbe2,
      inspectTree: () => [{ command: "vitest", cpu: 0 }], // a test run mid-flight
    });
    clock = BASE_MS + 9999_000; // idle far past kill, but busy → never reaped
    await sched.tick();
    expect(controller.signal.aborted).toBe(false);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });

  it("does not arm the reaper when the lane probe / tree inspector are absent", async () => {
    const deps = makeDeps(async () => fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      // no laneMtimeProbe / inspectTree → reaper stays disarmed
    });
    expect(res.outcome).toBe("done");
  });
});

// ---- externalized proof-of-life (PR-B): onTick / onHeartbeat ----

describe("startAttemptGuard — onTick (externalized heartbeat cadence)", () => {
  it("fires onTick every poll with the progress info, independent of aborting", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    startAttemptGuard({
      capMs: 100_000, // large → never aborts in this test
      intervalMs: 50,
      headProbe: async () => "sha1",
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {},
      onTick: (i) => ticks.push(i),
    });
    await sched.tick();
    clock = 1050;
    await sched.tick();
    expect(ticks.length).toBe(2);
    expect(ticks[0]!.head).toBe("sha1");
    expect(typeof ticks[0]!.lastProgressMs).toBe("number");
    expect(typeof ticks[0]!.nowMs).toBe("number");
  });
});

describe("runAgent — forwards onHeartbeat to the guard tick", () => {
  it("invokes onHeartbeat per poll while the run is in flight (armed)", async () => {
    let clock = 0;
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(() => new Promise<RunResult>((res) => (resolveRun = res))),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => new AbortController(),
    };
    const p = runAgent(deps, {
      ...baseInput,
      attemptTimeoutSeconds: 600,
      headProbe: async () => "static",
      onHeartbeat: (i) => ticks.push(i),
    });
    await sched.tick(); // one poll while the run hangs → onHeartbeat fires
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });

  it("pulses the heartbeat from codex stream activity before the first guard poll", async () => {
    let clock = 0;
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((res) => {
            resolveRun = res;
            if (o.logging?.type === "file") {
              o.logging.onAgentStreamEvent?.({
                type: "toolCall",
                name: "Bash",
                formattedArgs: "pnpm test",
                iteration: 1,
                timestamp: new Date(clock),
              });
            }
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => new AbortController(),
    };
    const p = runAgent(deps, {
      ...baseInput,
      runner: "codex",
      model: "gpt-5.4",
      logPath: "/tmp/afk.log",
      attemptTimeoutSeconds: 60,
      headProbe: async () => "static",
      onHeartbeat: (i) => ticks.push(i),
    });
    await flush();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.head).toBe("static");
    expect(ticks[0]!.nowMs).toBe(0);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });

  it("keeps non-codex stream activity on the scheduled guard cadence", async () => {
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((res) => {
            resolveRun = res;
            if (o.logging?.type === "file") {
              o.logging.onAgentStreamEvent?.({
                type: "toolCall",
                name: "Bash",
                formattedArgs: "pnpm test",
                iteration: 1,
                timestamp: new Date(0),
              });
            }
          }),
      ),
      now: () => 0,
      schedule: sched.schedule,
      makeAbortController: () => new AbortController(),
    };
    const p = runAgent(deps, {
      ...baseInput,
      logPath: "/tmp/afk.log",
      attemptTimeoutSeconds: 60,
      headProbe: async () => "static",
      onHeartbeat: (i) => ticks.push(i),
    });
    await flush();
    expect(ticks).toHaveLength(0);
    await sched.tick();
    expect(ticks).toHaveLength(1);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });
});

