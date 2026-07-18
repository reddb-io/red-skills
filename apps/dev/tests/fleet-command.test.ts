import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode } from "@reddb-io/toon";

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

import { launchFleet, statusFleet, stopFleet } from "../src/commands/fleet.js";
import { isLivePid } from "../src/runtime/kill-tree.js";
import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
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
  });

  it("launchFleet removes dead supervisor pid/state/log files before spawning", async () => {
    const root = scratch();
    try {
      const paths = writeSupervisorArtifacts(root, 999_999_999);

      await launchFleet(["1"], root, stream());

      expect(spawnSupervisor).toHaveBeenCalledTimes(1);
      expect(existsSync(paths.pid)).toBe(false);
      expect(existsSync(paths.state)).toBe(false);
      expect(existsSync(paths.log)).toBe(false);
      expect(existsSync(paths.firehose)).toBe(false);
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
      expect(JSON.parse(readFileSync(afkPaths(root).supervisorResizePath, "utf8"))).toEqual({
        target: 4,
        runner: "codex",
        shrink_mode: "drain-then-retire",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
