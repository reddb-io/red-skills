import { describe, expect, it } from "vitest";
import {
  CASTLE_CUTOVER_CONTRACT,
  CUTOVER_REASONS,
  buildCastleCutoverReport,
  isPreCutoverWorker,
  planCastleCutover,
  resolveCutoverActive,
  summarizeCastleCutover,
  type CastleCutoverObservation,
  type CutoverWorkerObservation,
} from "../src/core/castle-cutover-migration.js";

function worker(overrides: Partial<CutoverWorkerObservation> = {}): CutoverWorkerObservation {
  return {
    workerId: "wAAAA",
    issue: 42,
    pid: 111,
    live: true,
    workspace: "/repo/.red/tmp/workers/wAAAA",
    ...overrides,
  };
}

function observation(overrides: Partial<CastleCutoverObservation> = {}): CastleCutoverObservation {
  return { supervisor: null, workers: [], worktrees: [], ...overrides };
}

describe("planCastleCutover", () => {
  it("stops a live classic supervisor before it can respawn a slot", () => {
    const plan = planCastleCutover(
      observation({ supervisor: { pid: 900, live: true }, workers: [worker()] }),
    );
    expect(plan.actions[0]).toMatchObject({ kind: "stop-supervisor", pid: 900 });
    expect(plan.actions[1]).toMatchObject({ kind: "quiesce-worker", pid: 111 });
  });

  it("ignores a supervisor whose pid is no longer live", () => {
    const plan = planCastleCutover(observation({ supervisor: { pid: 900, live: false } }));
    expect(plan.actions).toEqual([]);
  });

  it("quiesces an in-flight pre-cutover worker and keeps its workspace", () => {
    const plan = planCastleCutover(observation({ workers: [worker()] }));
    expect(plan.actions).toEqual([
      {
        kind: "quiesce-worker",
        subject: "wAAAA (#42)",
        reason: CUTOVER_REASONS.workerQuiesced,
        pid: 111,
        issue: 42,
        path: "/repo/.red/tmp/workers/wAAAA",
      },
    ]);
    expect(plan.kept).toContainEqual({
      subject: "wAAAA (#42) workspace",
      reason: CUTOVER_REASONS.workerDead,
    });
  });

  it("never touches a worker the daemon already carries in host state", () => {
    const plan = planCastleCutover(
      observation({ workers: [worker({ unit: "redskilled-wAAAA.service" })] }),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.kept).toEqual([
      { subject: "wAAAA (#42)", reason: CUTOVER_REASONS.workerDaemonBorn },
    ]);
  });

  it("leaves a dead worker to the crash reconcile path", () => {
    const plan = planCastleCutover(observation({ workers: [worker({ live: false })] }));
    expect(plan.actions).toEqual([]);
    expect(plan.kept).toEqual([{ subject: "wAAAA (#42)", reason: CUTOVER_REASONS.workerDead }]);
  });

  it("prunes a dangling worktree registration and keeps a present one", () => {
    const plan = planCastleCutover(
      observation({
        worktrees: [
          { path: "/repo/.red/tmp/workers/wDEAD/7/worktree", present: false },
          { path: "/repo/.red/tmp/workers/wLIVE/8/worktree", present: true },
        ],
      }),
    );
    expect(plan.actions).toEqual([
      {
        kind: "prune-worktree",
        subject: "/repo/.red/tmp/workers/wDEAD/7/worktree",
        reason: CUTOVER_REASONS.worktreePruned,
        path: "/repo/.red/tmp/workers/wDEAD/7/worktree",
      },
    ]);
    expect(plan.kept).toContainEqual({
      subject: "/repo/.red/tmp/workers/wLIVE/8/worktree",
      reason: CUTOVER_REASONS.worktreeKept,
    });
  });

  it("plans nothing on a machine carrying no pre-cutover state", () => {
    expect(planCastleCutover(observation())).toEqual({ actions: [], kept: [] });
  });
});

describe("isPreCutoverWorker", () => {
  it("reads a missing or empty unit as classic birth", () => {
    expect(isPreCutoverWorker(worker())).toBe(true);
    expect(isPreCutoverWorker(worker({ unit: "" }))).toBe(true);
    expect(isPreCutoverWorker(worker({ unit: "redskilled-w.service" }))).toBe(false);
  });
});

describe("summarizeCastleCutover", () => {
  it("reports what moved and what stayed", () => {
    const plan = planCastleCutover(
      observation({
        supervisor: { pid: 900, live: true },
        workers: [worker(), worker({ workerId: "wBBBB", live: false })],
        worktrees: [{ path: "/repo/gone/worktree", present: false }],
      }),
    );
    expect(summarizeCastleCutover(plan)).toBe(
      "castle cutover: 1 supervisor stopped, 1 worker(s) quiesced, 1 worktree registration(s) pruned, 2 artifact(s) left in place",
    );
  });
});

describe("buildCastleCutoverReport", () => {
  it("names both halves of the move under the frozen contract", () => {
    const plan = planCastleCutover(observation({ workers: [worker()] }));
    const report = buildCastleCutoverReport(
      plan,
      { stopped: [], quiesced: ["wAAAA (#42)"], pruned: [], failed: [] },
      "2026-07-30T00:00:00.000Z",
    );
    expect(report.contract).toBe(CASTLE_CUTOVER_CONTRACT);
    expect(report.moved.quiesced).toEqual(["wAAAA (#42)"]);
    expect(report.kept).toContainEqual({
      subject: "wAAAA (#42) workspace",
      reason: CUTOVER_REASONS.workerDead,
    });
    expect(report.reasons).toEqual([
      { subject: "wAAAA (#42)", kind: "quiesce-worker", reason: CUTOVER_REASONS.workerQuiesced },
    ]);
  });
});

describe("resolveCutoverActive", () => {
  it("takes the caller's explicit answer ahead of the env", () => {
    expect(resolveCutoverActive({ RED_CASTLE_CUTOVER: "1" }, false)).toBe(false);
    expect(resolveCutoverActive({}, true)).toBe(true);
  });

  it("honours the operator's env declaration and defaults to off", () => {
    expect(resolveCutoverActive({ RED_CASTLE_CUTOVER: "1" })).toBe(true);
    expect(resolveCutoverActive({ RED_CASTLE_CUTOVER: "true" })).toBe(true);
    expect(resolveCutoverActive({ RED_CASTLE_CUTOVER: "0" })).toBe(false);
    expect(resolveCutoverActive({})).toBe(false);
  });
});
