import { describe, expect, it, vi } from "vitest";
import {
  CASTLE_NO_MORE_TASKS,
  runCastleWorkerDrain,
  selectCastleIssues,
  type CastleIssueCandidate,
} from "./worker-drain.js";

const boot = { precheck: { ok: true } };
const processDeps = {};

function candidate(number: number, labels: string[] = ["ready-for-agent"]): CastleIssueCandidate {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    labels,
  };
}

describe("castle worker drain", () => {
  it("selects urgent first, drops specs, and keeps issue filters ordered", () => {
    const candidates = [
      candidate(30),
      candidate(10, ["ready-for-agent", "priority:urgent"]),
      candidate(20, ["ready-for-agent", "priority:high"]),
      candidate(7, ["ready-for-agent", "type:spec"]),
    ];

    expect(selectCastleIssues(candidates, { kind: "all" }).map((row) => row.number)).toEqual([10, 20, 30]);
    expect(selectCastleIssues(candidates, { kind: "issues", numbers: [30, 10] }).map((row) => row.number)).toEqual([10, 30]);
  });

  it("runs the castle-owned drain loop through claim/work and preserves progress output", async () => {
    const emitted: string[] = [];
    const processIssue = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "claim-lost" })
      .mockResolvedValueOnce({ outcome: "done" });

    const result = await runCastleWorkerDrain({
      gh: { listCandidates: async () => [candidate(1), candidate(2)] },
      runBoot: async () => boot,
      bootDeps: {},
      bootOptions: {},
      processIssue,
      processDeps,
      buildProcessInput: (row, ctx) => ({ issue: row.number, runner: ctx.runner }),
      emit: (line) => emitted.push(line),
    }, {
      runner: "codex",
      workerId: "wAB12",
      filter: { kind: "all" },
      once: true,
      issueTemplate: {},
    });

    expect(processIssue).toHaveBeenCalledTimes(2);
    expect(processIssue.mock.calls.map((call) => call[1])).toEqual([
      { issue: 1, runner: "codex" },
      { issue: 2, runner: "codex" },
    ]);
    expect(result).toMatchObject({
      done: 1,
      blocked: 0,
      failed: 1,
      total: 2,
      stopReason: "once",
    });
    expect(emitted).toEqual([
      "progress: 1/2 (50%) — 1 remaining",
      "progress: 2/2 (100%) — 0 remaining",
      "worker stop: once",
    ]);
  });

  it("emits the frozen no-more-tasks sentinel on an empty queue", async () => {
    const emitted: string[] = [];
    const result = await runCastleWorkerDrain({
      gh: { listCandidates: async () => [] },
      runBoot: async () => boot,
      bootDeps: {},
      bootOptions: {},
      processIssue: async () => ({ outcome: "done" }),
      processDeps,
      buildProcessInput: (row, ctx) => ({ issue: row.number, runner: ctx.runner }),
      emit: (line) => emitted.push(line),
    }, {
      runner: "claude",
      workerId: "wZZ99",
      filter: { kind: "all" },
      issueTemplate: {},
    });

    expect(result.drained).toBe(true);
    expect(result.stopReason).toBe("drain-empty");
    expect(emitted).toEqual([CASTLE_NO_MORE_TASKS]);
  });
});
