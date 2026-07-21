import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCastleLaneRecord,
  castleLanePath,
  createEnginePaths,
  fleetRegistryPath,
  upsertFleetProfile,
} from "@reddb-io/red-castle/engine";
import {
  buildMcpLandingFireHook,
  createDefaultDevAfkMcpOperations,
  createDevAfkMcpDependencies,
  resolveDevCliBundle,
  type DevAfkMcpOperations,
} from "../src/mcp-adapter.js";
import type { HookExec } from "../src/core/hook-dispatcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "dev-afk-mcp-"));
  roots.push(value);
  return value;
}

describe("dev:afk MCP host adapter", () => {
  it("resolves the sibling dev CLI bundle from local and cached MCP assets", () => {
    expect(
      resolveDevCliBundle(join("dist", "afk-mcp.bundle.min.mjs")),
    ).toBe(join("dist", "dev.bundle.min.mjs"));
    expect(
      resolveDevCliBundle(
        join("cache", "afk-mcp-2.76.1.bundle.min.mjs"),
      ),
    ).toBe(join("cache", "dev-2.76.1.bundle.min.mjs"));
  });

  it("lists registered fleets through the Castle registry primitive", async () => {
    const cwd = await root();
    const paths = createEnginePaths(join(cwd, ".red"));
    await upsertFleetProfile(fleetRegistryPath(paths), {
      name: "codex",
      runner: "codex",
      selector: { spec: 2303 },
    });

    await expect(createDevAfkMcpDependencies(cwd).fleetList()).resolves.toEqual(
      [
        {
          name: "codex",
          runner: "codex",
          selector: { spec: 2303 },
        },
      ],
    );
  });

  it("returns raw CastleLaneRecord entries and rejects lane-root escapes", async () => {
    const cwd = await root();
    const paths = createEnginePaths(join(cwd, ".red"));
    await appendCastleLaneRecord(castleLanePath(paths, "worker", "worker-1"), {
      at: "2026-07-21T00:00:00.000Z",
      kind: "worker.started",
      issue: 2305,
      payload: { runner: "codex" },
    });
    const deps = createDevAfkMcpDependencies(cwd);

    await expect(
      deps.logs({ lane: "worker", id: "worker-1" }),
    ).resolves.toEqual([
      {
        at: "2026-07-21T00:00:00.000Z",
        kind: "worker.started",
        issue: 2305,
        payload: { runner: "codex" },
      },
    ]);
    await expect(
      deps.logs({ lane: "worker", id: "../../outside" }),
    ).rejects.toThrow("escapes its Castle lane root");
  });

  it("bounds logs reads by limit and filters by kind before the limit", async () => {
    const cwd = await root();
    const paths = createEnginePaths(join(cwd, ".red"));
    const lanePath = castleLanePath(paths, "worker", "worker-2");

    // Write 6 records alternating heartbeat / completed so we have a lane
    // larger than the limit used in assertions below.
    for (let i = 0; i < 6; i++) {
      await appendCastleLaneRecord(lanePath, {
        at: `2026-07-21T00:00:0${i}.000Z`,
        kind: i % 2 === 0 ? "worker.heartbeat" : "worker.completed",
      });
    }

    const deps = createDevAfkMcpDependencies(cwd);

    // limit=2 returns the NEWEST 2 records
    await expect(
      deps.logs({ lane: "worker", id: "worker-2", limit: 2 }),
    ).resolves.toEqual([
      { at: "2026-07-21T00:00:04.000Z", kind: "worker.heartbeat" },
      { at: "2026-07-21T00:00:05.000Z", kind: "worker.completed" },
    ]);

    // kind filter applied before limit: 3 heartbeats (indices 0, 2, 4)
    const heartbeats = await deps.logs({
      lane: "worker",
      id: "worker-2",
      kind: "worker.heartbeat",
    }) as unknown[];
    expect(heartbeats).toHaveLength(3);

    // kind + limit: newest 1 heartbeat
    await expect(
      deps.logs({ lane: "worker", id: "worker-2", kind: "worker.heartbeat", limit: 1 }),
    ).resolves.toEqual([
      { at: "2026-07-21T00:00:04.000Z", kind: "worker.heartbeat" },
    ]);
  });

  it("routes issue and demand dispatches through their value operations", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createDevAfkMcpDependencies(cwd, operations);

    await expect(
      deps.workerDispatch({ issue: 2306, runner: "codex" }),
    ).resolves.toEqual({ kind: "afk", exit_code: 0 });
    expect(operations.dispatchIssue).toHaveBeenCalledWith(cwd, {
      issue: 2306,
      runner: "codex",
    });

    await expect(
      deps.workerDispatch({
        demand: "repair the release gate",
        runner: "claude",
        mode: "no-mistakes",
      }),
    ).resolves.toEqual({ kind: "go", exit_code: 0 });
    expect(operations.dispatchDemand).toHaveBeenCalledWith(cwd, {
      demand: "repair the release gate",
      runner: "claude",
      mode: "no-mistakes",
    });
  });

  it("detaches MCP dispatches without writing progress to stdout", async () => {
    const cwd = await root();
    const launchRun = vi.fn(async (_cwd: string, _args: string[]) => ({ pid: 73 }));
    const createIssue = vi.fn(async (_title: string, _opts: { labels: string[]; body: string }) => 2308);
    const ensureLabel = vi.fn(async () => undefined);
    const stdout = vi.spyOn(process.stdout, "write");
    const operations = createDefaultDevAfkMcpOperations(cwd, {
      launchRun,
      createIssue,
      ensureLabel,
    });

    try {
      await expect(
        operations.dispatchIssue(cwd, { issue: 2306, runner: "codex" }),
      ).resolves.toMatchObject({
        kind: "afk",
        issue: 2306,
        worker_pid: 73,
        status: "dispatched",
      });
      await expect(
        operations.dispatchDemand(cwd, {
          demand: "--repair release",
          runner: "codex",
          mode: "direct-PR",
        }),
      ).resolves.toMatchObject({
        kind: "go",
        demand: "--repair release",
        issue: 2308,
        worker_pid: 73,
        status: "dispatched",
      });
    } finally {
      stdout.mockRestore();
    }

    expect(launchRun).toHaveBeenNthCalledWith(
      1,
      cwd,
      ["--issues", "2306", "--once", "--runner", "codex"],
    );
    expect(createIssue.mock.calls[0]?.[1]).toMatchObject({
      labels: ["lane:go"],
    });
    expect(createIssue.mock.calls[0]?.[1].body).toContain("--repair release");
    expect(launchRun.mock.calls[1]?.[1]).not.toContain("--repair release");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("injects worker_request only into a newly dispatched worker", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createDevAfkMcpDependencies(cwd, operations);

    await deps.workerRequest({
      issue: 2306,
      runner: "codex",
      text: "Run the focused package gate.",
    });

    expect(operations.dispatchIssue).toHaveBeenCalledWith(cwd, {
      issue: 2306,
      runner: "codex",
      request: "Run the focused package gate.",
    });
  });

  it("stops and recycles workers through the shared stop operation", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createDevAfkMcpDependencies(cwd, operations);

    await expect(
      deps.workerStop({ worker: "wVM2Z", recycle: false }),
    ).resolves.toMatchObject({ worker: "wVM2Z", worker_status: "stopped" });
    await deps.workerStop({ worker: "wVM2Z", recycle: true });
    expect(operations.stopWorker).toHaveBeenNthCalledWith(1, cwd, {
      worker: "wVM2Z",
      recycle: false,
    });
    expect(operations.stopWorker).toHaveBeenNthCalledWith(2, cwd, {
      worker: "wVM2Z",
      recycle: true,
    });
  });

  it("returns runner specs and deterministic explicit detection", async () => {
    const cwd = await root();
    const deps = createDevAfkMcpDependencies(cwd, fakeOperations());

    await expect(deps.runnerList()).resolves.toMatchObject({
      codex: { channel: "effort", factory: "codex" },
      claude: { channel: "effort", factory: "claudeCode" },
    });
    await expect(deps.runnerDetect({ runner: "codex" })).resolves.toEqual({
      runner: "codex",
      method: "flag",
      detail: "--runner",
    });
  });

  it("returns structured hygiene operation results", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createDevAfkMcpDependencies(cwd, operations);

    await expect(
      deps.requeue({ issue: 2306, guidance: "Retry after repair." }),
    ).resolves.toEqual({ issue: 2306, applied: true });
    await expect(deps.retake({ issue: 2306 })).resolves.toEqual({
      issue: { number: 2306 },
    });
    await expect(deps.reap()).resolves.toEqual({
      remote_reaped: ["afk/wOLD/1-old"],
      local_reaped: [],
    });
    await expect(deps.unblockSweep()).resolves.toEqual({ promoted: [2307] });
  });

  it("routes the sensitive gate, landing, and claim tools through their operations", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createDevAfkMcpDependencies(cwd, operations);

    await expect(
      deps.gateRun({ branch: "afk/w80UR/2307-castle-mcp-s4" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      deps.landBranch({ issue: 2307, branch: "afk/w80UR/2307-castle-mcp-s4" }),
    ).resolves.toMatchObject({ issue: 2307, ok: true });
    await expect(deps.gateBaselineStatus({})).resolves.toEqual({
      main_red: false,
    });
    await expect(deps.cascadeStatus({ issue: 2307 })).resolves.toMatchObject({
      issue: 2307,
    });
    await expect(deps.claimStatus({ issue: 2307 })).resolves.toMatchObject({
      issue: 2307,
    });
    await expect(deps.claimRelease({ issue: 2307 })).resolves.toMatchObject({
      issue: 2307,
    });
    expect(operations.gateRun).toHaveBeenCalledWith({
      branch: "afk/w80UR/2307-castle-mcp-s4",
    });
    expect(operations.landBranch).toHaveBeenCalledWith({
      issue: 2307,
      branch: "afk/w80UR/2307-castle-mcp-s4",
    });
  });

  it("enumerates the disposable worktree lanes and refuses escapes on removal", async () => {
    const cwd = await root();
    await mkdir(join(cwd, ".red", "tmp", "worktrees", "landing", "main-2307"), {
      recursive: true,
    });
    await mkdir(join(cwd, ".red", "tmp", "worktrees", "feedback", "afk-2307"), {
      recursive: true,
    });
    const deps = createDevAfkMcpDependencies(cwd, fakeOperations());

    await expect(deps.worktreeList()).resolves.toEqual([
      {
        lane: "feedback",
        name: "afk-2307",
        path: join(".red", "tmp", "worktrees", "feedback", "afk-2307"),
      },
      {
        lane: "landing",
        name: "main-2307",
        path: join(".red", "tmp", "worktrees", "landing", "main-2307"),
      },
    ]);
    await expect(
      deps.worktreeRemove({ path: join("..", "elsewhere") }),
    ).rejects.toThrow(/escapes/);
  });
});

