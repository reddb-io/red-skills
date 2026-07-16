import { describe, expect, it, vi } from "vitest";
import type { GateSinkOutcome } from "./gate-sink.js";
import { runCastleLanding, type CastleLandingTracker } from "./landing.js";

function tracker(): CastleLandingTracker & {
  closed: number[];
  comments: Array<{ issue: number; body: string }>;
} {
  const closed: number[] = [];
  const comments: Array<{ issue: number; body: string }> = [];
  return {
    closed,
    comments,
    async closeIssue(issue) {
      closed.push(issue);
    },
    async commentOnIssue(issue, body) {
      comments.push({ issue, body });
    },
  };
}

function gate(ok: boolean, sinkOutcomes: GateSinkOutcome[] = []) {
  return { ok, sinkOutcomes };
}

describe("castle landing coordinator", () => {
  it("does not merge when the gate verdict is red", async () => {
    const t = tracker();
    const land = vi.fn(async () => ({
      ok: true as const,
      mergeSha: "abc1234",
    }));
    const cleanupBranch = vi.fn(async () => {});

    const result = await runCastleLanding({
      issue: 1911,
      branch: "worker/1911",
      gate: gate(false),
      tracker: t,
      land,
      cleanupBranch,
    });

    expect(result).toEqual({ ok: false, reason: "gate-failed" });
    expect(land).not.toHaveBeenCalled();
    expect(cleanupBranch).not.toHaveBeenCalled();
    expect(t.closed).toEqual([]);
  });

  it("parks instead of merging when the gate sink verdict is not approved", async () => {
    const t = tracker();
    const land = vi.fn(async () => ({
      ok: true as const,
      mergeSha: "abc1234",
    }));

    const result = await runCastleLanding({
      issue: 1911,
      branch: "worker/1911",
      gate: gate(true, ["approved", "parked"]),
      tracker: t,
      land,
    });

    expect(result).toEqual({ ok: false, reason: "gate-parked" });
    expect(land).not.toHaveBeenCalled();
    expect(t.comments[0]?.body).toContain("gate sink parked");
  });

  it("merges, closes the tracker issue, then cleans up the worker branch after an approved green gate", async () => {
    const t = tracker();
    const calls: string[] = [];
    const land = vi.fn(async () => {
      calls.push("merge");
      return { ok: true as const, mergeSha: "abc1234" };
    });
    const cleanupBranch = vi.fn(async () => {
      calls.push("cleanup");
    });

    const result = await runCastleLanding({
      issue: 1911,
      branch: "worker/1911",
      base: "main",
      gate: gate(true, ["approved"]),
      tracker: {
        ...t,
        async closeIssue(issue) {
          calls.push("close");
          await t.closeIssue(issue);
        },
      },
      land,
      cleanupBranch,
    });

    expect(result).toEqual({ ok: true, mergeSha: "abc1234" });
    expect(land).toHaveBeenCalledWith({
      issue: 1911,
      branch: "worker/1911",
      base: "main",
    });
    expect(t.closed).toEqual([1911]);
    expect(cleanupBranch).toHaveBeenCalledWith("worker/1911");
    expect(calls).toEqual(["merge", "close", "cleanup"]);
  });

  it("keeps a successfully closed issue landed when branch cleanup fails", async () => {
    const t = tracker();

    const result = await runCastleLanding({
      issue: 1911,
      branch: "worker/1911",
      gate: gate(true),
      tracker: t,
      land: async () => ({ ok: true, mergeSha: "abc1234" }),
      cleanupBranch: async () => {
        throw new Error("cleanup failed");
      },
    });

    expect(result).toEqual({
      ok: true,
      mergeSha: "abc1234",
      cleanupError: "cleanup failed",
    });
    expect(t.closed).toEqual([1911]);
  });
});
