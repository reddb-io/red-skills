/**
 * cross-host-smoke.test.ts — deterministic Task-mirror smoke test (issue #889).
 *
 * Replays three fixed Worker-state snapshots through the full pipeline:
 *   readWorkers() → [claude mirrorPlan | codex codexSinkPlan]
 *
 * No live agent, no live OpenCode server, no native Claude/Codex host API.
 * Run as a quick operator check that parity claims hold and fallbacks degrade cleanly.
 */
import { describe, expect, it } from "vitest";
import {
  codexSinkPlan,
  mirrorPlan,
  readWorkers,
  taskMirrorCapability,
  type WorkerStateRead,
} from "../src/core/mirror.js";
import { AfkStateSchema } from "../src/types/state.js";

// ── fixtures ─────────────────────────────────────────────────────────────────
//
// Three archetypal Worker snapshots:
//   wAAAA — live, in the coding phase, micro-stage "impl"
//   wBBBB — live, in the merging phase, micro-stage "commit"
//   wCCCC — dead process whose last macro-phase was "blocked" (terminal failure)

function snapshot(
  worker_id: string,
  number: number,
  title: string,
  slug: string,
  activity: string,
  phase: string,
) {
  return AfkStateSchema.parse({
    worker_id,
    started_at: "2026-06-24T00:00:00Z",
    current: { number, title, slug, activity, phase },
  });
}

const READS: WorkerStateRead[] = [
  {
    state: snapshot("wAAAA", 889, "add-deterministic-cross-host-task-mirror", "cross-host-mirror", "impl", "coding"),
    live: true,
  },
  {
    state: snapshot("wBBBB", 887, "surface-codex-task-mirror-fallback", "codex-fallback", "commit", "merging"),
    live: true,
  },
  {
    state: snapshot("wCCCC", 885, "old-blocked-slice", "old-blocked", "impl", "blocked"),
    live: false,
  },
];

// The normalized WorkerRecord set shared by all three host sinks below.
const WORKERS = readWorkers(READS);

// ── fixture normalization ─────────────────────────────────────────────────────

describe("Worker-state fixture normalization (readWorkers)", () => {
  it("produces three records — two running, one blocked-terminal", () => {
    expect(WORKERS).toHaveLength(3);
    expect(WORKERS.find((w) => w.worker_id === "wAAAA")?.status).toBe("running");
    expect(WORKERS.find((w) => w.worker_id === "wBBBB")?.status).toBe("running");
    expect(WORKERS.find((w) => w.worker_id === "wCCCC")?.status).toBe("blocked");
  });

  it("normalizes phase and slug from the raw state", () => {
    const a = WORKERS.find((w) => w.worker_id === "wAAAA")!;
    expect(a.phase).toBe("coding");
    expect(a.slug).toBe("cross-host-mirror");
    expect(a.issue).toBe(889);
  });
});

// ── Claude Code (native-task) ─────────────────────────────────────────────────

