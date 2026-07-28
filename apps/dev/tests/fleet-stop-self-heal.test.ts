/**
 * Stop and self-heal must agree about which supervisor exists (#2714).
 *
 * The reported loop: `fleet stop` answered `status: none` on a live fleet, and
 * ~90s after the operator killed the supervisor by hand a fresh one appeared,
 * spawned by the self-heal path — a stop the healer could undo. #2698 gave every
 * management reader one identity anchor; what was still unpinned is the
 * interaction:
 *
 *   1. an explicit stop is terminal — the watchdog never resurrects a fleet
 *      whose stop was requested, on ANY of its recovery paths;
 *   2. `fleet_stop` names the pid and fleet it stopped whenever the recorded
 *      supervisor pid is alive, instead of reporting `none`;
 *   3. `--force` still finds the recorded pid when the strict identity anchor is
 *      unreadable, so a hard teardown is never blocked by a missing start pin;
 *   4. a supervisor the self-heal spawns is discoverable through the same anchor
 *      `fleet_stop` reads, so create and stop cannot disagree.
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const LIVE_PID = 515_151;
const SPAWNED_PID = 626_262;
const DEAD_PID = 999_999_999;

vi.mock("../src/runtime/kill-tree.js", () => ({
  isLivePid: (pid: number) => pid === LIVE_PID || pid === SPAWNED_PID,
  killTreeAndWait: vi.fn(async () => true),
}));

vi.mock("../src/core/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/state.js")>();
  return {
    ...actual,
    readPidStartTime: (pid: number) =>
      pid === LIVE_PID || pid === SPAWNED_PID ? `start-${pid}` : null,
  };
});

// The self-heal spawn is modeled, not executed: the assertion is about which
// anchors a spawned supervisor publishes, not about launching a real process.
vi.mock("../src/runtime/supervisor-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/supervisor-spawn.js")>();
  return {
    ...actual,
    spawnSupervisor: vi.fn(async () => SPAWNED_PID),
    stampFreshFleetHeartbeat: vi.fn(() => {}),
  };
});

import { stopFleet } from "../src/commands/fleet.js";
import { runWatchdog, type WatchdogIO } from "../src/core/watchdog.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { createCastleMcpDependencies } from "../src/mcp-adapter.js";
import { discoverLiveSupervisorPid } from "../src/runtime/supervisor-state.js";
import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
import { buildWatchdogIO } from "../src/runtime/watchdog-io.js";
import { afkPaths } from "../src/runtime/wire.js";

const NOW = 1_700_000_000;
const STALE = 300;
const PROGRESS_STALE = 900;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-stop-selfheal-"));
}

function sink(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

/** A heartbeat snapshot in the shape the supervisor writes every tick. */
function fleetSnapshot(options: { pid?: number; startTime?: string | null; ageS?: number } = {}): string {
  const pid = options.pid ?? LIVE_PID;
  const epoch = Math.floor(Date.now() / 1_000) - (options.ageS ?? 5);
  const startTime = options.startTime === undefined ? `start-${pid}` : options.startTime;
  return encodeDevSnapshotToon({
    ts: new Date(epoch * 1_000).toISOString(),
    epoch,
    runner: "claude",
    target: 2,
    pid,
    ...(startTime !== null ? { pid_start_time: startTime } : {}),
    ready_for_agent: 3,
    slots: { busy: 1, free: 1, total: 2, parked: 0 },
    slot_pids: [],
    spawns_this_tick: 0,
    churn: { deaths: 0, respawns: 0, window_s: 300 },
  });
}

function lane(root: string, fleet?: string): ReturnType<typeof afkPaths> {
  const paths = afkPaths(root, fleet);
  mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
  return paths;
}

interface StubOverrides {
  pid: number | null;
  pidAlive: boolean;
  lastHeartbeatEpoch?: number | null;
  stopRequested: boolean;
  recoveryPending?: boolean;
  readyForAgent?: number;
}

