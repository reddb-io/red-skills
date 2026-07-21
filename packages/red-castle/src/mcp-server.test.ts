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
    gateRun: vi.fn(async () => ({ ok: true, checks: [] })),
    gateBaselineStatus: vi.fn(async () => ({ red: false, issue: null })),
    landBranch: vi.fn(async () => ({ ok: true, mergeSha: "abc123" })),
    cascadeStatus: vi.fn(async () => []),
    claimStatus: vi.fn(async () => [
      { worker: "host:worker-1", kind: "claim" },
    ]),
    claimRelease: vi.fn(async () => ({ released: true })),
    worktreeList: vi.fn(async () => [{ lane: "landing", name: "main-0" }]),
    worktreeRemove: vi.fn(async () => ({ removed: true })),
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
      "gate_run",
      "gate_baseline_status",
      "land_branch",
      "cascade_status",
      "claim_status",
      "claim_release",
      "worktree_list",
      "worktree_remove",
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

  it("returns the feedback verdict and gates landing on an acknowledged pass", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools
        .find((tool) => tool.name === "gate_run")!
        .invoke({
          branch: "afk/wAAAA/2307-sensitive-tools",
          base: "main",
        }),
    ).resolves.toMatchObject({ ok: true });
    expect(d.gateRun).toHaveBeenCalledWith({
      branch: "afk/wAAAA/2307-sensitive-tools",
      base: "main",
    });

    await tools
      .find((tool) => tool.name === "land_branch")!
      .invoke({
        issue: 2307,
        title: "Sensitive tools",
        branch: "afk/wAAAA/2307-sensitive-tools",
        base: "main",
        gatePassed: true,
      });
    expect(d.landBranch).toHaveBeenCalledWith(
      expect.objectContaining({ issue: 2307, gatePassed: true }),
    );
  });

  it("publishes mutating claim and worktree operations with explicit warnings", () => {
    const tools = createCastleMcpTools(deps());
    for (const name of [
      "gate_run",
      "land_branch",
      "claim_release",
      "worktree_remove",
    ]) {
      expect(tools.find((tool) => tool.name === name)!.description).toMatch(
        /^MUTATING:/,
      );
    }
  });
});
