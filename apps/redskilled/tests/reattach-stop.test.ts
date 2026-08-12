import { describe, expect, it } from "vitest";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { stopWorker } from "../src/reattach.js";

const UNIT_WORKER: RedskilledWorkerView = {
  worker_id: "wUNIT",
  project_label: "acme/widgets",
  pid: 4_242,
  pgid: 4_343,
  started_at: "2026-08-11T10:00:00.000Z",
  workspace_path: "/workspaces/acme",
  isolated: true,
  unit: "red-worker-acme-wUNIT.service",
  warnings: [],
};

describe("unit-held Worker teardown", () => {
  it("escalates a successful unit stop whose leader survives and reports the refusal", async () => {
    const stoppedUnits: string[] = [];
    const killedGroups: number[] = [];

    const contained = await stopWorker(UNIT_WORKER, {
      stopUnit: (unit) => stoppedUnits.push(unit),
      unitActive: () => false,
      leaderAlive: () => true,
      killTree: async (pgid) => {
        killedGroups.push(pgid);
        return false;
      },
    });

    expect(stoppedUnits).toEqual(["red-worker-acme-wUNIT.service"]);
    expect(killedGroups).toEqual([4_343]);
    expect({ contained }).toEqual({ contained: false });
  });
});
