import { describe, expect, it } from "vitest";
import {
  passExitBarrier,
  ExitBarrierError,
  type ExitBarrierPorts,
  type PushResult,
} from "../src/core/exit-barrier.js";

// Everything injected is a fake — no real git ever runs. Each test records the
// salvage/push call sequence so the barrier's contract (salvage → push → receipt,
// retry-once, hard-error-on-failure) is asserted as a trace.

interface Trace {
  salvageCalls: string[];
  pushCalls: string[];
  headCalls: string[];
}

function harness(
  overrides: Partial<{
    salvage: (branch: string) => Promise<number>;
    push: (branch: string) => Promise<PushResult>;
    headSha: (branch: string) => Promise<string>;
  }> = {},
): { ports: ExitBarrierPorts; trace: Trace } {
  const trace: Trace = { salvageCalls: [], pushCalls: [], headCalls: [] };
  const ports: ExitBarrierPorts = {
    salvage: async (branch) => {
      trace.salvageCalls.push(branch);
      return overrides.salvage ? overrides.salvage(branch) : 0;
    },
    push: async (branch) => {
      trace.pushCalls.push(branch);
      return overrides.push ? overrides.push(branch) : { ok: true };
    },
    headSha: async (branch) => {
      trace.headCalls.push(branch);
      return overrides.headSha ? overrides.headSha(branch) : "deadbeef";
    },
    nowIso: () => "2026-07-03T12:00:00Z",
  };
  return { ports, trace };
}

describe("passExitBarrier", () => {
  it("clean worktree → branch pushed, no salvage commit in the receipt", async () => {
    const { ports, trace } = harness({ salvage: async () => 0 });

    const receipt = await passExitBarrier(ports, "afk/w1/42-x");

    expect(receipt).toEqual({
      branch: "afk/w1/42-x",
      head: "deadbeef",
      pushedAt: "2026-07-03T12:00:00Z",
      salvaged: false,
      salvagedFiles: 0,
    });
    // Salvage was attempted (found nothing) and the branch was pushed exactly once.
    expect(trace.salvageCalls).toEqual(["afk/w1/42-x"]);
    expect(trace.pushCalls).toEqual(["afk/w1/42-x"]);
  });

  it("dirty worktree → salvage commit created and pushed, flagged in the receipt", async () => {
    const { ports, trace } = harness({
      salvage: async () => 3,
      headSha: async () => "cafef00d",
    });

    const receipt = await passExitBarrier(ports, "afk/w1/42-x");

    expect(receipt.salvaged).toBe(true);
    expect(receipt.salvagedFiles).toBe(3);
    expect(receipt.head).toBe("cafef00d");
    // Salvage ran before the push so the pushed ref carries the salvage commit.
    expect(trace.salvageCalls).toEqual(["afk/w1/42-x"]);
    expect(trace.pushCalls).toEqual(["afk/w1/42-x"]);
  });

  it("push fails once then succeeds → retried, receipt returned", async () => {
    let attempts = 0;
    const { ports, trace } = harness({
      push: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: "remote rejected" } : { ok: true };
      },
    });

    const receipt = await passExitBarrier(ports, "afk/w1/42-x");

    expect(receipt.head).toBe("deadbeef");
    // Pushed twice: the initial rejection, then the successful retry.
    expect(trace.pushCalls).toEqual(["afk/w1/42-x", "afk/w1/42-x"]);
  });

  it("push fails after retry → throws ExitBarrierError (attempt not clean)", async () => {
    const { ports, trace } = harness({
      push: async () => ({ ok: false, error: "remote rejected" }),
    });

    await expect(passExitBarrier(ports, "afk/w1/42-x")).rejects.toBeInstanceOf(ExitBarrierError);
    // Exactly two attempts: the initial push and one retry, then it gives up.
    expect(trace.pushCalls).toEqual(["afk/w1/42-x", "afk/w1/42-x"]);
    // No head sha is read on the failure path — there is no receipt to build.
    expect(trace.headCalls).toEqual([]);
  });

  it("the thrown error names the branch and the last push detail", async () => {
    const { ports } = harness({
      push: async () => ({ ok: false, error: "non-fast-forward" }),
    });

    await expect(passExitBarrier(ports, "afk/w1/42-x")).rejects.toMatchObject({
      branch: "afk/w1/42-x",
      message: expect.stringContaining("non-fast-forward"),
    });
  });

  it("a salvage that throws is swallowed — the push still saves the branch", async () => {
    const { ports, trace } = harness({
      salvage: async () => {
        throw new Error("salvage boom");
      },
    });

    const receipt = await passExitBarrier(ports, "afk/w1/42-x");

    // Salvage failure degrades to 0 files, never blocks the load-bearing push.
    expect(receipt.salvaged).toBe(false);
    expect(receipt.salvagedFiles).toBe(0);
    expect(trace.pushCalls).toEqual(["afk/w1/42-x"]);
  });

  it("a push port that throws is treated as a failed push and retried", async () => {
    let attempts = 0;
    const { ports, trace } = harness({
      push: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network down");
        return { ok: true };
      },
    });

    const receipt = await passExitBarrier(ports, "afk/w1/42-x");

    expect(receipt.head).toBe("deadbeef");
    expect(trace.pushCalls).toEqual(["afk/w1/42-x", "afk/w1/42-x"]);
  });
});
