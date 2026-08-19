import { describe, expect, it } from "vitest";
import {
  TWO_PLAYER_CONTRACT,
  TWO_PLAYER_REASONS,
  TWO_PLAYER_RECOVERY_DOC,
  buildTwoPlayerReport,
  planTwoPlayerMigration,
  resolveTwoPlayerActive,
  summarizeTwoPlayerMigration,
  type TwoPlayerObservation,
  type TwoPlayerWorkerObservation,
} from "../src/core/two-player-migration.js";

function worker(overrides: Partial<TwoPlayerWorkerObservation> = {}): TwoPlayerWorkerObservation {
  return {
    workerId: "wAAAA",
    issue: 42,
    pid: 111,
    live: true,
    unit: "red-worker-wAAAA.service",
    workspace: "/repo/.red/tmp/workers/wAAAA",
    heldByHost: false,
    ...overrides,
  };
}

function observation(overrides: Partial<TwoPlayerObservation> = {}): TwoPlayerObservation {
  return {
    projectLabel: "red-skills",
    runtime: null,
    workers: [],
    registered: false,
    ...overrides,
  };
}

describe("planTwoPlayerMigration", () => {
  it("stops the live per-project runtime before touching anything else", () => {
    const plan = planTwoPlayerMigration(
      observation({ runtime: { pid: 900, live: true }, workers: [worker()] }),
    );
    expect(plan.actions[0]).toMatchObject({ kind: "stop-runtime", pid: 900 });
  });

  it("ignores a runtime whose pid is no longer live", () => {
    const plan = planTwoPlayerMigration(observation({ runtime: { pid: 900, live: false } }));
    expect(plan.actions.filter((action) => action.kind === "stop-runtime")).toEqual([]);
    expect(plan.kept).toContainEqual({
      subject: "project runtime pid 900",
      reason: TWO_PLAYER_REASONS.runtimeAlreadyGone,
    });
  });

  it("re-adopts a live Worker instead of stopping it", () => {
    const plan = planTwoPlayerMigration(observation({ workers: [worker()] }));
    expect(plan.actions).toContainEqual({
      kind: "readopt-worker",
      subject: "wAAAA (#42)",
      reason: TWO_PLAYER_REASONS.workerReadopted,
      workerId: "wAAAA",
      projectLabel: "red-skills",
      issue: 42,
      unit: "red-worker-wAAAA.service",
    });
    expect(plan.actions.map((action) => action.kind)).not.toContain("quiesce-worker");
  });

  it("keeps a live Worker's claim, branch and workspace exactly where they are", () => {
    const plan = planTwoPlayerMigration(observation({ workers: [worker()] }));
    expect(plan.kept).toContainEqual({
      subject: "wAAAA (#42) claim",
      reason: TWO_PLAYER_REASONS.claimKept,
    });
  });

  it("has nothing to move for a Worker the host already holds", () => {
    const plan = planTwoPlayerMigration(observation({ workers: [worker({ heldByHost: true })] }));
    expect(plan.actions.filter((action) => action.kind === "readopt-worker")).toEqual([]);
    expect(plan.kept).toContainEqual({
      subject: "wAAAA (#42)",
      reason: TWO_PLAYER_REASONS.workerAlreadyHeld,
    });
  });

  it("leaves a dead Worker to the crash reconcile path", () => {
    const plan = planTwoPlayerMigration(observation({ workers: [worker({ live: false })] }));
    expect(plan.actions.filter((action) => action.kind === "readopt-worker")).toEqual([]);
    expect(plan.kept).toContainEqual({
      subject: "wAAAA (#42)",
      reason: TWO_PLAYER_REASONS.workerDead,
    });
  });

  it("never registers the project itself — that is the MCP's move to make", () => {
    const plan = planTwoPlayerMigration(observation({ runtime: { pid: 900, live: true } }));
    expect(plan.actions.map((action) => action.kind)).toEqual(["stop-runtime"]);
    expect(plan.kept).toContainEqual({
      subject: "red-skills",
      reason: TWO_PLAYER_REASONS.projectRegistrationIsCallers,
    });
  });

  it("says so when the daemon already holds the project", () => {
    const plan = planTwoPlayerMigration(observation({ registered: true }));
    expect(plan.actions).toEqual([]);
    expect(plan.kept).toContainEqual({
      subject: "red-skills",
      reason: TWO_PLAYER_REASONS.projectAlreadyRegistered,
    });
  });

  it("is a no-op on a machine that already reached the two-player model", () => {
    const plan = planTwoPlayerMigration(
      observation({ registered: true, workers: [worker({ heldByHost: true })] }),
    );
    expect(plan.actions).toEqual([]);
  });
});

describe("summarizeTwoPlayerMigration", () => {
  it("names what moved, what stayed, and where to go when it misbehaved", () => {
    const plan = planTwoPlayerMigration(
      observation({ runtime: { pid: 900, live: true }, workers: [worker()] }),
    );
    const summary = summarizeTwoPlayerMigration(plan);
    expect(summary).toContain("1 project runtime stopped");
    expect(summary).toContain("1 worker(s) re-adopted");
    expect(summary).toContain("left in place");
    expect(summary).toContain(TWO_PLAYER_RECOVERY_DOC);
  });
});

describe("buildTwoPlayerReport", () => {
  it("stamps both halves of the move, including what the host refused", () => {
    const plan = planTwoPlayerMigration(
      observation({ runtime: { pid: 900, live: true }, workers: [worker()] }),
    );
    const report = buildTwoPlayerReport(
      plan,
      { stopped: ["project runtime pid 900"], readopted: [], failed: ["wAAAA (#42)"] },
      "2026-07-31T00:00:00.000Z",
    );
    expect(report.contract).toBe(TWO_PLAYER_CONTRACT);
    expect(report.recovery).toBe(TWO_PLAYER_RECOVERY_DOC);
    expect(report.moved.stopped).toEqual(["project runtime pid 900"]);
    expect(report.moved.failed).toEqual(["wAAAA (#42)"]);
    expect(report.kept.length).toBeGreaterThan(0);
  });
});

describe("resolveTwoPlayerActive", () => {
  it("prefers the caller's explicit statement over the environment", () => {
    expect(resolveTwoPlayerActive({ RED_TWO_PLAYER_CUTOVER: "1" }, false)).toBe(false);
    expect(resolveTwoPlayerActive({}, true)).toBe(true);
  });

  it("is off unless an operator declares the era", () => {
    expect(resolveTwoPlayerActive({})).toBe(false);
    expect(resolveTwoPlayerActive({ RED_TWO_PLAYER_CUTOVER: "yes" })).toBe(true);
  });
});
