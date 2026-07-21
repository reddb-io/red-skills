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
    gateRun: vi.fn(async (input) => ({
      branch: input.branch,
      base: input.base ?? "main",
      ok: true,
      checks: [{ name: "test:apps/dev", status: "passed" }],
    })),
    gateBaselineStatus: vi.fn(async () => ({
      main_red: false,
      repair_issue: null,
      failures: [],
    })),
    landBranch: vi.fn(async (input) => ({
      ok: true,
      issue: input.issue,
      branch: input.branch,
      locked: false,
    })),
    cascadeStatus: vi.fn(async () => ({ trunk: "main", branches: [] })),
    claimStatus: vi.fn(async (input) => ({
      issue: input.issue,
      live_owner: "host:wABCD",
      stale_owners: [],
      conceded_owners: [],
      records: [{ comment_id: 1, worker: "host:wABCD", kind: "claim" }],
    })),
    claimRelease: vi.fn(async (input) => ({
      issue: input.issue,
      worker: input.worker,
      status: "conceded",
    })),
    worktreeList: vi.fn(async () => ({ lanes: [], worktrees: [] })),
    worktreeRemove: vi.fn(async (input) => ({
      path: input.path,
      status: "removed",
    })),
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

  it("marks every landing/claim/worktree tool that mutates", () => {
    const tools = createCastleMcpTools(deps());
    const mutating = tools
      .filter((tool) => tool.description.startsWith("MUTATING:"))
      .map((tool) => tool.name);
    expect(mutating).toEqual(
      expect.arrayContaining([
        "land_branch",
        "claim_release",
        "worktree_remove",
      ]),
    );
    expect(mutating).not.toContain("gate_baseline_status");
    expect(mutating).not.toContain("claim_status");
    expect(mutating).not.toContain("worktree_list");
    expect(mutating).not.toContain("cascade_status");
  });

  it("runs the gate for a branch and lands it through doLanding", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);
    await expect(
      tools
        .find((tool) => tool.name === "gate_run")!
        .invoke({ branch: "afk/wABCD/2307-slice", base: "main" }),
    ).resolves.toMatchObject({ ok: true, base: "main" });
    expect(d.gateRun).toHaveBeenCalledWith({
      branch: "afk/wABCD/2307-slice",
      base: "main",
    });

    await expect(
      tools
        .find((tool) => tool.name === "land_branch")!
        .invoke({ issue: 2307, branch: "afk/wABCD/2307-slice" }),
    ).resolves.toMatchObject({ ok: true, issue: 2307 });
  });

  it("reads claim records and enumerates the worktree lanes", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);
    await expect(
      tools.find((tool) => tool.name === "claim_status")!.invoke({ issue: 2307 }),
    ).resolves.toMatchObject({
      live_owner: "host:wABCD",
      records: [{ worker: "host:wABCD", kind: "claim" }],
    });

    await expect(
      tools.find((tool) => tool.name === "worktree_list")!.invoke({}),
    ).resolves.toEqual({ lanes: [], worktrees: [] });
    expect(d.worktreeList).toHaveBeenCalled();
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
});
