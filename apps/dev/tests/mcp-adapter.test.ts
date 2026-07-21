import { mkdtemp, rm } from "node:fs/promises";
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
  createDefaultDevAfkMcpOperations,
  createDevAfkMcpDependencies,
  resolveDevCliBundle,
  type DevAfkMcpOperations,
} from "../src/mcp-adapter.js";

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
    const launchRun = vi.fn(async () => ({ pid: 73 }));
    const createIssue = vi.fn(async () => 2308);
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
  };
}
