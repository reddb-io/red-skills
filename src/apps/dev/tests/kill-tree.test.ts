import { describe, expect, it, vi } from "vitest";
import { killTreeAndWait, type KillTreeIO } from "../src/runtime/kill-tree.js";

// A deterministic fake of the tree-killer IO: `aliveFor` ticks of liveness, with
// each await sleep() advancing one tick. Records every signal sent so the
// escalation order (SIGTERM then SIGKILL) is asserted.
function fakeIO(opts: { aliveFor: number }): { io: KillTreeIO; signals: NodeJS.Signals[]; ticks: () => number } {
  const signals: NodeJS.Signals[] = [];
  let elapsed = 0;
  const io: KillTreeIO = {
    isAlive: () => elapsed < opts.aliveFor,
    signal: (_pid, sig) => {
      signals.push(sig);
    },
    sleep: async () => {
      elapsed += 1;
    },
  };
  return { io, signals, ticks: () => elapsed };
}

describe("killTreeAndWait", () => {
  it("SIGTERMs and returns dead WITHOUT escalating when the tree exits in the grace window", async () => {
    // Dies after 3 grace polls — well under the 20-tick grace.
    const { io, signals } = fakeIO({ aliveFor: 3 });

    const dead = await killTreeAndWait(123, { io });

    expect(dead).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    expect(signals).not.toContain("SIGKILL");
  });

  it("escalates to SIGKILL after the grace, then confirms exit", async () => {
    // Survives the full 20-tick grace, dies during the SIGKILL confirm window.
    const { io, signals } = fakeIO({ aliveFor: 24 });

    const dead = await killTreeAndWait(123, { io });

    expect(dead).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    // SIGTERM precedes SIGKILL.
    expect(signals.indexOf("SIGTERM")).toBeLessThan(signals.indexOf("SIGKILL"));
  });

  it("reports NOT dead when the tree survives even SIGKILL", async () => {
    // Never dies within the poll budget (uninterruptible-sleep worker).
    const { io, signals } = fakeIO({ aliveFor: Number.POSITIVE_INFINITY });

    const dead = await killTreeAndWait(123, { io });

    expect(dead).toBe(false);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("honours custom grace/kill try budgets", async () => {
    const sleep = vi.fn(async () => {});
    let alive = true;
    const io: KillTreeIO = {
      isAlive: () => alive,
      signal: (_pid, sig) => {
        // Ignore SIGTERM (forces the grace window to elapse), die on SIGKILL.
        if (sig === "SIGKILL") alive = false;
      },
      sleep,
    };

    const dead = await killTreeAndWait(123, { io, graceTries: 2, killTries: 2, pollMs: 5 });

    expect(dead).toBe(true);
    // 2 grace polls (still alive), then SIGKILL flips alive=false → confirmed.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
  });
});
