import { describe, expect, it } from "vitest";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { redskilledUnitStopArgv, stopWorker } from "../src/reattach.js";

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
      stopUnit: (unit) => {
        stoppedUnits.push(unit);
      },
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

  it("asks for the stop without waiting for the init system to finish it", () => {
    // The daemon that sends this owns the whole machine's socket. A stop that
    // waited for the job would hold that socket for `TimeoutStopSec` every time
    // a SIGTERM-deaf runner was recycled, and every session on the host would
    // read the silence as a dead daemon.
    expect(redskilledUnitStopArgv("red-worker-acme-wUNIT.service")).toEqual([
      "--user",
      "stop",
      "--no-block",
      "red-worker-acme-wUNIT.service",
    ]);
  });

  it("waits for a stop request that answers asynchronously before judging the unit", async () => {
    const order: string[] = [];
    let releaseRequest: () => void = () => undefined;
    const placed = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });

    const contained = stopWorker(UNIT_WORKER, {
      stopUnit: async () => {
        order.push("requested");
        await placed;
      },
      // Read only after the request has been placed; a probe run before it would
      // judge the unit on a stop nobody had asked for yet.
      unitActive: () => {
        order.push("probed");
        return false;
      },
      leaderAlive: () => false,
      killTree: () => true,
    });

    expect(order).toEqual(["requested"]);
    releaseRequest();

    expect(await contained).toBe(true);
    expect(order).toEqual(["requested", "probed"]);
  });
});
