import { describe, expect, it } from "vitest";
import {
  codexSinkPlan,
  mirrorPlan,
  mirrorReconcile,
  mirrorTitle,
  taskMirrorCapability,
  type MirrorCall,
  type TrackedTask,
  type WorkerRecord,
} from "../src/core/mirror.js";

function running(
  worker_id: string,
  issue: number,
  title: string,
  activity: string,
  phase = "coding",
): WorkerRecord {
  return { worker_id, issue, title, slug: title, activity, phase, started_at: "x", status: "running" };
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

  it("steady state: tracked at the same stage AND phase emits no ops", () => {
    const desired: WorkerRecord[] = [running("wAAAA", 22, "t", "impl", "coding")];
    const tracked: TrackedTask[] = [{ key: "wAAAA:22", activity: "impl", phase: "coding" }];
    expect(mirrorReconcile(desired, tracked)).toEqual([]);
  });

  it("stage advance produces an update carrying the new stage", () => {
    const ops = mirrorReconcile(
      [running("wAAAA", 22, "t", "tests", "coding")],
      [{ key: "wAAAA:22", activity: "impl", phase: "coding" }],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe("update");
    expect(ops[0]!.activity).toBe("tests");
  });

  it("phase advance at the same stage still produces an update (re-titles)", () => {
    const ops = mirrorReconcile(
      [running("wAAAA", 22, "t", "commit", "validating")],
      [{ key: "wAAAA:22", activity: "commit", phase: "coding" }],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe("update");
    expect(ops[0]!.phase).toBe("validating");
  });

  it("terminal gone for a tracked worker completes it", () => {
    const ops = mirrorReconcile(
      [{ worker_id: "wAAAA", issue: 22, title: "t", slug: "t", activity: "impl", phase: "merging", started_at: "x", status: "gone" }],
      [{ key: "wAAAA:22", activity: "impl", phase: "coding" }],
    );
    expect(ops[0]!.op).toBe("complete");
    expect(ops[0]!.result).toBe("completed");
  });

  it("blocked terminal completes with failed", () => {
    const ops = mirrorReconcile(
      [{ worker_id: "wAAAA", issue: 22, title: "t", slug: "t", activity: "impl", phase: "blocked", started_at: "x", status: "blocked" }],
      [{ key: "wAAAA:22", activity: "impl", phase: "coding" }],
    );
    expect(ops[0]!.result).toBe("failed");
    expect(ops[0]!.phase).toBe("blocked");
  });

  it("tracked worker absent from desired is dropped/completed", () => {
    const ops = mirrorReconcile(
      [running("wBBBB", 30, "u", "tests")],
      [{ key: "wAAAA:22", activity: "impl", phase: "coding" }],
    );
    const sorted = ops.map((o) => `${o.op} ${o.key}`).sort();
    expect(sorted).toEqual(["complete wAAAA:22", "create wBBBB:30"]);
  });

  it("terminal status for an untracked worker is ignored", () => {
    const ops = mirrorReconcile(
      [{ worker_id: "wZZZZ", issue: 99, title: "z", slug: "z", activity: "impl", phase: "merging", started_at: "x", status: "gone" }],
      [],
    );
    expect(ops).toEqual([]);
  });
});

describe("mirror title", () => {
  it("renders the calm macro-phase title with the 1-based n/5 position", () => {
    expect(mirrorTitle("wMHZR", 807, "setup", "resolving-merge-conflicts")).toBe(
      "wMHZR [1/5 setup] #807 resolving-merge-conflicts",
    );
    expect(mirrorTitle("wMHZR", 807, "coding", "resolving-merge-conflicts")).toBe(
      "wMHZR [2/5 coding] #807 resolving-merge-conflicts",
    );
    expect(mirrorTitle("wMHZR", 807, "validating", "resolving-merge-conflicts")).toBe(
      "wMHZR [3/5 validating] #807 resolving-merge-conflicts",
    );
    expect(mirrorTitle("wMHZR", 807, "merging", "resolving-merge-conflicts")).toBe(
      "wMHZR [4/5 merging] #807 resolving-merge-conflicts",
    );
    expect(mirrorTitle("wMHZR", 807, "done", "resolving-merge-conflicts")).toBe(
      "wMHZR [5/5 done] #807 resolving-merge-conflicts",
    );
  });

  it("terminal blocked drops the n/5 (edge decision 1)", () => {
    expect(mirrorTitle("wMHZR", 807, "blocked", "slug")).toBe("wMHZR [blocked] #807 slug");
  });

  it("an unknown/empty phase drops the bracket entirely", () => {
    expect(mirrorTitle("wMHZR", 807, "", "slug")).toBe("wMHZR #807 slug");
  });
});

describe("mirror plan", () => {
  const readWorkers = (): WorkerRecord[] => [
    running("wAAAA", 22, "extract state.sh", "impl", "coding"),
    running("wBBBB", 30, "second worker", "tests", "coding"),
    { worker_id: "wCCCC", issue: 31, title: "crashed", slug: "crashed", activity: "impl", phase: "coding", started_at: "x", status: "gone" },
  ];

  it("cold plan creates one task per live worker (untracked gone ignored)", () => {
    const plan = mirrorPlan(readWorkers(), []);
    expect(plan.map((c) => c.call).sort()).toEqual(["TaskCreate", "TaskCreate"]);
    const a = plan.find((c) => c.key === "wAAAA:22")!;
    expect(a.call).toBe("TaskCreate");
    expect(a.title).toBe("wAAAA [2/5 coding] #22 extract state.sh");
    expect(a.description).toBe("activity: impl");
    expect(a.state).toBe("in_progress");
  });

  it("each live worker maps to exactly one create", () => {
    const plan = mirrorPlan(readWorkers(), []);
    const creates = plan.filter((c) => c.call === "TaskCreate").map((c) => c.key).sort();
    expect(creates).toEqual(["wAAAA:22", "wBBBB:30"]);
  });

  it("tracked gone worker maps to a completed TaskUpdate; unchanged emit nothing", () => {
    const tracked: TrackedTask[] = [
      { key: "wAAAA:22", activity: "impl", phase: "coding" },
      { key: "wBBBB:30", activity: "tests", phase: "coding" },
      { key: "wCCCC:31", activity: "impl", phase: "coding" },
    ];
    const plan = mirrorPlan(readWorkers(), tracked);
    const c = plan.find((p) => p.key === "wCCCC:31")!;
    expect(c.call).toBe("TaskUpdate");
    expect(c.state).toBe("completed");
    expect(c.title).toBeUndefined();
    const unchanged = plan.filter((p) => p.key === "wAAAA:22" || p.key === "wBBBB:30");
    expect(unchanged).toEqual([]);
  });

  it("terminal blocked maps to a failed TaskUpdate that re-titles to [blocked]", () => {
    const blocked: WorkerRecord = {
      worker_id: "wAAAA", issue: 22, title: "t", slug: "t", activity: "impl", phase: "blocked", started_at: "x", status: "blocked",
    };
    const plan = mirrorPlan([blocked], [{ key: "wAAAA:22", activity: "impl", phase: "coding" }]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.call).toBe("TaskUpdate");
    expect(plan[0]!.state).toBe("failed");
    expect(plan[0]!.title).toBe("wAAAA [blocked] #22 t");
  });

  it("stage advance maps to a stage-refreshing, phase-titled TaskUpdate", () => {
    const plan = mirrorPlan(
      [running("wAAAA", 22, "t", "review", "coding")],
      [{ key: "wAAAA:22", activity: "impl", phase: "coding" }],
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.call).toBe("TaskUpdate");
    expect(plan[0]!.description).toBe("activity: review");
    expect(plan[0]!.title).toBe("wAAAA [2/5 coding] #22 t");
    expect(plan[0]!.state).toBe("in_progress");
  });

  it("phase advance re-titles the task to the new macro phase", () => {
    const plan = mirrorPlan(
      [running("wAAAA", 22, "t", "commit", "merging")],
      [{ key: "wAAAA:22", activity: "commit", phase: "validating" }],
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.call).toBe("TaskUpdate");
    expect(plan[0]!.title).toBe("wAAAA [4/5 merging] #22 t");
  });

  it("re-hydration: an empty tracked set recreates every live worker, then is idempotent", () => {
    const rehydrate = mirrorPlan(readWorkers(), []);
    const creates = rehydrate.filter((c) => c.call === "TaskCreate").map((c) => c.key).sort();
    expect(creates).toEqual(["wAAAA:22", "wBBBB:30"]);
    // dead worker produces no ghost task on a cold tick
    expect(rehydrate.find((c) => c.key === "wCCCC:31")).toBeUndefined();
    // second tick: build the tracked set from what reopen created → zero ops.
    // The phase is parsed back from the title's bracket (`[n/5 phase]`).
    const tracked: TrackedTask[] = rehydrate
      .filter((c) => c.call === "TaskCreate")
      .map((c) => ({
        key: c.key,
        activity: c.description!.replace(/^activity: /, ""),
        phase: c.title!.match(/\[(?:\d+\/5 )?([a-z]+)\]/)![1]!,
      }));
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

describe("task mirror host capability matrix (#886)", () => {
  it("Claude Code drives the native task surface (TaskCreate/TaskUpdate)", () => {
    const cap = taskMirrorCapability("claude");
    expect(cap.surface).toBe("native-task");
    expect(cap.agentDriven).toBe(true);
    expect(cap.nativeTaskApi).toBe(true);
    expect(cap.note).toContain("Agent runner");
  });

  it("Codex has no task API — monitor-agent fallback, not parity", () => {
    const cap = taskMirrorCapability("codex");
    expect(cap.surface).toBe("monitor-agent");
    expect(cap.agentDriven).toBe(true);
    expect(cap.nativeTaskApi).toBe(false);
    expect(cap.note).toContain("Codex monitor agent");
  });

  it("OpenCode is a headless runner with no host session to mirror into", () => {
    const cap = taskMirrorCapability("opencode");
    expect(cap.surface).toBe("headless");
    expect(cap.agentDriven).toBe(false);
    expect(cap.nativeTaskApi).toBe(false);
    expect(cap.note).toContain("OpenCode runner");
  });

  it("no two hosts claim parity — each surface is distinct", () => {
    const surfaces = (["claude", "codex", "opencode"] as const).map(
      (h) => taskMirrorCapability(h).surface,
    );
    expect(new Set(surfaces).size).toBe(3);
    // Exactly one host exposes a native task API; the matrix never implies parity.
    expect(surfaces.filter((s) => s === "native-task")).toHaveLength(1);
  });

  it("the host token is normalized (case / whitespace insensitive)", () => {
    expect(taskMirrorCapability("  Codex \n").surface).toBe("monitor-agent");
  });

  it("an unknown host fails loudly instead of inheriting the Claude path", () => {
    expect(() => taskMirrorCapability("gemini")).toThrow(/unknown host 'gemini'/);
  });
});