/** A watchdog IO stub whose every recovery seam is observable. */
function stubIo(over: StubOverrides) {
  const calls = {
    killTree: vi.fn(async () => {}),
    killWorkers: vi.fn(async () => ({ killed: 0, survivors: [] as number[] })),
    clearControlFiles: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    relaunch: vi.fn(async () => true),
    isStopRequested: vi.fn(async () => over.stopRequested),
    log: vi.fn(),
  };
  const io = {
    now: () => NOW,
    liveness: async () => ({
      pid: over.pid,
      pidAlive: over.pidAlive,
      lastHeartbeatEpoch: over.lastHeartbeatEpoch ?? null,
      lastProgressEpoch: null,
      slotsBusy: 0,
    }),
    ...calls,
    // The legacy dead-path signal deliberately reports NO stop here, so the test
    // proves the new fleet-wide guard is what refuses the resurrection.
    deadSupervisorSignals: async () => ({
      readyForAgent: over.readyForAgent ?? 5,
      target: 2,
      liveWorkers: 0,
      stopRequested: false,
    }),
    readRestartLedger: async () => [],
    writeRestartLedger: async () => {},
    isRecoveryPending: async () => over.recoveryPending === true,
    setRecoveryPending: async () => {},
  } as unknown as WatchdogIO;
  return { io, calls };
}

