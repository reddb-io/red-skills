import { describe, expect, it, vi } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "./mcp-server.js";

function deps(): CastleMcpDependencies {
  return {
    projectStatus: vi.fn(async () => ({
      registration: {
        held: true,
        daemon_reachable: true,
        project: "red-skills",
        socket: "/run/redskilled.sock",
        selector: "{}",
        target: 2,
        renewal: "renewing" as const,
        renew_by: "2026-07-31T05:30:00.000Z",
        renewals: 3,
        lapsed_at: "",
        reason: "",
        launch_revision: 0,
      },
      slots: { busy: 1, free: 1, parked: 0, total: 2 },
      live_workers: [
        {
          id: "worker-1",
          pid: 43,
          issue: "2305",
          activity: "impl",
          origin: "afk",
        },
      ],
      unattributed_workers: [],
    })),
    projectStart: vi.fn(async (input) => ({
      status: "launched",
      runner: input.runner,
      pid: 42,
    })),
    projectResize: vi.fn(async (input) => ({ status: "resized", target: input.target })),
    projectStop: vi.fn(async (input) => ({
      status: "stopped",
      force: input.force ?? false,
    })),
    hostState: vi.fn(async () => ({ pid: 42, workers: [] })),
    hostDashboard: vi.fn(async () => ({ version: 1, mode: "global", rows: [] })),
    hostProvisionCheck: vi.fn(async () => ({ verdict: "ok", rows: [], findings: [] })),
    hostUnitStatus: vi.fn(async () => ({
      installed: false,
      enabled: false,
      active: false,
      floor: "auto-spawn",
    })),
    logs: vi.fn(async () => [
      { at: "2026-07-21T00:00:00.000Z", kind: "worker.started" },
    ]),
    workerVitals: vi.fn(async (_input) => []),
    dashboard: vi.fn(async () => ({ schema_version: "red.dev.dashboard.v1" })),
    monitor: vi.fn(async () => ({ workers: [], events: [], fleet: null })),
    history: vi.fn(async () => []),
    queueStatus: vi.fn(async () => ({
      ready_for_agent: [],
      ready_for_human: [],
      counts: { ready_for_agent: 0, ready_for_human: 0 },
    })),
    deadendAudit: vi.fn(async () => ({ total: 0, classes: [] })),
    eventsSince: vi.fn(async (input) => {
      if (input.cursor === undefined) {
        return { events: [], history: [], lane_records: [], cursor: "eyJ2IjoxLCJhdCI6IjIwMjYtMDctMjJUMDA6MDA6MDAuMDAwWiJ9" };
      }
      return { refused: true, reason: "Unknown cursor format; call queue_status or worker_status to re-baseline." };
    }),
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
    steerStatus: vi.fn(async (input) => ({
      worker: input.worker,
      status: "none",
    })),
    workerRequest: vi.fn(async (input) => ({
      status: "completed",
      request: input.text,
    })),
    requeue: vi.fn(async (input) => ({ issue: input.issue, applied: true })),
    retake: vi.fn(async (input) => ({ issue: { number: input.issue } })),
    reap: vi.fn(async () => ({ remote: [], local: [] })),
    unblockSweep: vi.fn(async () => ({ promoted: [] })),
    gateRun: vi.fn(async (input) => ({ branch: input.branch, ok: true, checks: [] })),
    landBranch: vi.fn(async (input) => ({
      issue: input.issue,
      branch: input.branch,
      ok: true,
    })),
    cascadeStatus: vi.fn(async (input) => ({
      issue: input.issue,
      dependents: [],
      promotable: [],
    })),
    claimStatus: vi.fn(async (input) => ({
      issue: input.issue,
      records: [],
      holder: null,
    })),
    mergeArm: vi.fn(async (input) => ({ armed: input })),
    mergeStatus: vi.fn(async () => ({ prs: [] })),
    mergeRelease: vi.fn(async (input) => ({ released: input })),
    hitlResolve: vi.fn(async (input) => ({ resolved: input })),
    claimRelease: vi.fn(async (input) => ({
      issue: input.issue,
      conceded: ["w80UR"],
    })),
    worktreeList: vi.fn(async () => [
      { lane: "landing", name: "main-adopt-2307", path: ".red/tmp/worktrees/landing/main-adopt-2307" },
    ]),
    worktreeRemove: vi.fn(async (input) => ({ path: input.path, removed: true })),
    waitStart: vi.fn(async () => ({ id: "a1b2c3d4-uuid", pid: 42, status: "spawned" })),
    waitList: vi.fn(async () => []),
    waitStatus: vi.fn(async () => ({
      id: "a1b2c3d4-uuid",
      status: "finished",
      result: { schema: "rsp.wait.result", version: 1 },
    })),
    dailyReview: vi.fn(async () => ({ kind: "daily" })),
    weeklyReview: vi.fn(async () => ({ kind: "weekly" })),
    triage: vi.fn(async (input) => ({ issue: input.issue, action: "apply" })),
    respond: vi.fn(async () => ({ action: "ignored" })),
    statuslineAggregate: vi.fn(async () => ({
      project: { basename: "red-skills", branch: "main", version: "2.78.0", docs_unlanded: 0 },
      repo: { open_prs: 3, today_prs: 1, open_issues: 24, cache_age_s: null },
      fleet: null,
      workers: [],
      queue: { ready_for_agent: 2, ready_for_human: 1, cache_age_s: null },
    })),
  };
}

