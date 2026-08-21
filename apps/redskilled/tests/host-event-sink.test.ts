import { describe, expect, it } from "vitest";
import { createRedskilledHostEventSinkRuntime } from "../src/host-event-sink.js";
import type { RedskilledHostState, RedskilledWorkerView } from "../src/host-state.js";

// #4153: an absent optional notification binary must cost one refusal line,
// never a crash-looping birth through the breaker. This suite drives the sink
// runtime directly, so the probe's once-per-boot memory is pinned where it
// lives rather than inferred from daemon-level launch counts.

const state: RedskilledHostState = {
  version: 1,
  protocol_version: 1,
  workers: [],
} as unknown as RedskilledHostState;

const worker = { worker_id: "source", project_label: "acme/widgets" } as RedskilledWorkerView;

function sinkFixture(commandAvailable: () => boolean) {
  const refusals: string[] = [];
  const started: string[] = [];
  const runtime = createRedskilledHostEventSinkRuntime({
    declaration: {
      workspacePath: "/tmp/sink",
      notifications: ["worker-birth"],
      platform: "linux",
      commandAvailable,
    },
    hostState: () => state,
    liveWorkerIds: () => [],
    admit: () => ({ admitted: true }) as never,
    start: (spec) => {
      started.push(spec.command);
      return { worker_id: spec.worker_id, project_label: spec.project_label } as RedskilledWorkerView;
    },
    refuse: (detail) => refusals.push(detail),
  });
  return { runtime, refusals, started };
}

describe("the host event sink degrades without its binary (#4153)", () => {
  it("births the notification sink when the binary resolves", () => {
    const { runtime, started, refusals } = sinkFixture(() => true);
    runtime.onEvent("worker-birth", worker);
    expect(started).toEqual(["notify-send"]);
    expect(refusals).toEqual([]);
  });

  it("refuses once, out loud, and never births the sink again on this boot", () => {
    const { runtime, started, refusals } = sinkFixture(() => false);
    runtime.onEvent("worker-birth", worker);
    runtime.onEvent("worker-birth", worker);
    runtime.onEvent("worker-birth", worker);
    expect(started).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("native notifications unavailable on this host");
    expect(refusals[0]).toContain("notify-send");
  });
});
