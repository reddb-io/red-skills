import { describe, expect, it } from "vitest";
import {
  freshWakeStats,
  idleWakeReduction,
  recordWake,
  waitForNextWake,
  type WakeSource,
} from "../src/core/event-wake.js";

/** A never-firing timer: the fallback sleep that only resolves if nobody beats
 * it. Lets a test prove the EVENT lane wins without waiting any real time. */
const neverSleep = () => new Promise<void>(() => undefined);

/** An immediate timer: the fallback that always wins (no event source, or a
 * silent one). */
const immediateSleep = () => Promise.resolve();

describe("waitForNextWake", () => {
  it("returns 'timer' when no wake source is wired (pure-timer fallback)", async () => {
    const reason = await waitForNextWake({ fallbackMs: 5, sleep: immediateSleep });
    expect(reason).toBe("timer");
  });

  it("returns 'event' when a state-change event fires before the timer", async () => {
    // The headline criterion: an event-driven wake fires on state change WITHOUT
    // waiting for the timer (the fallback here never resolves).
    const wake: WakeSource = { waitForEvent: () => Promise.resolve() };
    const reason = await waitForNextWake({ fallbackMs: 999_999, sleep: neverSleep, wake });
    expect(reason).toBe("event");
  });

  it("returns 'timer' when the safety-net fires before any event (no regression)", async () => {
    // A silent worker fleet: the event source never resolves, so the timer is the
    // only thing that wakes the loop — exactly the pre-event behaviour.
    const wake: WakeSource = { waitForEvent: () => new Promise<void>(() => undefined) };
    const reason = await waitForNextWake({ fallbackMs: 1, sleep: immediateSleep, wake });
    expect(reason).toBe("timer");
  });

  it("aborts the wake source's watcher once the timer wins (no leak)", async () => {
    let aborted = false;
    const wake: WakeSource = {
      waitForEvent: (signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    };
    await waitForNextWake({ fallbackMs: 1, sleep: immediateSleep, wake });
    expect(aborted).toBe(true);
  });

  it("aborts the timer leg once an event wins", async () => {
    let aborted = false;
    const wake: WakeSource = { waitForEvent: () => Promise.resolve() };
    await waitForNextWake({
      fallbackMs: 999_999,
      sleep: (_ms, signal) =>
        new Promise<void>(() => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      wake,
    });
    expect(aborted).toBe(true);
  });

  it("falls back to the timer when the wake source throws on setup", async () => {
    const wake: WakeSource = {
      waitForEvent: () => {
        throw new Error("fs.watch unavailable");
      },
    };
    const reason = await waitForNextWake({ fallbackMs: 1, sleep: immediateSleep, wake });
    expect(reason).toBe("timer");
  });
});

describe("wake accounting", () => {
  it("records event vs timer wakes and reports a measurable idle-wake reduction", () => {
    const stats = freshWakeStats();
    expect(idleWakeReduction(stats)).toBe(0); // no data yet

    recordWake(stats, "timer");
    recordWake(stats, "event");
    recordWake(stats, "event");
    recordWake(stats, "timer");

    expect(stats.total).toBe(4);
    expect(stats.event).toBe(2);
    expect(stats.timer).toBe(2);
    // Half the wakes were event-driven — half the timer-baseline's idle polls
    // were displaced by a wake that fired exactly on a real state change.
    expect(idleWakeReduction(stats)).toBe(0.5);
  });

  it("reports zero reduction for a pure-timer baseline (every wake is an idle poll)", () => {
    const stats = freshWakeStats();
    recordWake(stats, "timer");
    recordWake(stats, "timer");
    expect(idleWakeReduction(stats)).toBe(0);
  });

  it("reports full reduction when every wake was event-driven", () => {
    const stats = freshWakeStats();
    recordWake(stats, "event");
    recordWake(stats, "event");
    expect(idleWakeReduction(stats)).toBe(1);
  });
});