describe("an explicit stop is terminal for the self-heal (#2714)", () => {
  it("does not relaunch a QUIESCENT supervisor whose stop was requested", async () => {
    const { io, calls } = stubIo({
      pid: LIVE_PID,
      pidAlive: true,
      lastHeartbeatEpoch: NOW - 9_999,
      stopRequested: true,
    });

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.stopRequested).toBe(true);
    expect(result.recovered).toBe(false);
    // Not merely "no relaunch": the stop path owns teardown, so the watchdog
    // must not race it by killing the tree it is already draining.
    expect(calls.relaunch).not.toHaveBeenCalled();
    expect(calls.killTree).not.toHaveBeenCalled();
    expect(calls.killWorkers).not.toHaveBeenCalled();
    expect(calls.clearControlFiles).not.toHaveBeenCalled();
  });

  it("does not respawn a DEAD supervisor stranding work when the stop was requested", async () => {
    const { io, calls } = stubIo({
      pid: DEAD_PID,
      pidAlive: false,
      stopRequested: true,
      readyForAgent: 12,
    });

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.stopRequested).toBe(true);
    expect(result.respawnedDeadSupervisor).toBe(false);
    expect(calls.relaunch).not.toHaveBeenCalled();
  });

  it("does not complete a pending quiescent recovery once the stop was requested", async () => {
    // The exact resurrection window from the report: a recovery armed before the
    // operator stopped, whose identity is already gone.
    const { io, calls } = stubIo({
      pid: null,
      pidAlive: false,
      stopRequested: true,
      recoveryPending: true,
    });

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.stopRequested).toBe(true);
    expect(result.recovered).toBe(false);
    expect(calls.relaunch).not.toHaveBeenCalled();
  });

  it("still recovers a quiescent supervisor when no stop was requested", async () => {
    const { io, calls } = stubIo({
      pid: LIVE_PID,
      pidAlive: true,
      lastHeartbeatEpoch: NOW - 9_999,
      stopRequested: false,
    });

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.recovered).toBe(true);
    expect(result.stopRequested ?? false).toBe(false);
    expect(calls.relaunch).toHaveBeenCalledTimes(1);
  });

  it("reads the stop sentinel the stop path writes, through the real IO", async () => {
    const root = scratch();
    try {
      const paths = lane(root);
      const io = buildWatchdogIO(root, sink(), "default");
      expect(await io.isStopRequested?.()).toBe(false);
      writeFileSync(paths.supervisorStopPath, "", "utf8");
      expect(await io.isStopRequested?.()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fleet_stop names what it stopped (#2714)", () => {
  it("reports the live recorded pid and fleet instead of status none", async () => {
    const root = scratch();
    try {
      const paths = lane(root);
      writeFileSync(paths.supervisorPidPath, String(LIVE_PID), "utf8");
      writeFileSync(paths.supervisorPidStartPath, `start-${LIVE_PID}`, "utf8");
      writeFileSync(paths.fleetStatePath, fleetSnapshot(), "utf8");

      const result = (await createCastleMcpDependencies(root).fleetStop({
        name: "default",
        force: true,
      })) as { fleet: string; status: string; pid?: number };

      expect(result.status).toBe("stopped");
      expect(result.pid).toBe(LIVE_PID);
      expect(result.fleet).toBe("default");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("forced stop falls back to the recorded pid (#2714)", () => {
  it("stops the recorded live pid when the strict identity anchor is unreadable", async () => {
    const root = scratch();
    try {
      // The pid lock lost its start sidecar and the snapshot is undecodable —
      // strict discovery can prove nothing, but the recorded pid is alive.
      const paths = lane(root);
      writeFileSync(paths.supervisorPidPath, String(LIVE_PID), "utf8");
      writeFileSync(paths.fleetStatePath, "}{ not a snapshot", "utf8");

      expect(await discoverLiveSupervisorPid(paths.supervisorRuntimeDir)).toBeNull();

      const result = await stopFleet(root, sink(), "default", { force: true });

      expect(result).toMatchObject({ status: "stopped", pid: LIVE_PID });
      expect(existsSync(paths.supervisorPidPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the graceful stop strict — no unproven pid is signaled without --force", async () => {
    const root = scratch();
    try {
      const paths = lane(root);
      writeFileSync(paths.supervisorPidPath, String(LIVE_PID), "utf8");
      writeFileSync(paths.fleetStatePath, "}{ not a snapshot", "utf8");

      const result = await stopFleet(root, sink(), "default");

      expect(result.status).not.toBe("stopped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to a recorded pid that is dead", async () => {
    const root = scratch();
    try {
      const paths = lane(root);
      writeFileSync(paths.supervisorPidPath, String(DEAD_PID), "utf8");

      const result = await stopFleet(root, sink(), "default", { force: true });

      expect(result.status).not.toBe("stopped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the self-heal publishes the anchor fleet_stop reads (#2714)", () => {
  it("only reports a relaunch once discovery resolves the spawned supervisor", async () => {
    const root = scratch();
    try {
      const paths = lane(root);
      writeFileSync(paths.fleetStatePath, fleetSnapshot(), "utf8");
      // The modeled spawn publishes the boot lock exactly as the real one does.
      vi.mocked(spawnSupervisor).mockImplementation(async () => {
        writeFileSync(paths.supervisorPidPath, String(SPAWNED_PID), "utf8");
        writeFileSync(paths.supervisorPidStartPath, `start-${SPAWNED_PID}`, "utf8");
        return SPAWNED_PID;
      });

      const io = buildWatchdogIO(root, sink(), "default");
      await io.liveness();

      expect(await io.relaunch()).toBe(true);
      // Same anchor, same pid: fleet_stop can see what the self-heal created.
      const discovered = await discoverLiveSupervisorPid(paths.supervisorRuntimeDir);
      expect(discovered).toMatchObject({ pid: SPAWNED_PID, source: "pid-file" });
      expect(Number(readFileSync(paths.supervisorPidPath, "utf8").trim())).toBe(SPAWNED_PID);
    } finally {
      vi.mocked(spawnSupervisor).mockReset();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to report a relaunch whose supervisor publishes no discoverable anchor", async () => {
    const root = scratch();
    try {
      const paths = lane(root);
      // A dead-pid snapshot: no anchor in the lane can vouch for anybody, so the
      // only thing that could make discovery answer is the spawn itself.
      writeFileSync(paths.fleetStatePath, fleetSnapshot({ pid: DEAD_PID }), "utf8");
      vi.mocked(spawnSupervisor).mockImplementation(async () => SPAWNED_PID);

      const io = buildWatchdogIO(root, sink(), "default");
      await io.liveness();

      expect(await io.relaunch()).toBe(false);
      expect(await discoverLiveSupervisorPid(paths.supervisorRuntimeDir)).toBeNull();
    } finally {
      vi.mocked(spawnSupervisor).mockReset();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
