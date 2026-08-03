import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import type { JsonObject } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import { waitsDir } from "@reddb-io/shared/red-paths.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCastleLaneRecord,
  castleLanePath,
  createEnginePaths,
} from "@reddb-io/red-castle/engine";
import { afkPaths } from "../src/runtime/wire.js";
import { recordBootError } from "../src/commands/run/state.js";
import {
  buildMcpLandingFireHook,
  createDefaultDevAfkMcpOperations,
  createCastleMcpDependencies,
  dispatchLogPath,
  resolveRspCliBundle,
  type DevAfkMcpOperations,
} from "../src/mcp-adapter.js";
import type { DispatchedWorkerBirth } from "../src/runtime/mcp-worker-birth.js";
import { dispatchInput } from "../../../packages/red-castle/src/mcp/worker.js";
import type { HookExec } from "../src/core/hook-dispatcher.js";
import { readPidStartTime } from "../src/core/state.js";

// Every process this suite starts, RECORDED — never replaced. The project
// lifecycle's contract is that a refusal starts nothing, and a refusal that
// quietly launched a producer of its own would still read as a rejected promise.
// The call passes straight through to the real `spawn`, so the launches other
// cases in this file depend on keep behaving exactly as they did.
const spawned = vi.hoisted(() => [] as { command: string; args: readonly string[] }[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
      spawned.push({ command, args });
      return (actual.spawn as unknown as (
        command: string,
        args: readonly string[],
        options: SpawnOptions,
      ) => ReturnType<typeof actual.spawn>)(command, args, options);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  spawned.length = 0;
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "dev-castle-mcp-"));
  roots.push(value);
  return value;
}

/** A Worker the host granted, as the birth request reports it (#2976). */
function granted(pid: number): DispatchedWorkerBirth {
  return {
    worker_id: "wHOST",
    pid,
    log: join("/repo", ".red", "tmp", "logs", "2026-08-01", "dispatch-test.log"),
    warnings: [],
    admission: "within the host ceiling",
  };
}