describe("buildMcpLandingFireHook — lifecycle hook wiring", () => {
  async function writeHookConfig(cwd: string, hookYaml: string): Promise<void> {
    await mkdir(join(cwd, ".red"), { recursive: true });
    await writeFile(
      join(cwd, ".red", "config.yaml"),
      `plugins:\n  dev:\n    enabled: "true"\nafk:\n  hooks:\n${hookYaml}`,
      "utf8",
    );
  }

  it("invokes configured pre_merge hook commands via the injected exec", async () => {
    const cwd = await root();
    const fired: Array<{ command: string; code: number }> = [];
    const exec: HookExec = async (command) => {
      fired.push({ command, code: 0 });
      return { code: 0, stdout: "" };
    };

    await writeHookConfig(cwd, "    pre_merge: probe-pre\n");

    const fireHook = buildMcpLandingFireHook(cwd, exec);
    const ok = await fireHook("pre_merge", "{}");

    expect(ok).toBe(true);
    expect(fired).toEqual([{ command: "probe-pre", code: 0 }]);
  });

  it("returns false and aborts when a pre_merge hook exits non-zero", async () => {
    const cwd = await root();
    const exec: HookExec = async () => ({ code: 1, stdout: "" });

    await writeHookConfig(cwd, "    pre_merge: veto-hook\n");

    const fireHook = buildMcpLandingFireHook(cwd, exec);
    const ok = await fireHook("pre_merge", "{}");

    expect(ok).toBe(false);
  });

  it("returns true for post_merge even when the hook exits non-zero (continue policy)", async () => {
    const cwd = await root();
    const exec: HookExec = async () => ({ code: 99, stdout: "" });

    await writeHookConfig(cwd, "    post_merge: noisy-hook\n");

    const fireHook = buildMcpLandingFireHook(cwd, exec);
    const ok = await fireHook("post_merge", "{}");

    expect(ok).toBe(true);
  });

  it("returns true and fires no exec when no hooks are configured", async () => {
    const cwd = await root();
    const fired: string[] = [];
    const exec: HookExec = async (command) => {
      fired.push(command);
      return { code: 0, stdout: "" };
    };

    const fireHook = buildMcpLandingFireHook(cwd, exec);
    const ok = await fireHook("pre_merge", "{}");

    expect(ok).toBe(true);
    expect(fired).toHaveLength(0);
  });
});

