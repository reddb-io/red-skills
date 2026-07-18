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

  it("cascade-rebases DONE-waiting siblings after a successful land while skipping active workers", async () => {
    const t = tracker();
    const calls: string[] = [];
    const cascadeRebase = vi.fn(async ({ issue }: { issue: number }) => {
      calls.push(`cascade:${issue}`);
      if (issue === 2002) {
        return {
          ok: false as const,
          outcome: "parked" as const,
          message: "agent ladder parked semantic conflict",
        };
      }
      return { ok: true as const, outcome: "rebased" as const };
    });

    const result = await runCastleLanding({
      issue: 2001,
      branch: "worker/2001",
      base: "main",
      gate: gate(true, ["approved"]),
      tracker: {
        ...t,
        async closeIssue(issue) {
          calls.push(`close:${issue}`);
          await t.closeIssue(issue);
        },
        async commentOnIssue(issue, body) {
          calls.push(`comment:${issue}`);
          await t.commentOnIssue(issue, body);
        },
      },
      land: async () => {
        calls.push("land");
        return { ok: true, mergeSha: "trunk-tip" };
      },
      cascade: {
        siblings: [
          { issue: 2002, branch: "worker/2002", state: "done-waiting" },
          { issue: 2003, branch: "worker/2003", state: "done-waiting" },
          { issue: 2004, branch: "worker/2004", state: "active" },
        ],
        rebase: cascadeRebase,
      },
    });

    expect(result).toEqual({
      ok: true,
      mergeSha: "trunk-tip",
      cascade: [
        {
          issue: 2002,
          branch: "worker/2002",
          status: "parked",
          message: "agent ladder parked semantic conflict",
        },
        {
          issue: 2003,
          branch: "worker/2003",
          status: "rebased",
        },
        {
          issue: 2004,
          branch: "worker/2004",
          status: "skipped-active",
        },
      ],
    });
    expect(cascadeRebase).toHaveBeenCalledTimes(2);
    expect(cascadeRebase).toHaveBeenNthCalledWith(1, {
      issue: 2002,
      branch: "worker/2002",
      base: "main",
      trunkTip: "trunk-tip",
    });
    expect(cascadeRebase).toHaveBeenNthCalledWith(2, {
      issue: 2003,
      branch: "worker/2003",
      base: "main",
      trunkTip: "trunk-tip",
    });
    expect(calls).toEqual([
      "land",
      "cascade:2002",
      "comment:2002",
      "cascade:2003",
      "comment:2003",
      "comment:2004",
      "close:2001",
    ]);
    expect(t.comments.map((comment) => comment.body)).toEqual([
      "🤖 Castle cascade rebase: worker/2002 parked after the landing rebase ladder: agent ladder parked semantic conflict.",
      "🤖 Castle cascade rebase: worker/2003 rebased onto trunk-tip.",
      "🤖 Castle cascade rebase: worker/2004 skipped because the worker is active.",
    ]);
  });
});
