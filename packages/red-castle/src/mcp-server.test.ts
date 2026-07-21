import { describe, expect, it, vi } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "./mcp-server.js";

function deps(): CastleMcpDependencies {
  return {
    fleetList: vi.fn(async () => []),
    fleetStatus: vi.fn(async () => ({
      supervisor: { pid: 42, alive: true, health: "healthy" },
      slots: { busy: 1, free: 1, parked: 0, total: 2 },
      churn: { deaths: 0, respawns: 0, window_s: 300 },
      live_workers: [{ id: "worker-1", pid: 43, issue: "2305" }],
    })),
    fleetCreate: vi.fn(async (input) => ({
      status: "launched",
      name: input.name,
      pid: 42,
    })),
    fleetEdit: vi.fn(async (input) => ({ status: "edited", name: input.name })),
    fleetStop: vi.fn(async (input) => ({
      status: "stopped",
      name: input.name,
    })),
    logs: vi.fn(async () => [
      { at: "2026-07-21T00:00:00.000Z", kind: "worker.started" },
    ]),
    workerVitals: vi.fn(async () => []),
    dashboard: vi.fn(async () => ({ schema_version: "red.dev.dashboard.v1" })),
    monitor: vi.fn(async () => ({ workers: [], events: [], fleet: null })),
    history: vi.fn(async () => []),
    queueStatus: vi.fn(async () => ({
      ready_for_agent: [],
      ready_for_human: [],
    })),
    workerDispatch: vi.fn(async (input) => ({
      status: "completed",
      target: input.issue ?? input.demand,
    })),
    workerStatus: vi.fn(async () => []),
    workerStop: vi.fn(async (input) => ({
      worker: input.worker,
      status: "stopped",
    })),
    runnerList: vi.fn(async () => ({ codex: { efforts: ["low"] } })),
    runnerDetect: vi.fn(async (input) => ({
      runner: input.runner ?? "codex",
      method: input.runner ? "flag" : "env-var",
    })),
    runnerSteer: vi.fn(async (input) => ({
      worker: input.worker,
      steer: "written",
    })),
    workerRequest: vi.fn(async (input) => ({
      status: "completed",
      request: input.text,
    })),
    requeue: vi.fn(async (input) => ({ issue: input.issue, applied: true })),
    retake: vi.fn(async (input) => ({ issue: { number: input.issue } })),
    reap: vi.fn(async () => ({ remote: [], local: [] })),
    unblockSweep: vi.fn(async () => ({ promoted: [] })),
  };
}

describe("dev:afk MCP tools", () => {
  it("publishes the Fleet and Observability domains", () => {
    expect(createCastleMcpTools(deps()).map((tool) => tool.name)).toEqual([
      "fleet_list",
      "fleet_status",
      "fleet_create",
      "fleet_edit",
      "fleet_stop",
      "logs",
      "worker_vitals",
      "dashboard",
      "monitor",
      "history",
      "queue_status",
      "worker_dispatch",
      "worker_status",
      "worker_stop",
      "worker_recycle",
      "runner_list",
      "runner_detect",
      "runner_steer",
      "worker_request",
      "requeue",
      "retake",
      "reap",
      "unblock_sweep",
    ]);
  });

  it("returns structured fleet status without rendering command output", async () => {
    const tools = createCastleMcpTools(deps());
    const status = tools.find((tool) => tool.name === "fleet_status")!;
    await expect(status.invoke({ fleet: "codex" })).resolves.toMatchObject({
      supervisor: { health: "healthy" },
      slots: { total: 2 },
      churn: { deaths: 0 },
      live_workers: [{ id: "worker-1" }],
    });
  });

  it("creates a named fleet and returns raw Castle lane records", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);
    await tools
      .find((tool) => tool.name === "fleet_create")!
      .invoke({
        name: "codex",
        runner: "codex",
        target: 2,
      });
    expect(d.fleetCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "codex" }),
    );

    await expect(
      tools
        .find((tool) => tool.name === "logs")!
        .invoke({ lane: "worker", id: "worker-1" }),
    ).resolves.toEqual([
      { at: "2026-07-21T00:00:00.000Z", kind: "worker.started" },
    ]);
  });

  it("dispatches and stops workers through mutating worker tools", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await tools
      .find((tool) => tool.name === "worker_dispatch")!
      .invoke({ issue: 2306, runner: "codex" });
    expect(d.workerDispatch).toHaveBeenCalledWith({
      issue: 2306,
      runner: "codex",
    });

    await tools
      .find((tool) => tool.name === "worker_stop")!
      .invoke({ worker: "wVM2Z" });
    await tools
      .find((tool) => tool.name === "worker_recycle")!
      .invoke({ worker: "wVM2Z" });
    expect(d.workerStop).toHaveBeenNthCalledWith(1, {
      worker: "wVM2Z",
      recycle: false,
    });
    expect(d.workerStop).toHaveBeenNthCalledWith(2, {
      worker: "wVM2Z",
      recycle: true,
    });

    for (const name of ["worker_dispatch", "worker_stop", "worker_recycle"]) {
      expect(tools.find((tool) => tool.name === name)!.description).toMatch(
        /^MUTATING:/,
      );
    }
  });

  it("lists and detects runners and injects a spawn-time worker request", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools.find((tool) => tool.name === "runner_list")!.invoke({}),
    ).resolves.toEqual({ codex: { efforts: ["low"] } });
    await tools
      .find((tool) => tool.name === "runner_detect")!
      .invoke({ runner: "codex" });
    expect(d.runnerDetect).toHaveBeenCalledWith({ runner: "codex" });

    await tools
      .find((tool) => tool.name === "worker_request")!
      .invoke({ issue: 2306, runner: "codex", text: "Use TDD." });
    expect(d.workerRequest).toHaveBeenCalledWith({
      issue: 2306,
      runner: "codex",
      text: "Use TDD.",
    });
  });

  it("writes a live-steer request into a running worker via runner_steer", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools
        .find((tool) => tool.name === "runner_steer")!
        .invoke({ worker: "wVM2Z", text: "Focus on the failing test first." }),
    ).resolves.toMatchObject({ worker: "wVM2Z", steer: "written" });
    expect(d.runnerSteer).toHaveBeenCalledWith({
      worker: "wVM2Z",
      text: "Focus on the failing test first.",
    });
    expect(
      tools.find((tool) => tool.name === "runner_steer")!.description,
    ).toMatch(/^MUTATING:/);
  });

  it("wraps structured requeue, retake, reap, and unblock-sweep cores", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await tools
      .find((tool) => tool.name === "requeue")!
      .invoke({ issue: 2306, guidance: "Retry after fixing the gate." });
    expect(d.requeue).toHaveBeenCalledWith({
      issue: 2306,
      guidance: "Retry after fixing the gate.",
    });

    await tools
      .find((tool) => tool.name === "retake")!
      .invoke({ issue: 2306 });
    expect(d.retake).toHaveBeenCalledWith({ issue: 2306 });
    await tools.find((tool) => tool.name === "reap")!.invoke({});
    expect(d.reap).toHaveBeenCalledOnce();
    await tools.find((tool) => tool.name === "unblock_sweep")!.invoke({});
    expect(d.unblockSweep).toHaveBeenCalledOnce();
  });
});