function fakeOperations(): DevAfkMcpOperations {
  return {
    dispatchIssue: vi.fn(async () => ({ kind: "afk" as const, exit_code: 0 })),
    dispatchDemand: vi.fn(async () => ({ kind: "go" as const, exit_code: 0 })),
    stopWorker: vi.fn(async (_root, input) => ({
      worker: input.worker,
      worker_pid: 42,
      worker_status: "stopped",
      recycle: input.recycle,
    })),
    requeue: vi.fn(async (input) => ({ issue: input.issue, applied: true })),
    retake: vi.fn(async (input) => ({ issue: { number: input.issue } })),
    reap: vi.fn(async () => ({
      remote_reaped: ["afk/wOLD/1-old"],
      local_reaped: [],
    })),
    unblockSweep: vi.fn(async () => ({ promoted: [2307] })),
    gateRun: vi.fn(async (input) => ({ branch: input.branch, ok: true })),
    gateBaselineStatus: vi.fn(async () => ({ main_red: false })),
    landBranch: vi.fn(async (input) => ({ issue: input.issue, ok: true })),
    cascadeStatus: vi.fn(async (input) => ({
      issue: input.issue,
      promotable: [],
    })),
    claimStatus: vi.fn(async (input) => ({ issue: input.issue, holders: [] })),
    claimRelease: vi.fn(async (input) => ({ issue: input.issue, conceded: [] })),
  };
}
