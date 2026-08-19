import { describe, it, expect } from "vitest";
import type { LivenessVerdict, RunResult } from "@reddb-io/worker";
import {
  runAgent,
  startGoalWatch,
  type SandcastleDeps,
  DONE_SIGNAL,
  type AttemptProgressInfo,
} from "../src/core/execution.js";

import { baseInput, fakeResult, makeDeps } from "./execution-test-helpers.js";

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

describe("startGoalWatch — goal predicate (ADR 0057)", () => {
  it("aborts once the claimed issue is observed CLOSED", async () => {
    let closed = false;
    const sched = manualScheduler();
    let aborted = false;
    const g = startGoalWatch({
      intervalMs: 50,
      schedule: sched.schedule,
      goalProbe: async () => closed,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // open → no-op
    expect(aborted).toBe(false);
    expect(g.firedGoalMoot()).toBe(false);
    closed = true;
    await sched.tick(); // CLOSED observed → moot
    expect(aborted).toBe(true);
    expect(g.firedGoalMoot()).toBe(true);
    g.stop();
  });

  it("aborts at most once even when later polls still read CLOSED", async () => {
    const sched = manualScheduler();
    let aborts = 0;
    const g = startGoalWatch({
      intervalMs: 50,
      schedule: sched.schedule,
      goalProbe: async () => true,
      abort: () => {
        aborts += 1;
      },
    });
    await sched.tick();
    await sched.tick();
    expect(aborts).toBe(1);
    g.stop();
  });

  it("never aborts while the issue is open or the read fails (uncertainty is a no-op)", async () => {
    const states: Array<boolean | undefined> = [false, undefined];
    let i = 0;
    const sched = manualScheduler();
    let aborted = false;
    const g = startGoalWatch({
      intervalMs: 50,
      schedule: sched.schedule,
      goalProbe: async () => states[i++],
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // false → no-op
    await sched.tick(); // undefined (read failed) → no-op
    expect(aborted).toBe(false);
    expect(g.firedGoalMoot()).toBe(false);
    g.stop();
  });

  it("swallows a goalProbe rejection and treats it as uncertainty (no abort)", async () => {
    const sched = manualScheduler();
    let aborted = false;
    const g = startGoalWatch({
      intervalMs: 50,
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

describe("runAgent — no attempt-progress guard (ADR 0103)", () => {
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
    const p = runAgent(deps, { ...baseInput, headProbe: async () => "static", goalProbe: async () => closed });
    await sched.tick(); // open → run continues
    closed = true;
    await sched.tick(); // CLOSED → abort with goal-moot
    const res = await p;
    expect(res.outcome).toBe("goal-moot");
    expect(res.branch).toBe(baseInput.branch);
    expect(res.commits).toEqual([]);
  });

  it("never aborts a run that makes no commit: the wall-clock progress guard is gone", async () => {
    // The pre-ADR-0103 engine armed a commit-anchored watchdog here and would
    // have returned `timeout`. There is no cap to arm any more — a long,
    // never-committing run completes on its own terms and stall detection is the
    // fleet supervisor's castle-liveness evaluator alone.
    let clock = 0;
    const sched = manualScheduler();
    const controller = new AbortController();
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(() => new Promise<RunResult>((res) => (resolveRun = res))),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, { ...baseInput, headProbe: async () => "static" });
    for (const t of [1000, 60_000, 3_600_000, 24 * 3_600_000]) {
      clock = t;
      await sched.tick();
    }
    expect(controller.signal.aborted).toBe(false);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    expect((await p).outcome).toBe("done");
  });

  it("does not create an AbortController at all when neither goal watch nor reaper is armed", async () => {
    let seenSignal: AbortSignal | undefined;
    let made = 0;
    const deps: SandcastleDeps = {
      ...makeDeps(async (o) => {
        seenSignal = o.signal;
        return fakeResult({ completionSignal: DONE_SIGNAL });
      }),
      schedule: manualScheduler().schedule,
      makeAbortController: () => {
        made += 1;
        return new AbortController();
      },
    };
    const res = await runAgent(deps, baseInput);
    expect(res.outcome).toBe("done");
    expect(made).toBe(0);
    expect(seenSignal).toBeUndefined();
  });

  it("passes the abort signal through to sandcastle's run options when the goal watch is armed", async () => {
    let seenSignal: AbortSignal | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(async (o) => {
        seenSignal = o.signal;
        return fakeResult({ completionSignal: DONE_SIGNAL });
      }),
      schedule: manualScheduler().schedule,
    };
    await runAgent(deps, { ...baseInput, goalProbe: async () => false });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("fires the vitals heartbeat under docker isolation without any guard (issue #405)", async () => {
    // The sampler arms identically regardless of sandbox mode — runAgent gates
    // only on `onHeartbeat`, never on sandboxMode or a wall-clock cap.
    let clock = 0;
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(() => new Promise<RunResult>((res) => (resolveRun = res))),
      now: () => clock,
      schedule: sched.schedule,
    };
    const p = runAgent(deps, {
      ...baseInput,
      sandboxMode: "docker",
      cwd: "/red/tmp/workers/w1/42",
      headProbe: async () => "static",
      onHeartbeat: (info) => ticks.push(info),
    });
    await sched.tick();
    expect(ticks).toHaveLength(1);
    clock = 20_000;
    await sched.tick();
    expect(ticks).toHaveLength(2);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    expect((await p).outcome).toBe("done");
  });
});

describe("runAgent — lane-idle reaper wiring", () => {
  // The reaper reasons in epoch SECONDS; `now` here is ms (runAgent divides /1000).
  const BASE_MS = 1_000_000_000;

  const stalledAfter = (clockRef: () => number) => (): LivenessVerdict | null => {
    const idleMs = clockRef() - BASE_MS;
    if (idleMs >= 600_000) {
      return { status: "stalled", laneFresh: false, laneAgeMs: idleMs, crossCheckArmed: false, reason: "lane idle" };
    }
    return { status: "alive", laneFresh: true, laneAgeMs: idleMs, crossCheckArmed: false, reason: "lane fresh" };
  };

  it("reaps an idle run with its OWN AbortController when no goal watch armed one", async () => {
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
    // No goalProbe here — with the guard removed, the reaper's own
    // `if (!controller) controller = makeController()` is the ONLY construction
    // site left, so a run with no goal predicate must still be killable.
    const p = runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      laneIdlePollSeconds: 30,
      // Lane last wrote at spawn; a sleep-only inner child — no agent turns, no
      // build/test descendant under the tree, flat cpu.
      livenessVerdictProbe: stalledAfter(() => clock),
      inspectTree: () => [{ command: "sleep", cpu: 0 }],
    });
    await sched.tick(); // worker age 0 → not yet a candidate
    clock = BASE_MS + 1800_000; // idle 1800s ≥ kill, no active descendant → reap
    await sched.tick();
    const res = await p;
    expect(controller.signal.aborted).toBe(true);
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
    const p = runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      livenessVerdictProbe: stalledAfter(() => clock),
      inspectTree: () => [{ command: "vitest", cpu: 0 }], // a test run mid-flight
    });
    clock = BASE_MS + 9999_000; // idle far past kill, but busy → never reaped
    await sched.tick();
    expect(controller.signal.aborted).toBe(false);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });

  it("does not arm the reaper when the liveness probe / tree inspector are absent", async () => {
    const deps = makeDeps(async () => fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      // no livenessVerdictProbe / inspectTree → reaper stays disarmed
    });
    expect(res.outcome).toBe("done");
  });
});

// ---- worker-vitals heartbeat drivers (ADR 0103): sampler + codex stream pulse ----

describe("runAgent — worker-vitals heartbeat", () => {
  it("invokes onHeartbeat on the sampler cadence while the run is in flight", async () => {
    let clock = 0;
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(() => new Promise<RunResult>((res) => (resolveRun = res))),
      now: () => clock,
      schedule: sched.schedule,
    };
    const p = runAgent(deps, { ...baseInput, headProbe: async () => "static", onHeartbeat: (i) => ticks.push(i) });
    await sched.tick(); // one sample while the run hangs → onHeartbeat fires
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]!.head).toBe("static");
    expect(typeof ticks[0]!.lastProgressMs).toBe("number");
    expect(typeof ticks[0]!.nowMs).toBe("number");
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });

  it("pulses the heartbeat from codex stream activity before the first sample", async () => {
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
    };
    const p = runAgent(deps, {
      ...baseInput,
      runner: "codex",
      model: "gpt-5.4",
      logPath: "/tmp/afk.log",
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

  it("keeps non-codex stream activity on the scheduled sampler cadence", async () => {
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
    };
    const p = runAgent(deps, {
      ...baseInput,
      logPath: "/tmp/afk.log",
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
