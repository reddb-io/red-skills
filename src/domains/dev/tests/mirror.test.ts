import { describe, expect, it } from "vitest";
import {
  codexSinkPlan,
  mirrorPlan,
  mirrorReconcile,
  type MirrorCall,
  type TrackedTask,
  type WorkerRecord,
} from "../src/core/mirror.js";

function running(worker_id: string, issue: number, title: string, stage: string): WorkerRecord {
  return { worker_id, issue, title, stage, started_at: "x", status: "running" };
}

describe("mirror reconcile", () => {
  it("cold reconcile: every live worker becomes a TaskCreate", () => {
    const desired: WorkerRecord[] = [
      running("wAAAA", 22, "extract state.sh", "impl"),
      running("wBBBB", 30, "second worker", "tests"),
    ];
    const ops = mirrorReconcile(desired, []);
    expect(ops.map((o) => o.op).sort()).toEqual(["create", "create"]);
    expect(ops.map((o) => o.key).sort()).toEqual(["wAAAA:22", "wBBBB:30"]);
  });

  it("steady state: tracked at the same stage emits no ops", () => {
    const desired: WorkerRecord[] = [running("wAAAA", 22, "t", "impl")];
    const tracked: TrackedTask[] = [{ key: "wAAAA:22", stage: "impl" }];
    expect(mirrorReconcile(desired, tracked)).toEqual([]);
  });

  it("stage advance produces an update carrying the new stage", () => {
    const ops = mirrorReconcile(
      [running("wAAAA", 22, "t", "tests")],
      [{ key: "wAAAA:22", stage: "impl" }],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe("update");
    expect(ops[0]!.stage).toBe("tests");
  });

  it("terminal gone for a tracked worker completes it", () => {
    const ops = mirrorReconcile(
      [{ worker_id: "wAAAA", issue: 22, title: "t", stage: "impl", started_at: "x", status: "gone" }],
      [{ key: "wAAAA:22", stage: "impl" }],
    );
    expect(ops[0]!.op).toBe("complete");
    expect(ops[0]!.result).toBe("completed");
  });

  it("blocked terminal completes with failed", () => {
    const ops = mirrorReconcile(
      [{ worker_id: "wAAAA", issue: 22, title: "t", stage: "impl", started_at: "x", status: "blocked" }],
      [{ key: "wAAAA:22", stage: "impl" }],
    );
    expect(ops[0]!.result).toBe("failed");
  });

  it("tracked worker absent from desired is dropped/completed", () => {
    const ops = mirrorReconcile(
      [running("wBBBB", 30, "u", "tests")],
      [{ key: "wAAAA:22", stage: "impl" }],
    );
    const sorted = ops.map((o) => `${o.op} ${o.key}`).sort();
    expect(sorted).toEqual(["complete wAAAA:22", "create wBBBB:30"]);
  });

  it("terminal status for an untracked worker is ignored", () => {
    const ops = mirrorReconcile(
      [{ worker_id: "wZZZZ", issue: 99, title: "z", stage: "impl", started_at: "x", status: "gone" }],
      [],
    );
    expect(ops).toEqual([]);
  });
});

describe("mirror plan", () => {
  const readWorkers = (): WorkerRecord[] => [
    running("wAAAA", 22, "extract state.sh", "impl"),
    running("wBBBB", 30, "second worker", "tests"),
    { worker_id: "wCCCC", issue: 31, title: "crashed", stage: "impl", started_at: "x", status: "gone" },
  ];

  it("cold plan creates one task per live worker (untracked gone ignored)", () => {
    const plan = mirrorPlan(readWorkers(), []);
    expect(plan.map((c) => c.call).sort()).toEqual(["TaskCreate", "TaskCreate"]);
    const a = plan.find((c) => c.key === "wAAAA:22")!;
    expect(a.call).toBe("TaskCreate");
    expect(a.title).toBe("#22 wAAAA — extract state.sh");
    expect(a.description).toBe("stage: impl");
    expect(a.state).toBe("in_progress");
  });

  it("each live worker maps to exactly one create", () => {
    const plan = mirrorPlan(readWorkers(), []);
    const creates = plan.filter((c) => c.call === "TaskCreate").map((c) => c.key).sort();
    expect(creates).toEqual(["wAAAA:22", "wBBBB:30"]);
  });

  it("tracked gone worker maps to a completed TaskUpdate; unchanged emit nothing", () => {
    const tracked: TrackedTask[] = [
      { key: "wAAAA:22", stage: "impl" },
      { key: "wBBBB:30", stage: "tests" },
      { key: "wCCCC:31", stage: "impl" },
    ];
    const plan = mirrorPlan(readWorkers(), tracked);
    const c = plan.find((p) => p.key === "wCCCC:31")!;
    expect(c.call).toBe("TaskUpdate");
    expect(c.state).toBe("completed");
    const unchanged = plan.filter((p) => p.key === "wAAAA:22" || p.key === "wBBBB:30");
    expect(unchanged).toEqual([]);
  });

  it("stage advance maps to a stage-refreshing TaskUpdate", () => {
    const plan = mirrorPlan(
      [running("wAAAA", 22, "t", "review")],
      [{ key: "wAAAA:22", stage: "impl" }],
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.call).toBe("TaskUpdate");
    expect(plan[0]!.description).toBe("stage: review");
    expect(plan[0]!.state).toBe("in_progress");
  });

  it("re-hydration: an empty tracked set recreates every live worker, then is idempotent", () => {
    const rehydrate = mirrorPlan(readWorkers(), []);
    const creates = rehydrate.filter((c) => c.call === "TaskCreate").map((c) => c.key).sort();
    expect(creates).toEqual(["wAAAA:22", "wBBBB:30"]);
    // dead worker produces no ghost task on a cold tick
    expect(rehydrate.find((c) => c.key === "wCCCC:31")).toBeUndefined();
    // second tick: build the tracked set from what reopen created → zero ops
    const tracked: TrackedTask[] = rehydrate
      .filter((c) => c.call === "TaskCreate")
      .map((c) => ({ key: c.key, stage: c.description!.replace(/^stage: /, "") }));
    expect(mirrorPlan(readWorkers(), tracked)).toEqual([]);
  });
});

describe("codex sink", () => {
  const workers: WorkerRecord[] = [running("wAAAA", 22, "extract state.sh", "impl")];

  it("falls back to the dashboard notice when no native surface exists", () => {
    const result = codexSinkPlan(workers, [], { nativeTaskAvailable: false });
    expect(result.plan).toEqual([]);
    expect(result.notice).toContain("no native task surface");
  });

  it("emits the shared mirror_plan when a native surface is available", () => {
    const result = codexSinkPlan(workers, [], { nativeTaskAvailable: true });
    expect(result.notice).toBeUndefined();
    expect(result.plan).toEqual(mirrorPlan(workers, []));
    const calls: MirrorCall[] = result.plan;
    expect(calls.map((c) => c.key)).toEqual(["wAAAA:22"]);
  });

  it("defaults to the honest no-native-surface fallback", () => {
    const result = codexSinkPlan(workers, []);
    expect(result.plan).toEqual([]);
    expect(result.notice).toContain("no native task surface");
  });
});
