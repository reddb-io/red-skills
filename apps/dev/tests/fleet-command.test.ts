import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode } from "@reddb-io/toon";
import { createCastleLaneWriters, createEnginePaths } from "@reddb-io/red-castle/engine";

const killTreeMocks = vi.hoisted(() => ({
  isLivePid: vi.fn((_pid: number) => false),
  killTreeAndWait: vi.fn(async () => false),
}));

vi.mock("../src/runtime/kill-tree.js", () => ({
  isLivePid: killTreeMocks.isLivePid,
  killTreeAndWait: killTreeMocks.killTreeAndWait,
}));

vi.mock("../src/runtime/supervisor-spawn.js", () => ({
  spawnSupervisor: vi.fn(async () => 43210),
}));

vi.mock("../src/runtime/supervisor-watchdog-spawn.js", () => ({
  spawnSupervisorWatchdog: vi.fn(async () => 43211),
}));

import { launchFleet, logsFleet, statusFleet, stopFleet } from "../src/commands/fleet.js";
import { isLivePid } from "../src/runtime/kill-tree.js";
import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
import { spawnSupervisorWatchdog } from "../src/runtime/supervisor-watchdog-spawn.js";
import { afkPaths } from "../src/runtime/wire.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-fleet-command-"));
}

function writeSupervisorArtifacts(root: string, pid: number | string): Record<string, string> {
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

  it("launchFleet removes dead supervisor pid/state/log files before spawning", async () => {
    const root = scratch();
    try {
      const paths = writeSupervisorArtifacts(root, 999_999_999);

      await launchFleet(["1"], root, stream());

      expect(spawnSupervisor).toHaveBeenCalledTimes(1);
      expect(spawnSupervisorWatchdog).toHaveBeenCalledWith({ root, fleet: "default" });
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

  it("stopFleet kills orphaned detached workers when the supervisor pid is stale (#2056)", async () => {
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
      // Every live orphan was killed — "stopped" is never a lie while workers merge.
      expect(killTreeMocks.killTreeAndWait).toHaveBeenCalledWith(111111);
      expect(killTreeMocks.killTreeAndWait).toHaveBeenCalledWith(222222);
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

  it("statusFleet discovers a live supervisor from the structured lane and calls out bundle skew (#2204)", async () => {
    const root = scratch();
    const priorCacheDir = process.env.RED_SKILLS_CACHE_DIR;
    try {
      const paths = afkPaths(root);
      const epoch = Math.floor(Date.now() / 1000);
      mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
      mkdirSync(join(dirname(paths.supervisorRuntimeDir), "s12345"), { recursive: true });
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

  it("statusFleet reports reverse skew against the current dev bundle without cached bundles (#2204)", async () => {
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
          version_skew: number;
        };
      };
      expect(report.supervisor).toMatchObject({
        bundle_version: "2.76.0",
        bundle_latest: "2.75.2",
        version_skew: 1,
      });
    } finally {
      if (priorCacheDir === undefined) delete process.env.RED_SKILLS_CACHE_DIR;
      else process.env.RED_SKILLS_CACHE_DIR = priorCacheDir;
      if (priorBuildVersion === undefined) delete process.env.RED_BUILD_VERSION;
      else process.env.RED_BUILD_VERSION = priorBuildVersion;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet leaves live supervisor files untouched", async () => {
    const root = scratch();
    try {
      const paths = writeSupervisorArtifacts(root, 12345);
      vi.mocked(isLivePid).mockReturnValueOnce(true).mockReturnValue(false);

      const result = await stopFleet(root, stream());

      expect(result.status).toBe("stopped");
      expect(existsSync(paths.pid)).toBe(true);
      expect(existsSync(paths.state)).toBe(true);
      expect(existsSync(paths.log)).toBe(true);
      expect(existsSync(paths.firehose)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopFleet discovers a live supervisor from the structured lane when the pid anchor is missing", async () => {
    const root = scratch();
    try {
      const paths = afkPaths(root);
      mkdirSync(join(dirname(paths.supervisorRuntimeDir), "s12345"), { recursive: true });
      vi.mocked(isLivePid).mockImplementation((pid) => {
        if (pid !== 12345) return false;
        return vi.mocked(isLivePid).mock.calls.length <= 1;
      });

      const result = await stopFleet(root, stream());

      expect(result).toEqual({ status: "stopped", pid: 12345 });
      expect(existsSync(paths.supervisorStopPath)).toBe(true);
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
      expect(writes.join("")).toContain("fleet directive pending");
      expect(decode(readFileSync(afkPaths(root).supervisorResizePath, "utf8"))).toEqual({
        target: 4,
        shrink_mode: "hard-kill",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launchFleet reports applied when a live runner directive already matches the heartbeat", async () => {
    const root = scratch();
    try {
      const stateAfk = join(root, ".red", "state", "castle");
      mkdirSync(stateAfk, { recursive: true });
      writeFileSync(join(stateAfk, "afk-supervisor.pid"), "12345", "utf8");
      const epoch = Math.floor(Date.now() / 1000);
      writeFileSync(
        join(stateAfk, "afk-supervisor.state.json"),
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
      expect(writes.join("")).toContain("fleet directive applied");
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
