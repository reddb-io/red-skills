import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRedskilledEventLane,
  rehydrateWorkers,
} from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function worker(workerId: string): RedskilledWorkerView {
  return {
    worker_id: workerId,
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-08T09:00:00.000Z",
    workspace_path: "/tmp/workspace",
    isolated: true,
    unit: `red-worker-${workerId}.service`,
    warnings: [],
  };
}

describe("the bounded host event lane", () => {
  it("rotates before the lane can make boot replay unbounded and retains live Worker births", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-rotation-"));
    roots.push(root);
    const maxBytes = 4_096;
    const lane = createRedskilledEventLane(join(root, "redskilled.log.toonl"), { maxBytes });

    await lane.recordWorker({
      kind: "worker-birth",
      worker: worker("w-live"),
      ts: "2026-08-08T09:00:00.000Z",
    });
    for (let index = 0; index < 80; index += 1) {
      await lane.recordDemandRefusal({
        ts: new Date(Date.parse("2026-08-08T09:01:00.000Z") + index).toISOString(),
        projectLabel: "acme/widgets",
        detail: `refusal-${index}-${"x".repeat(120)}`,
      });
    }

    expect((await stat(lane.path)).size).toBeLessThanOrEqual(maxBytes);
    expect(rehydrateWorkers(await lane.read()).map((entry) => entry.worker_id)).toEqual(["w-live"]);
  });
});