describe("castle MCP tools", () => {
  it("publishes the Fleet and Observability domains", () => {
    expect(createCastleMcpTools(deps()).map((tool) => tool.name)).toEqual([
      "project_status",
      "project_start",
      "project_resize",
      "project_stop",
      "host_state",
      "host_dashboard",
      "host_provision_check",
      "host_unit_status",
      "logs",
      "worker_vitals",
      "dashboard",
      "monitor",
      "history",
      "queue_status",
      "events_since",
      "deadend_audit",
      "worker_dispatch",
      "worker_status",
      "worker_stop",
      "worker_recycle",
      "runner_list",
      "runner_detect",
      "runner_steer",
      "steer_status",
      "worker_request",
      "requeue",
      "retake",
      "reap",
      "unblock_sweep",
      "gate_run",
      "land_branch",
      "cascade_status",
      "claim_status",
      "claim_release",
      "merge_arm",
      "merge_status",
      "merge_release",
      "hitl_resolve",
      "worktree_list",
      "worktree_remove",
      "wait_start",
      "wait_list",
      "wait_status",
      "daily_review",
      "weekly_review",
      "triage",
      "respond",
      "statusline_aggregate",
    ]);
  });

  it("returns structured project status without rendering command output", async () => {
    const tools = createCastleMcpTools(deps());
    const status = tools.find((tool) => tool.name === "project_status")!;
    await expect(status.invoke({})).resolves.toMatchObject({
      registration: { held: true, renewal: "renewing", target: 2 },
      slots: { total: 2 },
      live_workers: [{ id: "worker-1" }],
    });
  });

  it("returns the daemon's read-only host diagnostics", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(tools.find((tool) => tool.name === "host_state")!.invoke({})).resolves.toEqual({
      pid: 42,
      workers: [],
    });
    await expect(tools.find((tool) => tool.name === "host_dashboard")!.invoke({})).resolves.toMatchObject({
      version: 1,
      mode: "global",
    });
    await expect(tools.find((tool) => tool.name === "host_provision_check")!.invoke({})).resolves.toMatchObject({
      verdict: "ok",
    });
    await expect(tools.find((tool) => tool.name === "host_unit_status")!.invoke({})).resolves.toMatchObject({
      floor: "auto-spawn",
    });
  });

  it("starts the project's workers and returns raw Castle lane records", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);
    await tools
      .find((tool) => tool.name === "project_start")!
      .invoke({
        runner: "codex",
        target: 2,
      });
    expect(d.projectStart).toHaveBeenCalledWith(
      expect.objectContaining({ runner: "codex", target: 2 }),
    );

    await expect(
      tools
        .find((tool) => tool.name === "logs")!
        .invoke({ lane: "worker", id: "worker-1" }),
    ).resolves.toEqual([
      { at: "2026-07-21T00:00:00.000Z", kind: "worker.started" },
    ]);
  });

  it("forwards explicit force on project_stop hard teardown (#2472)", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await tools
      .find((tool) => tool.name === "project_stop")!
      .invoke({ force: true });

    expect(d.projectStop).toHaveBeenCalledWith({ force: true });
  });

  it("refuses an invocation that still names a fleet, naming the replacement", async () => {
    const tools = createCastleMcpTools(deps());

    for (const name of ["project_status", "project_stop"]) {
      await expect(
        tools.find((tool) => tool.name === name)!.invoke({ fleet: "codex" }),
      ).rejects.toThrow(/named fleets were removed[\s\S]*project_start/);
    }
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

  it("reads steer status for a worker via steer_status", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools
        .find((tool) => tool.name === "steer_status")!
        .invoke({ worker: "wVM2Z" }),
    ).resolves.toMatchObject({ worker: "wVM2Z", status: "none" });
    expect(d.steerStatus).toHaveBeenCalledWith({ worker: "wVM2Z" });
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

  it("runs the gate and reports the baseline through the Gate domain", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools
        .find((tool) => tool.name === "gate_run")!
        .invoke({ branch: "afk/w80UR/2307-castle-mcp-s4" }),
    ).resolves.toMatchObject({ ok: true });
    expect(d.gateRun).toHaveBeenCalledWith({
      branch: "afk/w80UR/2307-castle-mcp-s4",
    });
  });

  it("lands a validated branch and reports the close cascade", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await tools
      .find((tool) => tool.name === "land_branch")!
      .invoke({ issue: 2307, branch: "afk/w80UR/2307-castle-mcp-s4" });
    expect(d.landBranch).toHaveBeenCalledWith({
      issue: 2307,
      branch: "afk/w80UR/2307-castle-mcp-s4",
    });

    await tools
      .find((tool) => tool.name === "cascade_status")!
      .invoke({ issue: 2307 });
    expect(d.cascadeStatus).toHaveBeenCalledWith({ issue: 2307 });
    expect(
      tools.find((tool) => tool.name === "land_branch")!.description,
    ).toMatch(/^MUTATING:/);
  });

  it("reads and releases claim records through the Claim domain", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools.find((tool) => tool.name === "claim_status")!.invoke({ issue: 2307 }),
    ).resolves.toMatchObject({ issue: 2307, holder: null });
    await tools
      .find((tool) => tool.name === "claim_release")!
      .invoke({ issue: 2307 });
    expect(d.claimRelease).toHaveBeenCalledWith({ issue: 2307 });
    expect(
      tools.find((tool) => tool.name === "claim_release")!.description,
    ).toMatch(/^MUTATING:/);
  });

  it("starts, lists, and reads wait status through the Wait domain", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools.find((tool) => tool.name === "wait_start")!.invoke({
        kind: "pr",
        target: "2364",
        reason: "CI check",
      }),
    ).resolves.toMatchObject({ id: "a1b2c3d4-uuid", pid: 42, status: "spawned" });
    expect(d.waitStart).toHaveBeenCalledWith({
      kind: "pr",
      target: "2364",
      reason: "CI check",
    });

    await expect(
      tools.find((tool) => tool.name === "wait_list")!.invoke({}),
    ).resolves.toEqual([]);

    await expect(
      tools.find((tool) => tool.name === "wait_status")!.invoke({ id: "a1b2c3d4-uuid" }),
    ).resolves.toMatchObject({ status: "finished", result: { schema: "rsp.wait.result" } });
    expect(d.waitStatus).toHaveBeenCalledWith({ id: "a1b2c3d4-uuid" });

    expect(
      tools.find((tool) => tool.name === "wait_start")!.description,
    ).toMatch(/^MUTATING:/);
  });

  it("reads the statusline aggregate through the Statusline domain", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools.find((tool) => tool.name === "statusline_aggregate")!.invoke({}),
    ).resolves.toMatchObject({
      project: { basename: "red-skills", branch: "main" },
      repo: { open_issues: 24 },
      queue: { ready_for_agent: 2, ready_for_human: 1 },
    });
    expect(d.statuslineAggregate).toHaveBeenCalledOnce();
  });

  it("passes live_only and fields through to the worker_vitals dep", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await tools.find((tool) => tool.name === "worker_vitals")!.invoke({});
    expect(d.workerVitals).toHaveBeenCalledWith(
      expect.objectContaining({ live_only: true }),
    );

    await tools
      .find((tool) => tool.name === "worker_vitals")!
      .invoke({ live_only: false, fields: ["worker", "live"] });
    expect(d.workerVitals).toHaveBeenLastCalledWith({
      live_only: false,
      fields: ["worker", "live"],
    });
  });

  it("passes live_only and fields through to the worker_status dep", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await tools.find((tool) => tool.name === "worker_status")!.invoke({});
    expect(d.workerStatus).toHaveBeenCalledWith(
      expect.objectContaining({ live_only: true }),
    );

    await tools
      .find((tool) => tool.name === "worker_status")!
      .invoke({ worker: "wVM2Z", live_only: false, fields: ["worker"] });
    expect(d.workerStatus).toHaveBeenLastCalledWith({
      worker: "wVM2Z",
      live_only: false,
      fields: ["worker"],
    });
  });

  it("returns a terse refusal when worker_dispatch receives both issue and demand", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools
        .find((tool) => tool.name === "worker_dispatch")!
        .invoke({ issue: 2306, demand: "fix the gate" }),
    ).resolves.toMatchObject({
      refused: true,
      reason: expect.stringContaining("exactly one"),
    });
    expect(d.workerDispatch).not.toHaveBeenCalled();
  });

  it("returns a terse refusal when worker_request receives both issue and demand", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools
        .find((tool) => tool.name === "worker_request")!
        .invoke({ issue: 2306, demand: "fix the gate", text: "Use TDD." }),
    ).resolves.toMatchObject({
      refused: true,
      reason: expect.stringContaining("exactly one"),
    });
    expect(d.workerRequest).not.toHaveBeenCalled();
  });

  it("returns a baseline cursor when events_since is called without a cursor", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    const result = await tools.find((tool) => tool.name === "events_since")!.invoke({});
    expect(result).toMatchObject({ cursor: expect.any(String) });
    expect(d.eventsSince).toHaveBeenCalledWith({ cursor: undefined });
  });

  it("returns a terse refusal for an unknown cursor", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools.find((tool) => tool.name === "events_since")!.invoke({ cursor: "not-a-valid-cursor" }),
    ).resolves.toMatchObject({ refused: true, reason: expect.stringContaining("re-baseline") });
    expect(
      tools.find((tool) => tool.name === "events_since")!.description,
    ).not.toMatch(/^MUTATING:/);
  });

  it("enumerates and removes disposable worktrees", async () => {
    const d = deps();
    const tools = createCastleMcpTools(d);

    await expect(
      tools.find((tool) => tool.name === "worktree_list")!.invoke({}),
    ).resolves.toMatchObject([{ lane: "landing" }]);
    await tools
      .find((tool) => tool.name === "worktree_remove")!
      .invoke({ path: ".red/tmp/worktrees/landing/main-adopt-2307" });
    expect(d.worktreeRemove).toHaveBeenCalledWith({
      path: ".red/tmp/worktrees/landing/main-adopt-2307",
    });
    for (const name of ["gate_run", "worktree_remove"]) {
      expect(tools.find((tool) => tool.name === name)!.description).toMatch(
        /^MUTATING:/,
      );
    }
  });
});
