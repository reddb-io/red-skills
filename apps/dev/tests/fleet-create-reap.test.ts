import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseState } from "../src/core/state.js";
import type { WorkerStateRecord } from "../src/core/worker-state-reader.js";

vi.mock("../src/runtime/wire.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/wire.js")>();
  return { ...actual, readFleetState: vi.fn() };
});

vi.mock("../src/core/worker-state-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/worker-state-reader.js")>();
  return { ...actual, readAllWorkerStates: vi.fn() };
});

vi.mock("../src/runtime/kill-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/kill-tree.js")>();
  return { ...actual, signalTree: vi.fn() };
});

import { reapOrphanedFleetWorkers } from "../src/core/fleet-create-reap.js";
import { readFleetState } from "../src/runtime/wire.js";
import { readAllWorkerStates } from "../src/core/worker-state-reader.js";
import { signalTree } from "../src/runtime/kill-tree.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  vi.mocked(readFleetState).mockReset();
  vi.mocked(readAllWorkerStates).mockReset();
  vi.mocked(signalTree).mockReset();
});

async function tmpRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "fleet-create-reap-"));
  roots.push(value);
  return value;
}

function makeWorkerRecord(pid: number, issue: number | string, workerId = "wTEST", runner = "codex"): WorkerStateRecord {
  return {
    path: `/fake/${workerId}/1/afk.state.toon`,
    state: parseState({ pid, worker_id: workerId, runner, current: { number: issue } }),
    live: true,
    active: true,
    liveness: "active",
    livenessVerdict: { status: "alive", laneFresh: true, crossCheckArmed: false, reason: "test" },
    pidIdentityLive: true,
    hostPidLive: false,
    renderableLive: true,
  };
}

function fakeFleetState(slotPids: Array<{ slot: number; pid: number }>) {
  return {
    ts: "2026-07-23T00:00:00Z",
    epoch: 0,
    runner: "codex",
    readyForAgent: 0,
    slotsBusy: slotPids.length,
    slotsFree: 0,
    slotsTotal: slotPids.length,
    slotsParked: 0,
    spawnsThisTick: slotPids.length,
    slotPids,
  };
}

describe("reapOrphanedFleetWorkers", () => {
  it("does nothing when the fleet state has no slot_pids", async () => {
    const cwd = await tmpRoot();
    vi.mocked(readFleetState).mockResolvedValue(fakeFleetState([]));
    vi.mocked(readAllWorkerStates).mockResolvedValue([]);

    const concedeClaim = vi.fn();
    await reapOrphanedFleetWorkers("/fake/state.toonl", cwd, concedeClaim);

    expect(signalTree).not.toHaveBeenCalled();
    expect(concedeClaim).not.toHaveBeenCalled();
  });

  it("does nothing when the fleet state is unreadable", async () => {
    const cwd = await tmpRoot();
    vi.mocked(readFleetState).mockRejectedValue(new Error("ENOENT"));

    const concedeClaim = vi.fn();
    await reapOrphanedFleetWorkers("/fake/state.toonl", cwd, concedeClaim);

    expect(signalTree).not.toHaveBeenCalled();
    expect(concedeClaim).not.toHaveBeenCalled();
  });

  it("kills each slot pid and concedes the matching worker's claim", async () => {
    const cwd = await tmpRoot();
    vi.mocked(readFleetState).mockResolvedValue(
      fakeFleetState([{ slot: 0, pid: 77_001 }, { slot: 1, pid: 77_002 }]),
    );
    vi.mocked(readAllWorkerStates).mockResolvedValue([
      makeWorkerRecord(77_001, 2601, "wAAA1", "codex"),
      makeWorkerRecord(77_002, 2602, "wAAA2", "claude"),
    ]);

    const concedeClaim = vi.fn().mockResolvedValue(undefined);
    await reapOrphanedFleetWorkers("/fake/state.toonl", cwd, concedeClaim);

    expect(signalTree).toHaveBeenCalledWith(77_001, "SIGKILL");
    expect(signalTree).toHaveBeenCalledWith(77_002, "SIGKILL");

    expect(concedeClaim).toHaveBeenCalledWith(2601, { id: "wAAA1", runner: "codex" });
    expect(concedeClaim).toHaveBeenCalledWith(2602, { id: "wAAA2", runner: "claude" });
  });

  it("skips claim concession for workers with no identified issue", async () => {
    const cwd = await tmpRoot();
    vi.mocked(readFleetState).mockResolvedValue(fakeFleetState([{ slot: 0, pid: 77_003 }]));
    vi.mocked(readAllWorkerStates).mockResolvedValue([
      makeWorkerRecord(77_003, "", "wBBB1"),
    ]);

    const concedeClaim = vi.fn();
    await reapOrphanedFleetWorkers("/fake/state.toonl", cwd, concedeClaim);

    expect(signalTree).toHaveBeenCalledWith(77_003, "SIGKILL");
    expect(concedeClaim).not.toHaveBeenCalled();
  });

  it("skips workers whose pid does not match any slot pid", async () => {
    const cwd = await tmpRoot();
    vi.mocked(readFleetState).mockResolvedValue(fakeFleetState([{ slot: 0, pid: 77_004 }]));
    // Worker with a DIFFERENT pid — not an orphan
    vi.mocked(readAllWorkerStates).mockResolvedValue([
      makeWorkerRecord(99_999, 2603, "wCCC1"),
    ]);

    const concedeClaim = vi.fn();
    await reapOrphanedFleetWorkers("/fake/state.toonl", cwd, concedeClaim);

    expect(signalTree).toHaveBeenCalledWith(77_004, "SIGKILL");
    expect(concedeClaim).not.toHaveBeenCalled();
  });

  it("swallows concedeClaim errors so one failed concession does not stop others", async () => {
    const cwd = await tmpRoot();
    vi.mocked(readFleetState).mockResolvedValue(
      fakeFleetState([{ slot: 0, pid: 77_005 }, { slot: 1, pid: 77_006 }]),
    );
    vi.mocked(readAllWorkerStates).mockResolvedValue([
      makeWorkerRecord(77_005, 2604, "wDDD1"),
      makeWorkerRecord(77_006, 2605, "wDDD2"),
    ]);

    const concedeClaim = vi.fn()
      .mockRejectedValueOnce(new Error("GitHub API 503"))
      .mockResolvedValueOnce(undefined);

    await expect(
      reapOrphanedFleetWorkers("/fake/state.toonl", cwd, concedeClaim),
    ).resolves.toBeUndefined();

    expect(concedeClaim).toHaveBeenCalledTimes(2);
  });
});
