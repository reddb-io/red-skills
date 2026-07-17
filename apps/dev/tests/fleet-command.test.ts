import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { launchFleet, stopFleet } from "../src/commands/fleet.js";
import { isLivePid } from "../src/runtime/kill-tree.js";
import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-fleet-command-"));
}

function writeSupervisorArtifacts(root: string, pid: number | string): Record<string, string> {
  const stateAfk = join(root, ".red", "state", "afk");
  mkdirSync(stateAfk, { recursive: true });
  const paths = {
    pid: join(stateAfk, "afk-supervisor.pid"),
    state: join(stateAfk, "afk-supervisor.state.json"),
    log: join(stateAfk, "afk-supervisor.log"),
    firehose: join(stateAfk, "afk-supervisor.log.jsonl"),
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
      const stateAfk = join(root, ".red", "state", "afk");
      mkdirSync(stateAfk, { recursive: true });
      writeFileSync(join(stateAfk, "afk-supervisor.pid"), "12345", "utf8");
      const epoch = Math.floor(Date.now() / 1000);
      writeFileSync(
        join(stateAfk, "afk-supervisor.state.json"),
        JSON.stringify({
          epoch,
          last_progress_epoch: epoch,
          runner: "codex",
          slots: { busy: 1, free: 1, total: 2, parked: 0 },
        }),
        "utf8",
      );
      vi.mocked(isLivePid).mockReturnValue(true);
      const out = stream();

      const result = await launchFleet(["4", "--shrink-mode", "hard-kill"], root, out);

      expect(result).toMatchObject({ status: "resized", pid: 12345, target: 4 });
      expect(spawnSupervisor).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(stateAfk, "afk-supervisor.resize.json"), "utf8"))).toEqual({
        target: 4,
        shrink_mode: "hard-kill",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
