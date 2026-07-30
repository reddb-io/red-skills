import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode } from "@reddb-io/toon";
import {
  castleStateSnapshotPath,
  createCastleLaneWriters,
  createEnginePaths,
  writeCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";

const killTreeMocks = vi.hoisted(() => ({
  isLivePid: vi.fn((_pid: number) => false),
  killTreeAndWait: vi.fn(async () => false),
}));

vi.mock("../src/runtime/kill-tree.js", () => ({
  isLivePid: killTreeMocks.isLivePid,
  killTreeAndWait: killTreeMocks.killTreeAndWait,
}));

vi.mock("../src/core/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/state.js")>();
  return { ...actual, readPidStartTime: (pid: number) => `start-${pid}` };
});

vi.mock("../src/runtime/supervisor-spawn.js", () => ({
  spawnSupervisor: vi.fn(async () => 43210),
}));

vi.mock("../src/runtime/supervisor-watchdog-spawn.js", () => ({
  spawnSupervisorWatchdog: vi.fn(async () => 43211),
}));

import { fleetCommand, launchFleet, logsFleet, statusFleet, stopFleet } from "../src/commands/fleet.js";
import { isLivePid } from "../src/runtime/kill-tree.js";
import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
import { spawnSupervisorWatchdog } from "../src/runtime/supervisor-watchdog-spawn.js";
import { afkPaths } from "../src/runtime/wire.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-fleet-command-"));
}

function writeSupervisorArtifacts(
  root: string,
  pid: number | string,
): Record<string, string> {
  const paths0 = afkPaths(root);
  const stateAfk = dirname(paths0.supervisorPidPath);
  mkdirSync(stateAfk, { recursive: true });
  const paths = {
    pid: paths0.supervisorPidPath,
    state: paths0.fleetStatePath,
    log: join(stateAfk, "afk-supervisor.log"),
    firehose: paths0.fleetFirehosePath,
  };
  writeFileSync(paths.pid, String(pid), "utf8");
  if (typeof pid === "number") {
    writeFileSync(paths0.supervisorPidStartPath, `start-${pid}`, "utf8");
  }
  writeFileSync(paths.state, "{not json", "utf8");
  writeFileSync(paths.log, "old supervisor log\n", "utf8");
  writeFileSync(paths.firehose, "old firehose\n", "utf8");
  return paths;
}

function stream(): NodeJS.WritableStream {
  return { write: vi.fn(() => true) } as unknown as NodeJS.WritableStream;
}