describe("Claude Code host (native-task surface)", () => {
  it("capability: native-task, agent-driven, nativeTaskApi=true", () => {
    const cap = taskMirrorCapability("claude");
    expect(cap.surface).toBe("native-task");
    expect(cap.agentDriven).toBe(true);
    expect(cap.nativeTaskApi).toBe(true);
  });

  it("cold plan: two TaskCreate for the running workers; untracked blocked is not mirrored", () => {
    const plan = mirrorPlan(WORKERS, []);
    const creates = plan.filter((c) => c.call === "TaskCreate");
    expect(creates).toHaveLength(2);
    expect(plan.find((c) => c.key === "wCCCC:885")).toBeUndefined();
  });

  it("TaskCreate carries macro-phase title (n/5) and micro-stage description", () => {
    const plan = mirrorPlan(WORKERS, []);
    const a = plan.find((c) => c.key === "wAAAA:889")!;
    expect(a.call).toBe("TaskCreate");
    expect(a.title).toBe("wAAAA [2/5 coding] #889 cross-host-mirror");
    expect(a.description).toBe("activity: impl");
    expect(a.state).toBe("in_progress");

    const b = plan.find((c) => c.key === "wBBBB:887")!;
    expect(b.title).toBe("wBBBB [4/5 merging] #887 codex-fallback");
    expect(b.description).toBe("activity: commit");
  });

  it("steady-state: once tracked at the current stage+phase, no ops emitted", () => {
    const coldPlan = mirrorPlan(WORKERS, []);
    const tracked = coldPlan
      .filter((c) => c.call === "TaskCreate")
      .map((c) => ({
        key: c.key,
        activity: c.description!.replace(/^activity: /, ""),
        phase: c.title!.match(/\[(?:\d+\/5 )?([a-z]+)\]/)![1]!,
      }));
    expect(mirrorPlan(WORKERS, tracked)).toEqual([]);
  });

  it("tracked blocked worker maps to a failed TaskUpdate re-titled [blocked]", () => {
    const plan = mirrorPlan(WORKERS, [{ key: "wCCCC:885", activity: "impl", phase: "coding" }]);
    const fail = plan.find((c) => c.key === "wCCCC:885")!;
    expect(fail.call).toBe("TaskUpdate");
    expect(fail.state).toBe("failed");
    expect(fail.title).toBe("wCCCC [blocked] #885 old-blocked");
  });

  it("tracked worker absent from the live set maps to a completed TaskUpdate", () => {
    const plan = mirrorPlan(
      [WORKERS.find((w) => w.worker_id === "wAAAA")!],
      [{ key: "wBBBB:887", activity: "commit", phase: "merging" }],
    );
    const done = plan.find((c) => c.key === "wBBBB:887")!;
    expect(done.call).toBe("TaskUpdate");
    expect(done.state).toBe("completed");
  });
});

// ── Codex (monitor-agent fallback) ───────────────────────────────────────────

describe("Codex host (monitor-agent fallback — no native task API)", () => {
  it("capability: monitor-agent, agent-driven, nativeTaskApi=false", () => {
    const cap = taskMirrorCapability("codex");
    expect(cap.surface).toBe("monitor-agent");
    expect(cap.agentDriven).toBe(true);
    expect(cap.nativeTaskApi).toBe(false);
  });

  it("default sink: empty plan + dashboard notice (honest no-parity)", () => {
    const result = codexSinkPlan(WORKERS, []);
    expect(result.plan).toEqual([]);
    expect(result.notice).toContain("no native task surface");
  });

  it("notice is always present regardless of worker set — Codex never silently implies parity", () => {
    expect(codexSinkPlan([], []).notice).toBeTruthy();
    expect(codexSinkPlan(WORKERS, []).notice).toBeTruthy();
  });

  it("when a future native surface is wired in, the shared mirror plan is emitted", () => {
    const result = codexSinkPlan(WORKERS, [], { nativeTaskAvailable: true });
    expect(result.notice).toBeUndefined();
    expect(result.plan).toEqual(mirrorPlan(WORKERS, []));
  });
});

// ── OpenCode host adapter (prototype, capability-gated) ──────────────────────


// ── cross-host parity contract ────────────────────────────────────────────────

describe("cross-host parity contract", () => {
  it("each host drives a distinct progress surface — no two hosts claim parity", () => {
    const surfaces = (["claude", "codex", "opencode"] as const).map(
      (h) => taskMirrorCapability(h).surface,
    );
    expect(new Set(surfaces).size).toBe(3);
  });

  it("exactly one host exposes nativeTaskApi=true across the full host matrix", () => {
    const nativeCount = (["claude", "codex", "opencode"] as const).filter(
      (h) => taskMirrorCapability(h).nativeTaskApi,
    ).length;
    expect(nativeCount).toBe(1);
  });

});
