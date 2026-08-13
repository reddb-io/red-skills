import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { createRedskilledEventLane, readRedskilledEvents } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const roots: string[] = [];
const running: RedskilledDaemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Worker resource high-water handover (#3802)", () => {
  it("fills a terminal record from durable samples after the unit has vanished", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-high-water-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const worker: RedskilledWorkerView = {
      worker_id: "wHIGH",
      project_label: "acme/widgets",
      pid: 4242,
      started_at: "2026-08-13T12:00:00.000Z",
      workspace_path: "/tmp/workspace",
      isolated: true,
      unit: "red-worker-wHIGH.service",
      warnings: [],
    };
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.recordWorker({ kind: "worker-birth", worker, ts: worker.started_at });
    await lane.recordWorker({
      kind: "worker-resource",
      worker,
      ts: "2026-08-13T12:05:00.000Z",
      memoryPeakBytes: 3_000,
      memorySwapPeakBytes: 700,
      pidsPeak: 19,
    });
    await lane.flush();

    const daemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      liveness: () => false,
      unitInventory: () => [],
      unitExitFacts: () => null,
    });
    running.push(daemon);
    await daemon.flushEvents();

    const death = [...await readRedskilledEvents(paths.eventLanePath)].reverse()
      .find((event) => event.kind === "worker-death");
    expect(death).toMatchObject({
      worker_id: "wHIGH",
      memory_peak_bytes: 3_000,
      memory_swap_peak_bytes: 700,
      pids_peak: 19,
    });
  });
});