describe("castle MCP host adapter", () => {
  // The sibling dev-bundle resolution a dispatch needs now lives on the
  // published-entry path (`resolveDevScriptPath`, covered by its own suite): the
  // adapter's copy existed only to hand a bundle to its own `spawn`, and since
  // #2976 the daemon is the one that runs it.

  // Three consecutive dispatches died silently leaving only `worker.pid` — the
  // spawn discarded stdout/stderr, so a boot death left zero evidence (#2385).
  it("parks worker boot output in the dated logs lane", () => {
    const path = dispatchLogPath("/repo", "2026-07-21T19:18:38.920Z-abc12345");
    expect(path).toBe(join("/repo", ".red", "tmp", "logs", "2026-07-21", "dispatch-2026-07-21T19-18-38-920Z-abc12345.log"));
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
    const deps = createCastleMcpDependencies(cwd);

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

  it("surfaces a session-error death in the worker lane and default worker vitals", async () => {
    const cwd = await root();
    const workerId = "wER01";
    const workerDir = join(cwd, ".red", "tmp", "workers", workerId);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await recordBootError(workerDir, "session-error", new Error("bundle coherence halted dispatch"));
    } finally {
      stderr.mockRestore();
    }

    const deps = createCastleMcpDependencies(cwd);
    await expect(deps.logs({ lane: "worker", id: workerId })).resolves.toEqual([
      expect.objectContaining({
        kind: "worker.session-error",
        worker_id: workerId,
        payload: expect.objectContaining({
          type: "session-error",
          message: "bundle coherence halted dispatch",
        }),
      }),
    ]);
    await expect(deps.workerVitals({ live_only: true })).resolves.toEqual([
      expect.objectContaining({
        worker: expect.objectContaining({ id: workerId }),
        alert: expect.objectContaining({
          type: "session-error",
          message: "bundle coherence halted dispatch",
        }),
      }),
    ]);
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

    const deps = createCastleMcpDependencies(cwd);

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
    const deps = createCastleMcpDependencies(cwd, operations);

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

  it("routes scout demand dispatches through the scout operation", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createCastleMcpDependencies(cwd, operations);

    await expect(
      deps.workerDispatch({
        demand: "investigate the scout dispatch flow",
        runner: "claude",
        mode: "scout",
      }),
    ).resolves.toEqual({ kind: "scout", exit_code: 0 });
    expect(operations.dispatchScout).toHaveBeenCalledWith(cwd, {
      demand: "investigate the scout dispatch flow",
      runner: "claude",
    });
    expect(operations.dispatchDemand).not.toHaveBeenCalled();
  });

  it("rejects scout combined with issue dispatches at input validation", () => {
    expect(() => dispatchInput({ issue: 2346, mode: "scout" })).toThrow(
      "scout is demand-only",
    );
  });

  it("dispatches through the host birth request without writing progress to stdout", async () => {
    const cwd = await root();
    const birthWorker = vi.fn(async (_cwd: string, _args: readonly string[]) => granted(73));
    const createIssue = vi.fn(async (_title: string, _opts: { labels: string[]; body: string }) => 2308);
    const ensureLabel = vi.fn(async () => undefined);
    const stdout = vi.spyOn(process.stdout, "write");
    const operations = createDefaultDevAfkMcpOperations(cwd, {
      birthWorker,
      createIssue,
      ensureLabel,
    });

    try {
      await expect(
        operations.dispatchIssue(cwd, { issue: 2306, runner: "codex" }),
      ).resolves.toMatchObject({
        kind: "afk",
        issue: 2306,
        worker_id: "wHOST",
        worker_pid: 73,
        // The host's verdict travels back: a dispatch nothing judged is the
        // defect #2976 closed, so the reply says which ceiling admitted it.
        admission: "within the host ceiling",
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
        worker_id: "wHOST",
        worker_pid: 73,
        status: "dispatched",
      });
    } finally {
      stdout.mockRestore();
    }

    expect(birthWorker).toHaveBeenNthCalledWith(
      1,
      cwd,
      ["--issues", "2306", "--once", "--runner", "codex"],
    );
    expect(createIssue.mock.calls[0]?.[1]).toMatchObject({
      labels: ["lane:go"],
    });
    expect(createIssue.mock.calls[0]?.[1].body).toContain("--repair release");
    const goArgs = birthWorker.mock.calls[1]?.[1] as string[];
    expect(goArgs).not.toContain("--repair release");
    expect(goArgs[goArgs.indexOf("--lane") + 1]).toBe("lane:go");
    expect(goArgs).not.toContain("ready-for-agent");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("closes the minted /go Ticket when the host refuses Worker birth (#3175)", async () => {
    const cwd = await root();
    const closeIssue = vi.fn(async () => undefined);
    const commentIssue = vi.fn(async () => undefined);
    const operations = createDefaultDevAfkMcpOperations(cwd, {
      birthWorker: async () => {
        throw new Error("host refused Worker birth");
      },
      createIssue: async () => 3175,
      ensureLabel: async () => undefined,
      closeIssue,
      commentIssue,
    });

    await expect(operations.dispatchDemand(cwd, { demand: "fix the lane" })).rejects.toThrow(
      "host refused Worker birth",
    );
    expect(commentIssue).toHaveBeenCalledOnce();
    expect(closeIssue).toHaveBeenCalledWith(cwd, 3175);
  });

  it("reports a refused dispatch rather than a pid, when the host does not answer", async () => {
    // Fail closed (ADR 0130 rule 6): the operator learns nothing was started and
    // which repair is theirs — the alternative is a `dispatched` that lied.
    const cwd = await root();
    const birthWorker = vi.fn(async () => {
      throw new Error("no Worker was started: the redskilled daemon did not answer on /run/rs.sock");
    });
    const operations = createDefaultDevAfkMcpOperations(cwd, { birthWorker });

    await expect(
      operations.dispatchIssue(cwd, { issue: 2306, runner: "codex" }),
    ).rejects.toThrow(/the redskilled daemon did not answer/);
  });

  it("pins scout dispatch argv/engine wiring: lane:scout label, origin/run-mode flags, no mutation", async () => {
    const cwd = await root();
    const birthWorker = vi.fn(async (_cwd: string, _args: readonly string[]) => granted(91));
    const createIssue = vi.fn(async (_root: string, _spec: { title: string; body: string; labels: string[] }) => 2346);
    const ensureLabel = vi.fn(async () => undefined);
    const stdout = vi.spyOn(process.stdout, "write");
    const operations = createDefaultDevAfkMcpOperations(cwd, {
      birthWorker,
      createIssue,
      ensureLabel,
    });

    try {
      await expect(
        operations.dispatchScout(cwd, {
          demand: "why does the scout lane exist?",
          runner: "claude",
        }),
      ).resolves.toMatchObject({
        kind: "scout",
        demand: "why does the scout lane exist?",
        issue: 2346,
        worker_pid: 91,
        status: "dispatched",
      });
    } finally {
      stdout.mockRestore();
    }

    expect(ensureLabel).toHaveBeenCalledWith(cwd, "lane:scout");
    expect(createIssue.mock.calls[0]?.[1]).toMatchObject({ labels: ["lane:scout"] });
    const engineArgs = birthWorker.mock.calls[0]?.[1] as string[];
    expect(engineArgs).toContain("--origin");
    expect(engineArgs[engineArgs.indexOf("--origin") + 1]).toBe("scout");
    expect(engineArgs).toContain("--run-mode");
    expect(engineArgs[engineArgs.indexOf("--run-mode") + 1]).toBe("scout");
    expect(engineArgs).toContain("--lane");
    expect(engineArgs[engineArgs.indexOf("--lane") + 1]).toBe("lane:scout");
    expect(engineArgs).toContain("--runner");
    expect(engineArgs[engineArgs.indexOf("--runner") + 1]).toBe("claude");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("injects worker_request only into a newly dispatched worker", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createCastleMcpDependencies(cwd, operations);

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
    const deps = createCastleMcpDependencies(cwd, operations);

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
    const deps = createCastleMcpDependencies(cwd, fakeOperations());

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
    const deps = createCastleMcpDependencies(cwd, operations);

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
    const deps = createCastleMcpDependencies(cwd, operations);

    await expect(
      deps.gateRun({ branch: "afk/w80UR/2307-castle-mcp-s4" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      deps.landBranch({ issue: 2307, branch: "afk/w80UR/2307-castle-mcp-s4" }),
    ).resolves.toMatchObject({ issue: 2307, ok: true });
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

  it("routes review and triage tools through their operations", async () => {
    const cwd = await root();
    const operations = fakeOperations();
    const deps = createCastleMcpDependencies(cwd, operations);

    await expect(deps.dailyReview({})).resolves.toMatchObject({
      kind: "daily",
    });
    await expect(deps.weeklyReview({})).resolves.toMatchObject({
      kind: "weekly",
    });
    await expect(
      deps.triage({ issue: 2333, decision: "ready-for-agent" }),
    ).resolves.toMatchObject({ issue: 2333 });
    await expect(
      deps.respond({ body: "/dev explain what is AFK?", number: 2333 }),
    ).resolves.toMatchObject({ action: "ignored" });

    expect(operations.dailyReview).toHaveBeenCalledWith({});
    expect(operations.weeklyReview).toHaveBeenCalledWith({});
    expect(operations.triage).toHaveBeenCalledWith({
      issue: 2333,
      decision: "ready-for-agent",
    });
    expect(operations.respond).toHaveBeenCalledWith({
      body: "/dev explain what is AFK?",
      number: 2333,
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
    const deps = createCastleMcpDependencies(cwd, fakeOperations());

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

// The host these cases speak to is the SANDBOX's, pinned by the suite's setup
// file (#2981): both assert what happens when no daemon answers, and resolved
// from the ambient environment that is an assertion about the developer's
// machine — on a host running a daemon the start reached it and was registered,
// so the refusal went red on untouched code.
describe("project lifecycle — a registration, never a process (#2909)", () => {
  // ADR 0130 Amendment 4: the record lives on the host, so both a duplicate
  // start and a re-aim are decided by the daemon. A pre-check of our own would be
  // a second opinion racing the one authority that can see the registration — and
  // a project-local pid file is not evidence the host holds anything.
  it("refuses to re-aim a project the host holds no registration for", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd);
    await mkdir(paths.supervisorRuntimeDir, { recursive: true });
    await writeFile(paths.supervisorPidPath, String(process.pid), "utf8");
    await writeFile(paths.supervisorPidStartPath, readPidStartTime(process.pid)!, "utf8");

    await expect(
      createCastleMcpDependencies(cwd).projectResize({ target: 3, runner: "codex" }),
    ).rejects.toThrow(/registration rather than a process/);

    // Asking the host is allowed to start the HOST (ADR 0130 rule 7, and the
    // sandbox pins that executable at a path that cannot run). What a re-aim may
    // never start is a producer of this project's own.
    expect(spawned.map((launch) => launch.command)).toEqual([process.env.REDSKILLED_BIN]);
  });

  it("refuses the start rather than falling back to a process of its own", async () => {
    // The daemon is down, so the start ends there: the refusal names the socket
    // and the fact that a project contributes a registration rather than a
    // process. What is never allowed is a process started locally to make up for
    // what the start could not do.
    const cwd = await root();

    await expect(
      createCastleMcpDependencies(cwd).projectStart({ runner: "claude", target: 1 }),
    ).rejects.toThrow(/registration rather than a process/);

    // Fail closed (ADR 0130 rule 6). The one launch this path may attempt is the
    // host daemon's own auto-start (rule 7), which the sandbox pins at a path
    // that cannot run — and nothing else was started to compensate.
    expect(spawned.map((launch) => launch.command)).toEqual([process.env.REDSKILLED_BIN]);
  });
});

describe("rsp wait MCP tools", () => {
  it("resolves the sibling rsp CLI bundle from local and cached MCP assets", () => {
    expect(
      resolveRspCliBundle(join("dist", "castle-mcp.bundle.min.mjs")),
    ).toBe(join("dist", "rsp.bundle.min.mjs"));
    expect(
      resolveRspCliBundle(
        join("cache", "castle-mcp-2.76.1.bundle.min.mjs"),
      ),
    ).toBe(join("cache", "rsp-2.76.1.bundle.min.mjs"));
  });

  it("spawns a detached rsp wait and returns its id without writing to stdout", async () => {
    const cwd = await root();
    const launchRspWait = vi.fn(async (_args: readonly string[], _cwd: string) => 73);
    const stdout = vi.spyOn(process.stdout, "write");
    const operations = createDefaultDevAfkMcpOperations(cwd, { launchRspWait });

    try {
      const result = await operations.waitStart({ kind: "pr", target: "2364", reason: "CI check" }) as Record<string, unknown>;
      expect(result).toMatchObject({ pid: 73, status: "spawned" });
      expect(typeof result.id).toBe("string");
    } finally {
      stdout.mockRestore();
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(launchRspWait.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["wait", "pr", "2364", "--reason", "CI check"]),
    );
  });

  it("passes kind-specific arguments for pr, run, release, and cmd targets", async () => {
    const cwd = await root();
    const launchRspWait = vi.fn(async (_args: readonly string[], _cwd: string) => 99);
    const operations = createDefaultDevAfkMcpOperations(cwd, { launchRspWait });

    await operations.waitStart({ kind: "run", target: "987654321" });
    expect(launchRspWait.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["wait", "run", "987654321"]),
    );

    await operations.waitStart({ kind: "release", target: "v2.*" });
    expect(launchRspWait.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["wait", "release", "--tag", "v2.*"]),
    );

    await operations.waitStart({ kind: "cmd", target: "pnpm build" });
    const cmdArgs = launchRspWait.mock.calls[2]?.[0] as string[] | undefined;
    expect(cmdArgs).toContain("--");
    expect(cmdArgs?.[cmdArgs.indexOf("--") + 1]).toBe("pnpm build");
  });

  it("lists active waits from the registry directory", async () => {
    const cwd = await root();
    const deps = createCastleMcpDependencies(cwd, fakeOperations());
    await expect(deps.waitList()).resolves.toEqual([]);
  });

  it("reads the sealed result envelope for a finished wait", async () => {
    const cwd = await root();
    const id = "a1b2c3d4-finished-wait";
    const envelope = {
      schema: "rsp.wait.result",
      version: 1,
      wait: { id: "rsp-internal-uuid", status: "success" },
    };
    const dir = waitsDir(cwd);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.toon`),
      encodeSnapshotToon(envelope as unknown as JsonObject) + "\n",
      "utf8",
    );

    const deps = createCastleMcpDependencies(cwd, fakeOperations());
    const result = await deps.waitStatus({ id }) as Record<string, unknown>;
    expect(result).toMatchObject({ id, status: "finished", result: { schema: "rsp.wait.result" } });
  });

  it("returns running status with active registry when result file is absent", async () => {
    const cwd = await root();
    const deps = createCastleMcpDependencies(cwd, fakeOperations());
    const result = await deps.waitStatus({ id: "no-such-wait" }) as Record<string, unknown>;
    expect(result).toMatchObject({ id: "no-such-wait", status: "running", waits: [] });
  });
});

describe("statusline_aggregate MCP tool", () => {
  it("returns the payload shape with project, repo, fleet, workers, and queue", async () => {
    const cwd = await root();
    const deps = createCastleMcpDependencies(cwd, fakeOperations());

    const result = await deps.statuslineAggregate() as Record<string, unknown>;

    const project = result.project as Record<string, unknown>;
    expect(typeof project.basename).toBe("string");
    expect(typeof project.version).toBe("string");
    expect(typeof project.docs_unlanded).toBe("number");
    expect(project.branch === null || typeof project.branch === "string").toBe(true);

    const repo = result.repo as Record<string, unknown>;
    expect(typeof repo.open_prs).toBe("number");
    expect(typeof repo.today_prs).toBe("number");
    expect(typeof repo.open_issues).toBe("number");
    expect(repo.cache_age_s === null || typeof repo.cache_age_s === "number").toBe(true);

    expect(Array.isArray(result.workers)).toBe(true);
    expect("fleet" in result).toBe(true);

    const queue = result.queue as Record<string, unknown>;
    expect(typeof queue.ready_for_agent).toBe("number");
    expect(typeof queue.ready_for_human).toBe("number");
    expect(queue.cache_age_s === null || typeof queue.cache_age_s === "number").toBe(true);
  });

  it("exposes model and effort on each worker record when present", async () => {
    const cwd = await root();
    const paths = createEnginePaths(join(cwd, ".red"));
    const attemptDir = join(paths.workersRoot, "wTST1", "2344");
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      join(attemptDir, "afk.state.toon"),
      JSON.stringify({
        version: 1,
        worker_id: "wTST1",
        pid: process.pid,
        runner: "claude",
        origin: "afk",
        started_at: new Date().toISOString(),
        current: {
          number: 2344,
          runner: "claude",
          model: "claude-opus-4-8",
          effort: "high",
          phase: "coding",
          activity: "editing",
          retries: 0,
          iteration: 1,
          loc_added: 10,
          loc_removed: 3,
        },
      }),
      "utf8",
    );

    const deps = createCastleMcpDependencies(cwd, fakeOperations());
    const result = await deps.statuslineAggregate() as { workers: Array<Record<string, unknown>> };

    expect(result.workers).toHaveLength(1);
    const worker = result.workers[0] as { worker: { current: Record<string, unknown> } };
    expect(worker.worker.current).toMatchObject({
      model: "claude-opus-4-8",
      effort: "high",
    });
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
    hitlResolve: vi.fn(async (input) => ({ resolved: input })),
    mergeArm: vi.fn(async (input) => ({ armed: input })),
    mergeStatus: vi.fn(async () => ({ prs: [] })),
    mergeRelease: vi.fn(async (input) => ({ released: input })),
    dispatchIssue: vi.fn(async () => ({ kind: "afk" as const, exit_code: 0 })),
    dispatchDemand: vi.fn(async () => ({ kind: "go" as const, exit_code: 0 })),
    dispatchScout: vi.fn(async () => ({ kind: "scout" as const, exit_code: 0 })),
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
    landBranch: vi.fn(async (input) => ({ issue: input.issue, ok: true })),
    cascadeStatus: vi.fn(async (input) => ({
      issue: input.issue,
      promotable: [],
    })),
    claimStatus: vi.fn(async (input) => ({ issue: input.issue, holders: [] })),
    claimRelease: vi.fn(async (input) => ({ issue: input.issue, conceded: [] })),
    waitStart: vi.fn(async () => ({ id: "a1b2c3d4-uuid", pid: 73, status: "spawned" })),
    dailyReview: vi.fn(async () => ({ kind: "daily" })),
    weeklyReview: vi.fn(async () => ({ kind: "weekly" })),
    triage: vi.fn(async (input) => ({ issue: input.issue, action: "apply" })),
    respond: vi.fn(async () => ({ action: "ignored" })),
    deadendAudit: vi.fn(async () => ({ total: 0, classes: [] })),
  };
}
