// The rates reach the payload from the daemon's own history: a heartbeat the
// daemon received and a Worker outcome it recorded, with nothing re-derived by
// the surface that reads them. The clock is posed, so the arithmetic is the
// same one the pure tests pin.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { publishRedskilledWorkerLogLine, readRedskilledStatuslinePayload } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { createRedskilledEventLane } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { REDSKILLED_WORKER_DISPLAY_ABSENT } from "../src/worker-display.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const START = Date.parse("2026-08-02T12:00:00.000Z");

function view(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-02T12:00:00.000Z",
    workspace_path: "/tmp/acme/w-1",
    isolated: true,
    warnings: [],
    ...overrides,
  };
}

describe("the daemon's live metrics", () => {
  it("replays the canonical TOONL observations after a daemon restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-metrics-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const lane = createRedskilledEventLane(paths.eventLanePath);
    const worker = view();
    await lane.recordWorker({ kind: "worker-birth", worker, ts: "2026-08-02T10:00:00.000Z" });
    await lane.recordWorker({
      kind: "worker-metrics",
      worker,
      ts: "2026-08-02T10:00:00.000Z",
      tokens: 0,
      tools: 0,
      runner: "codex",
      model: "gpt-5.6",
    });
    await lane.recordWorker({
      kind: "worker-metrics",
      worker,
      ts: "2026-08-02T11:00:00.000Z",
      tokens: 1_200,
      tools: 4,
      runner: "codex",
      model: "gpt-5.6",
    });

    const daemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      liveness: () => true,
      clock: () => "2026-08-02T11:30:00.000Z",
    });
    running.push(daemon);

    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });
    expect(payload.metrics?.history_48h).toBeDefined();
    expect(payload.metrics?.history_48h?.tokens_per_hour.buckets.at(-2)?.value).toBe(1_200);
    expect(payload.metrics?.day.tokens_per_min.value).toBe(20);
  });

  it("derives its rates from the heartbeats it received and the outcomes it recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-metrics-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    // Every daemon-stamped instant, posed: the first heartbeat, the second five
    // minutes later, the outcome, and the read.
    let minutes = 0;
    const daemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => new Date(START + minutes * 60_000).toISOString(),
    });
    running.push(daemon);
    daemon.trackWorker(view());
    daemon.trackWorker(view({ worker_id: "w-2", pid: 4343, workspace_path: "/tmp/acme/w-2" }));

    const beat = async (worker_id: string, tokens: number, tools: number, runner: string) => {
      await publishRedskilledWorkerLogLine(paths, {
        worker_id,
        line: "working",
        display: { ...REDSKILLED_WORKER_DISPLAY_ABSENT, tokens, tools, runner, model: "opus" },
        session_project: "acme/widgets",
      });
    };

    await beat("w-1", 1_000, 2, "claude");
    await beat("w-2", 0, 0, "codex");
    minutes = 5;
    await beat("w-1", 4_000, 12, "claude");
    await beat("w-2", 1_500, 3, "codex");
    // One Worker ends; the daemon records the outcome on the same instant.
    await daemon.releaseWorker("w-2");

    minutes = 10;
    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });

    // 3000 + 1500 tokens and 10 + 3 tools, across the five minutes they span.
    expect(payload.metrics?.hour.tokens_per_min.value).toBe(900);
    expect(payload.metrics?.hour.tools_per_min.value).toBeCloseTo(13 / 5, 10);
    expect(payload.metrics?.hour.issues_per_hour.value).toBe(1);
    expect(payload.metrics?.hour.runner_share.shares).toEqual([
      { key: "claude", worker_count: 1, share: 0.5 },
      { key: "codex", worker_count: 1, share: 0.5 },
    ]);
    expect(payload.metrics?.hour.unavailable).toEqual([]);
  });

  it("reports absence, not zero, on a daemon nothing has heartbeat to", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-metrics-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const daemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
    });
    running.push(daemon);

    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });

    expect(payload.metrics?.hour.tokens_per_min.value).toBeNull();
    expect(payload.metrics?.hour.issues_per_hour.value).toBeNull();
    expect(payload.metrics?.hour.unavailable).toEqual(["worker-vitals", "worker-outcomes"]);
  });
});