describe("fleet command stale supervisor state", () => {
  beforeEach(() => {
    vi.mocked(isLivePid).mockReset();
    vi.mocked(isLivePid).mockReturnValue(false);
    killTreeMocks.killTreeAndWait.mockReset();
    killTreeMocks.killTreeAndWait.mockResolvedValue(false);
    vi.mocked(spawnSupervisor).mockClear();
    vi.mocked(spawnSupervisor).mockResolvedValue(43210);
    vi.mocked(spawnSupervisorWatchdog).mockClear();
    vi.mocked(spawnSupervisorWatchdog).mockResolvedValue(43211);
  });

  it("prints help without spawning a supervisor (#2536)", async () => {
    const root = scratch();
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const code = await fleetCommand(["--help"], root);

      expect(code).toBe(0);
      expect(writes.join("")).toContain("Usage: red-skills-dev fleet");
      expect(spawnSupervisor).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown flag before spawning a supervisor (#2536)", async () => {
    const root = scratch();
    const errors: string[] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const code = await fleetCommand(["2", "--name", "drain"], root);

      expect(code).not.toBe(0);
      expect(errors.join("\n")).toContain("--name");
      expect(spawnSupervisor).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launchFleet removes dead supervisor pid/state/log files before spawning", async () => {
    const root = scratch();
    try {
      const paths = writeSupervisorArtifacts(root, 999_999_999);

      await launchFleet(["1"], root, stream());

      expect(spawnSupervisor).toHaveBeenCalledTimes(1);
      expect(spawnSupervisorWatchdog).toHaveBeenCalledWith({ root });
      expect(existsSync(paths.pid)).toBe(false);
      expect(existsSync(paths.state)).toBe(false);
      expect(existsSync(paths.log)).toBe(false);
      expect(existsSync(paths.firehose)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launchFleet passes the prior slot pid map to the relaunched supervisor", async () => {
    const root = scratch();
    try {
      const paths = writeSupervisorArtifacts(root, 999_999_999);
      const epoch = Math.floor(Date.now() / 1000);
      writeFileSync(
        paths.state,
        JSON.stringify({
          ts: new Date(epoch * 1000).toISOString(),
          epoch,
          runner: "codex",
          ready_for_agent: 2,
          slots: { busy: 2, free: 0, total: 2, parked: 0 },
          slot_pids: [{ slot: 0, pid: 11111 }, { slot: 1, pid: 22222 }],
          spawns_this_tick: 0,
        }),
        "utf8",
      );

      await launchFleet(["2", "--runner", "codex"], root, stream());

      expect(spawnSupervisor).toHaveBeenCalledWith(expect.objectContaining({
        adoptSlotPids: [{ slot: 0, pid: 11111 }, { slot: 1, pid: 22222 }],
      }));
      expect(existsSync(paths.state)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet removes dead supervisor pid/state/log files", async () => {
    const root = scratch();
    try {
      const paths = writeSupervisorArtifacts(root, 999_999_999);

      const result = await stopFleet(root, stream());

      expect(result).toMatchObject({ status: "stale", pid: 999_999_999 });
      expect(existsSync(paths.pid)).toBe(false);
      expect(existsSync(paths.state)).toBe(false);
      expect(existsSync(paths.log)).toBe(false);
      expect(existsSync(paths.firehose)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet leaves detached workers alone when the supervisor pid is stale (#2472)", async () => {
    const root = scratch();
    try {
      writeSupervisorArtifacts(root, 999_999_999); // dead supervisor pid
      // Two orphaned workers with live pids. They are spawned detached, so they
      // are NOT in the supervisor's process tree and survive its death.
      const workersRoot = join(root, ".red", "tmp", "workers");
      mkdirSync(join(workersRoot, "wAAAA"), { recursive: true });
      mkdirSync(join(workersRoot, "wBBBB"), { recursive: true });
      writeFileSync(join(workersRoot, "wAAAA", "worker.pid"), "111111", "utf8");
      writeFileSync(join(workersRoot, "wBBBB", "worker.pid"), "222222", "utf8");
      // Supervisor pid dead; both worker pids alive.
      vi.mocked(isLivePid).mockImplementation((pid: number) => pid === 111111 || pid === 222222);
      killTreeMocks.killTreeAndWait.mockResolvedValue(true);

      const result = await stopFleet(root, stream());

      expect(result.status).toBe("stale");
      expect(killTreeMocks.killTreeAndWait).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet writes the stop sentinel and terminates the repo watchdog before reporting none", async () => {
    const root = scratch();
    try {
      const paths = afkPaths(root);
      mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
      writeFileSync(paths.supervisorWatchdogPidPath, "24680", "utf8");
      writeFileSync(paths.supervisorWatchdogPidStartPath, "start-24680", "utf8");
      vi.mocked(isLivePid).mockImplementation((pid) => pid === 24680);
      killTreeMocks.killTreeAndWait.mockResolvedValue(true);

      const result = await stopFleet(root, stream());

      expect(result).toEqual({ status: "none", anchor: "none" });
      expect(killTreeMocks.killTreeAndWait).toHaveBeenCalledWith(24680);
      expect(existsSync(paths.supervisorWatchdogPidPath)).toBe(false);
      expect(existsSync(paths.supervisorWatchdogPidStartPath)).toBe(false);
      expect(existsSync(paths.supervisorStopPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet performs zero worker kills when no fleet is registered (#2472)", async () => {
    const root = scratch();
    try {
      const workersRoot = join(root, ".red", "tmp", "workers");
      mkdirSync(join(workersRoot, "wSOLO"), { recursive: true });
      writeFileSync(join(workersRoot, "wSOLO", "worker.pid"), "333333", "utf8");
      vi.mocked(isLivePid).mockImplementation((pid: number) => pid === 333333);
      killTreeMocks.killTreeAndWait.mockResolvedValue(true);

      const result = await stopFleet(root, stream());

      expect(result).toEqual({ status: "none", anchor: "none" });
      expect(killTreeMocks.killTreeAndWait).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("statusFleet reports supervisor + slots ground truth read-only, no supervisor → absent (#2060)", async () => {
    const root = scratch();
    try {
      const writes: string[] = [];
      const out = {
        write: vi.fn((s: string) => {
          writes.push(s);
          return true;
        }),
      } as unknown as NodeJS.WritableStream;

      const result = await statusFleet(root, out);

      expect(result).toEqual({ status: "reported" });
      const text = writes.join("");
      expect(text).toContain("supervisor");
      expect(text).toContain("health");
      // A clean scratch has no supervisor pid → classifySupervisor returns absent.
      expect(text).toMatch(/health:\s*absent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // An unmeasured version and a measured match are different answers; reporting
  // both as `version_skew: 0` is what hid the boot-killing gap (#2752).
  it("statusFleet reports an unknown bundle version instead of hiding it as no-skew (#2752)", async () => {
    const root = scratch();
    try {
      const paths = afkPaths(root);
      const epoch = Math.floor(Date.now() / 1000);
      mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
      writeFileSync(paths.supervisorPidPath, "12345", "utf8");
      writeFileSync(paths.supervisorPidStartPath, "start-12345", "utf8");
      writeFileSync(
        paths.fleetStatePath,
        JSON.stringify({
          epoch,
          last_progress_epoch: epoch,
          runner: "claude",
          ready_for_agent: 0,
          slots: { busy: 0, free: 3, total: 3, parked: 0 },
        }),
        "utf8",
      );
      vi.mocked(isLivePid).mockImplementation((pid) => pid === 12345);
      const writes: string[] = [];
      const out = {
        write: vi.fn((s: string) => {
          writes.push(s);
          return true;
        }),
      } as unknown as NodeJS.WritableStream;

      await statusFleet(root, out);

      const report = decode(writes.join("")) as {
        supervisor: { bundle_version: string; version_unknown: number; version_skew: number };
      };
      expect(report.supervisor).toMatchObject({
        bundle_version: "",
        version_unknown: 1,
        version_skew: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("statusFleet discovers a live supervisor from the structured lane and calls out bundle skew (#2204)", async () => {
    const root = scratch();
    const priorCacheDir = process.env.RED_SKILLS_CACHE_DIR;
    try {
      const paths = afkPaths(root);
      const epoch = Math.floor(Date.now() / 1000);
      mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
      mkdirSync(join(dirname(paths.supervisorRuntimeDir), "s12345"), { recursive: true });
      writeFileSync(paths.supervisorPidPath, "12345", "utf8");
      writeFileSync(paths.supervisorPidStartPath, "start-12345", "utf8");
      writeFileSync(
        paths.fleetStatePath,
        JSON.stringify({
          epoch,
          last_progress_epoch: epoch,
          runner: "codex",
          bundle_version: "2.75.0",
          ready_for_agent: 0,
          slots: { busy: 0, free: 2, total: 2, parked: 0 },
        }),
        "utf8",
      );
      const cacheDir = join(root, "bundle-cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "dev-2.75.2.bundle.min.mjs"), "", "utf8");
      process.env.RED_SKILLS_CACHE_DIR = cacheDir;
      vi.mocked(isLivePid).mockImplementation((pid) => pid === 12345);
      const writes: string[] = [];
      const out = {
        write: vi.fn((s: string) => {
          writes.push(s);
          return true;
        }),
      } as unknown as NodeJS.WritableStream;

      await statusFleet(root, out);

      const report = decode(writes.join("")) as {
        supervisor: {
          pid: number;
          alive: boolean;
          health: string;
          bundle_version: string;
          bundle_latest: string;
          version_skew: number;
        };
      };
      expect(report.supervisor).toMatchObject({
        pid: 12345,
        alive: true,
        health: "healthy",
        bundle_version: "2.75.0",
        bundle_latest: "2.75.2",
        version_skew: 1,
      });
    } finally {
      if (priorCacheDir === undefined) delete process.env.RED_SKILLS_CACHE_DIR;
      else process.env.RED_SKILLS_CACHE_DIR = priorCacheDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The installed version answers "what am I running", never "what is published".
  // Substituting it produced a confident verdict against a value that measured
  // nothing — the report that read healthy while every Worker halted (#2809).
  it("statusFleet reports the published version as unknown rather than substituting the installed one (#2809)", async () => {
    const root = scratch();
    const priorCacheDir = process.env.RED_SKILLS_CACHE_DIR;
    const priorBuildVersion = process.env.RED_BUILD_VERSION;
    try {
      const paths = afkPaths(root);
      const epoch = Math.floor(Date.now() / 1000);
      mkdirSync(dirname(paths.fleetStatePath), { recursive: true });
      writeFileSync(
        paths.fleetStatePath,
        JSON.stringify({
          epoch,
          last_progress_epoch: epoch,
          runner: "codex",
          bundle_version: "2.76.0",
          ready_for_agent: 0,
          slots: { busy: 0, free: 2, total: 2, parked: 0 },
        }),
        "utf8",
      );
      const emptyCacheDir = join(root, "empty-bundle-cache");
      mkdirSync(emptyCacheDir, { recursive: true });
      process.env.RED_SKILLS_CACHE_DIR = emptyCacheDir;
      process.env.RED_BUILD_VERSION = "2.75.2";
      const writes: string[] = [];
      const out = {
        write: vi.fn((s: string) => {
          writes.push(s);
          return true;
        }),
      } as unknown as NodeJS.WritableStream;

      await statusFleet(root, out);

      const report = decode(writes.join("")) as {
        supervisor: {
          bundle_version: string;
          bundle_latest: string;
          published_unknown: number;
          version_skew: number;
        };
      };
      expect(report.supervisor).toMatchObject({
        bundle_version: "2.76.0",
        bundle_latest: "",
        published_unknown: 1,
        version_skew: 0,
      });
    } finally {
      if (priorCacheDir === undefined) delete process.env.RED_SKILLS_CACHE_DIR;
      else process.env.RED_SKILLS_CACHE_DIR = priorCacheDir;
      if (priorBuildVersion === undefined) delete process.env.RED_BUILD_VERSION;
      else process.env.RED_BUILD_VERSION = priorBuildVersion;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet leaves a detached in-flight worker running after graceful supervisor exit (#2472)", async () => {
    const root = scratch();
    try {
      const paths = writeSupervisorArtifacts(root, 12345);
      const workersRoot = join(root, ".red", "tmp", "workers");
      mkdirSync(join(workersRoot, "wDRAIN"), { recursive: true });
      writeFileSync(join(workersRoot, "wDRAIN", "worker.pid"), "444444", "utf8");
      let supervisorChecks = 0;
      vi.mocked(isLivePid).mockImplementation((pid: number) => {
        if (pid === 444444) return true;
        if (pid === 12345) {
          supervisorChecks += 1;
          return supervisorChecks === 1;
        }
        return false;
      });
      killTreeMocks.killTreeAndWait.mockResolvedValue(true);

      const result = await stopFleet(root, stream());

      expect(result.status).toBe("stopped");
      expect(killTreeMocks.killTreeAndWait).not.toHaveBeenCalledWith(444444);
      expect(existsSync(paths.pid)).toBe(true);
      expect(existsSync(paths.state)).toBe(true);
      expect(existsSync(paths.log)).toBe(true);
      expect(existsSync(paths.firehose)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force stop kills only workers attributed to this project's supervisor (#2472)", async () => {
    const root = scratch();
    try {
      writeSupervisorArtifacts(root, 12345);
      const workersRoot = join(root, ".red", "tmp", "workers");
      const workers = [
        { id: "wSUPERVISED", pid: 555001, lane: "default" },
        { id: "wOTHERLANE", pid: 555002, lane: "other" },
        { id: "wSOLO", pid: 555003, lane: undefined },
      ];
      const enginePaths = createEnginePaths(join(root, ".red"));
      for (const worker of workers) {
        mkdirSync(join(workersRoot, worker.id), { recursive: true });
        writeFileSync(join(workersRoot, worker.id, "worker.pid"), String(worker.pid), "utf8");
        await writeCastleStateSnapshot(
          castleStateSnapshotPath(enginePaths, "worker", worker.id),
          {
            kind: "worker",
            id: worker.id,
            worker_id: worker.id,
            version: 1,
            updated_at: new Date().toISOString(),
            pid: worker.pid,
            current: { origin: "afk" },
            ...(worker.lane ? { supervisor_id: worker.lane } : {}),
          },
        );
      }
      vi.mocked(isLivePid).mockImplementation((pid: number) =>
        pid === 12345 || workers.some((worker) => worker.pid === pid)
      );
      killTreeMocks.killTreeAndWait.mockResolvedValue(true);

      const result = await stopFleet(root, stream(), { force: true });

      expect(result).toEqual({ status: "stopped", pid: 12345, anchor: "pid-file" });
      expect(killTreeMocks.killTreeAndWait).toHaveBeenCalledWith(12345);
      expect(killTreeMocks.killTreeAndWait).toHaveBeenCalledWith(555001);
      expect(killTreeMocks.killTreeAndWait).not.toHaveBeenCalledWith(555002);
      expect(killTreeMocks.killTreeAndWait).not.toHaveBeenCalledWith(555003);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force stop reports timeout when an attributed worker survives hard teardown (#2472)", async () => {
    const root = scratch();
    try {
      writeSupervisorArtifacts(root, 12345);
      const workerId = "wSTUCK";
      const workerPid = 666001;
      const workersRoot = join(root, ".red", "tmp", "workers");
      mkdirSync(join(workersRoot, workerId), { recursive: true });
      writeFileSync(join(workersRoot, workerId, "worker.pid"), String(workerPid), "utf8");
      const enginePaths = createEnginePaths(join(root, ".red"));
      await writeCastleStateSnapshot(
        castleStateSnapshotPath(enginePaths, "worker", workerId),
        {
          kind: "worker",
          id: workerId,
          worker_id: workerId,
          version: 1,
          updated_at: new Date().toISOString(),
          pid: workerPid,
          supervisor_id: "default",
          current: { origin: "afk" },
        },
      );
      vi.mocked(isLivePid).mockImplementation((pid: number) =>
        pid === 12345 || pid === workerPid
      );
      killTreeMocks.killTreeAndWait
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await stopFleet(root, stream(), { force: true });

      expect(result).toEqual({ status: "timeout", pid: workerPid, anchor: "pid-file" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet ignores an unpinned structured lane when the pid anchor is missing", async () => {
    const root = scratch();
    try {
      const paths = afkPaths(root);
      mkdirSync(join(dirname(paths.supervisorRuntimeDir), "s12345"), { recursive: true });
      vi.mocked(isLivePid).mockImplementation((pid) => {
        if (pid !== 12345) return false;
        return vi.mocked(isLivePid).mock.calls.length <= 1;
      });

      const result = await stopFleet(root, stream());

      expect(result).toEqual({ status: "none", anchor: "none" });
      expect(existsSync(paths.supervisorStopPath)).toBe(false);
      expect(killTreeMocks.killTreeAndWait).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launchFleet writes a resize request when a healthy supervisor is already running", async () => {
      const root = scratch();
    try {
      const stateAfk = dirname(afkPaths(root).supervisorPidPath);
      mkdirSync(stateAfk, { recursive: true });
      writeFileSync(join(stateAfk, "afk-supervisor.pid"), "12345", "utf8");
      writeFileSync(join(stateAfk, "afk-supervisor.pid.start"), "start-12345", "utf8");
      const epoch = Math.floor(Date.now() / 1000);
      writeFileSync(
        join(stateAfk, "state.toon"),
        JSON.stringify({
          epoch,
          last_progress_epoch: epoch,
          runner: "codex",
          slots: { busy: 1, free: 1, total: 2, parked: 0 },
        }),
        "utf8",
      );
      vi.mocked(isLivePid).mockReturnValue(true);
      const writes: string[] = [];
      const out = {
        write: vi.fn((s: string) => {
          writes.push(s);
          return true;
        }),
      } as unknown as NodeJS.WritableStream;

      const result = await launchFleet(["4", "--shrink-mode", "hard-kill"], root, out);

      expect(result).toMatchObject({ status: "resized", pid: 12345, target: 4 });
      expect(spawnSupervisor).not.toHaveBeenCalled();
      expect(spawnSupervisorWatchdog).toHaveBeenCalledWith({ root });
      expect(writes.join("")).toContain("directive pending");
      expect(decode(readFileSync(afkPaths(root).supervisorResizePath, "utf8"))).toEqual({
        target: 4,
        shrink_mode: "hard-kill",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back a newly launched supervisor when watchdog arming fails", async () => {
    const root = scratch();
    try {
      vi.mocked(spawnSupervisorWatchdog).mockResolvedValueOnce(null);
      const paths = afkPaths(root);
      mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
      writeFileSync(paths.supervisorPidPath, "43210", "utf8");
      writeFileSync(paths.supervisorPidStartPath, "start-43210", "utf8");

      await expect(launchFleet(["1"], root, stream())).rejects.toThrow("watchdog did not arm");

      expect(killTreeMocks.killTreeAndWait).toHaveBeenCalledWith(43210);
      expect(existsSync(paths.supervisorPidPath)).toBe(false);
      expect(existsSync(paths.supervisorPidStartPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launchFleet reports applied when a live runner directive already matches the heartbeat", async () => {
    const root = scratch();
    try {
      const stateAfk = dirname(afkPaths(root).supervisorPidPath);
      mkdirSync(stateAfk, { recursive: true });
      writeFileSync(join(stateAfk, "afk-supervisor.pid"), "12345", "utf8");
      writeFileSync(join(stateAfk, "afk-supervisor.pid.start"), "start-12345", "utf8");
      const epoch = Math.floor(Date.now() / 1000);
      writeFileSync(
        join(stateAfk, "state.toon"),
        JSON.stringify({
          epoch,
          last_progress_epoch: epoch,
          target: 4,
          runner: "codex",
          shrink_mode: "drain-then-retire",
          slots: { busy: 1, free: 3, total: 4, parked: 0 },
        }),
        "utf8",
      );
      vi.mocked(isLivePid).mockReturnValue(true);
      const writes: string[] = [];
      const out = {
        write: vi.fn((s: string) => {
          writes.push(s);
          return true;
        }),
      } as unknown as NodeJS.WritableStream;

      const result = await launchFleet(["4", "--runner", "codex"], root, out);

      expect(result).toMatchObject({ status: "resized", pid: 12345, target: 4 });
      expect(spawnSupervisor).not.toHaveBeenCalled();
      expect(writes.join("")).toContain("directive applied");
      expect(decode(readFileSync(afkPaths(root).supervisorResizePath, "utf8"))).toEqual({
        target: 4,
        runner: "codex",
        shrink_mode: "drain-then-retire",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fleet logs", () => {
  it("renders the supervisor structured lane as human-readable lines (#2066)", async () => {
    const root = scratch();
    try {
      const writers = createCastleLaneWriters(createEnginePaths(join(root, ".red")), {
        clock: () => "2026-07-18T00:00:00.000Z",
      });
      await writers.supervisor("s123").append({
        kind: "supervisor.message",
        supervisor_id: "s123",
        payload: { message: "fleet tick target=2 ready=1" },
      });
      const writes: string[] = [];
      const out = { write: vi.fn((s: string) => { writes.push(s); return true; }) } as unknown as NodeJS.WritableStream;

      await logsFleet(["--supervisor"], root, out);

      expect(writes.join("")).toContain("2026-07-18T00:00:00.000Z supervisor.message fleet tick target=2 ready=1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders one worker's structured stream (#2066)", async () => {
    const root = scratch();
    try {
      const writers = createCastleLaneWriters(createEnginePaths(join(root, ".red")), {
        clock: () => "2026-07-18T00:01:00.000Z",
      });
      await writers.worker("wAAAA").append({
        kind: "worker.claimed",
        worker_id: "wAAAA",
        issue: 2066,
        attempt: 1,
        payload: { message: "claimed issue" },
      });
      const writes: string[] = [];
      const out = { write: vi.fn((s: string) => { writes.push(s); return true; }) } as unknown as NodeJS.WritableStream;

      await logsFleet(["--worker", "wAAAA"], root, out);

      expect(writes.join("")).toContain("2026-07-18T00:01:00.000Z worker.claimed #2066 a1 claimed issue");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges every worker stream with per-worker prefixes (#2066)", async () => {
    const root = scratch();
    try {
      const writers = createCastleLaneWriters(createEnginePaths(join(root, ".red")));
      await writers.worker("wBBBB").append({
        at: "2026-07-18T00:03:00.000Z",
        kind: "worker.heartbeat",
        worker_id: "wBBBB",
        payload: { message: "second" },
      });
      await writers.worker("wAAAA").append({
        at: "2026-07-18T00:02:00.000Z",
        kind: "worker.heartbeat",
        worker_id: "wAAAA",
        payload: { message: "first" },
      });
      const writes: string[] = [];
      const out = { write: vi.fn((s: string) => { writes.push(s); return true; }) } as unknown as NodeJS.WritableStream;

      await logsFleet(["--all"], root, out);

      expect(writes.join("")).toBe(
        "[wAAAA] 2026-07-18T00:02:00.000Z worker.heartbeat first\n" +
        "[wBBBB] 2026-07-18T00:03:00.000Z worker.heartbeat second\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("streams appended records in follow mode (#2066)", async () => {
    const root = scratch();
    try {
      const writers = createCastleLaneWriters(createEnginePaths(join(root, ".red")));
      const writes: string[] = [];
      const out = { write: vi.fn((s: string) => { writes.push(s); return true; }) } as unknown as NodeJS.WritableStream;
      const controller = new AbortController();
      const running = logsFleet(["--worker", "wLIVE", "--follow"], root, out, {
        followPollMs: 10,
        signal: controller.signal,
      });

      await writers.worker("wLIVE").append({
        at: "2026-07-18T00:04:00.000Z",
        kind: "worker.heartbeat",
        worker_id: "wLIVE",
        payload: { message: "still working" },
      });

      const deadline = Date.now() + 1000;
      while (!writes.join("").includes("still working") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      await running;

      expect(writes.join("")).toContain("2026-07-18T00:04:00.000Z worker.heartbeat still working");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the work policy the fleet registry used to hold (#2786)", () => {
  it("carries the base branch and the work scope from the argv to the supervisor", async () => {
    const root = scratch();
    try {
      await launchFleet(
        ["1", "--base", "release/2.x", "--selector", '{"spec":2772}'],
        root,
        stream(),
      );

      expect(spawnSupervisor).toHaveBeenCalledWith(
        expect.objectContaining({
          base: "release/2.x",
          passthrough: expect.arrayContaining(["--selector", '{"spec":2772}']),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a --fleet invocation with the replacement, not an internal error", async () => {
    const root = scratch();
    vi.mocked(spawnSupervisor).mockClear();
    const errors: string[] = [];
    const console_ = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      await expect(fleetCommand(["status", "--fleet", "nightly"], root)).resolves.toBe(1);
      expect(errors.join("\n")).toContain("named fleets were removed");
      expect(errors.join("\n")).toContain("project_start");
      expect(spawnSupervisor).not.toHaveBeenCalled();
    } finally {
      console_.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
