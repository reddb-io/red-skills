/**
 * Supervisor identity anchors (#2698).
 *
 * One identity — pid + process-start pin — published to TWO anchors the
 * supervisor writes: the `afk-supervisor.pid` lock at boot and the `state.toon`
 * heartbeat every tick. Before this fix the launch path maintained the lock and
 * every management read trusted ONLY the lock, so a ticking fleet whose lock was
 * missing read back as `pid 0 / alive false / health absent` while the same
 * response carried a 13-second-old heartbeat and two busy slots, and `fleet_stop`
 * answered `status: none` on a fleet it could see working.
 *
 * These tests pin the reconciliation: every management reader resolves the
 * identity from either anchor, a live lane is never reaped, and the incoherent
 * "absent while ticking" report is impossible by construction.
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const LIVE_PID = 424_242;
const DEAD_PID = 999_999_999;

// A deterministic process-start table: `LIVE_PID` is alive with a stable start
// token, everything else is dead. Mirrors readPidStartTime's real contract
// (null for a pid that does not exist).
vi.mock("../src/runtime/kill-tree.js", () => ({
  isLivePid: (pid: number) => pid === LIVE_PID,
  killTreeAndWait: vi.fn(async () => true),
}));

vi.mock("../src/core/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/state.js")>();
  return {
    ...actual,
    readPidStartTime: (pid: number) => (pid === LIVE_PID ? `start-${pid}` : null),
  };
});

import { fleetHeartbeatState } from "../src/commands/supervise.js";
import { stopFleet } from "../src/commands/fleet.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { createCastleMcpDependencies } from "../src/mcp-adapter.js";
import {
  discoverLiveSupervisorPid,
  readFleetStateAnchor,
  reapStaleSupervisorState,
  FLEET_STATE_ANCHOR_MAX_AGE_S,
} from "../src/runtime/supervisor-state.js";
import { collectTmpJanitorReport } from "../src/runtime/tmp-janitor.js";
import { afkPaths } from "../src/runtime/wire.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-supervisor-anchor-"));
}

interface SnapshotOptions {
  pid?: number;
  startTime?: string | null;
  ageS?: number;
  slotsBusy?: number;
}

/** A heartbeat snapshot in the shape the supervisor writes every tick. */
function fleetSnapshot(options: SnapshotOptions = {}): string {
  const pid = options.pid ?? LIVE_PID;
  const epoch = Math.floor(Date.now() / 1_000) - (options.ageS ?? 5);
  const startTime = options.startTime === undefined ? `start-${pid}` : options.startTime;
  const busy = options.slotsBusy ?? 2;
  return encodeDevSnapshotToon({
    ts: new Date(epoch * 1_000).toISOString(),
    epoch,
    runner: "claude",
    target: 3,
    pid,
    ...(startTime !== null ? { pid_start_time: startTime } : {}),
    ready_for_agent: 4,
    slots: { busy, free: 3 - busy, total: 3, parked: 0 },
    slot_pids: [],
    spawns_this_tick: 0,
    churn: { deaths: 0, respawns: 0, window_s: 300 },
  });
}

/** Write a runtime lane for `default` and return its paths. */
function lane(root: string, snapshot?: string): ReturnType<typeof afkPaths> {
  const paths = afkPaths(root);
  mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
  if (snapshot !== undefined) writeFileSync(paths.fleetStatePath, snapshot, "utf8");
  return paths;
}

function sink(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

describe("supervisor identity anchors (#2698)", () => {
  it("stamps the pid identity the reader resolves, with both anchors naming one pid", async () => {
    const root = scratch();
    try {
      // The production heartbeat encoder is the writer under test: whatever it
      // emits must be exactly what readFleetStateAnchor can verify.
      const paths = lane(root);
      const epoch = Math.floor(Date.now() / 1_000);
      writeFileSync(
        paths.fleetStatePath,
        fleetHeartbeatState({
          ts: new Date(epoch * 1_000).toISOString(),
          epoch,
          lastProgressEpoch: epoch,
          runner: "claude",
          target: 3,
          shrinkMode: "drain-then-retire",
          slotDetails: [],
          pid: LIVE_PID,
          pidStartTime: `start-${LIVE_PID}`,
          readyForAgent: 0,
          slotsBusy: 1,
          slotsFree: 2,
          slotsTotal: 3,
          slotsParked: 0,
          spawnsThisTick: 0,
          slotPids: [],
          churn: { deaths: 0, respawns: 0, windowS: 300 },
        }),
        "utf8",
      );
      // The boot lock names the same identity.
      writeFileSync(paths.supervisorPidPath, String(LIVE_PID), "utf8");
      writeFileSync(paths.supervisorPidStartPath, `start-${LIVE_PID}`, "utf8");

      const anchor = await readFleetStateAnchor(paths.supervisorRuntimeDir);
      expect(anchor).toMatchObject({ pid: LIVE_PID, startTime: `start-${LIVE_PID}` });

      // No stale second source: the lock and the snapshot agree, and discovery
      // prefers the lock while both are coherent.
      const discovered = await discoverLiveSupervisorPid(paths.supervisorRuntimeDir);
      expect(discovered).toMatchObject({ pid: LIVE_PID, source: "pid-file" });
      expect(anchor?.pid).toBe(discovered?.pid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a live supervisor from the heartbeat snapshot when the pid lock is missing", async () => {
    const root = scratch();
    try {
      const paths = lane(root, fleetSnapshot());
      expect(existsSync(paths.supervisorPidPath)).toBe(false);

      const discovered = await discoverLiveSupervisorPid(paths.supervisorRuntimeDir);

      expect(discovered).toMatchObject({ pid: LIVE_PID, source: "fleet-state" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a live supervisor whose pid lock lost its process-start sidecar", async () => {
    const root = scratch();
    try {
      const paths = lane(root, fleetSnapshot());
      writeFileSync(paths.supervisorPidPath, String(LIVE_PID), "utf8");

      const discovered = await discoverLiveSupervisorPid(paths.supervisorRuntimeDir);

      expect(discovered).toMatchObject({ pid: LIVE_PID, source: "fleet-state" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a recycled pid whose snapshot identity no longer matches", async () => {
    const root = scratch();
    try {
      const paths = lane(root, fleetSnapshot({ startTime: "some-older-boot" }));

      expect(await discoverLiveSupervisorPid(paths.supervisorRuntimeDir)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("time-boxes a legacy snapshot that carries a pid but no process-start pin", async () => {
    const root = scratch();
    try {
      const fresh = scratch();
      const freshPaths = lane(fresh, fleetSnapshot({ startTime: null, ageS: 10 }));
      expect(await discoverLiveSupervisorPid(freshPaths.supervisorRuntimeDir))
        .toMatchObject({ pid: LIVE_PID, source: "fleet-state" });
      rmSync(fresh, { recursive: true, force: true });

      const stalePaths = lane(
        root,
        fleetSnapshot({ startTime: null, ageS: FLEET_STATE_ANCHOR_MAX_AGE_S + 60 }),
      );
      expect(await discoverLiveSupervisorPid(stalePaths.supervisorRuntimeDir)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never reaps a live lane whose only anchor is the heartbeat snapshot", async () => {
    const root = scratch();
    try {
      const paths = lane(root, fleetSnapshot());

      const result = await reapStaleSupervisorState(paths.supervisorRuntimeDir);

      expect(result).toMatchObject({ status: "live", pid: LIVE_PID, removed: [] });
      expect(existsSync(paths.fleetStatePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still reaps a lane whose pid lock AND snapshot both name a dead process", async () => {
    const root = scratch();
    try {
      const paths = lane(root, fleetSnapshot({ pid: DEAD_PID }));
      writeFileSync(paths.supervisorPidPath, String(DEAD_PID), "utf8");
      writeFileSync(paths.supervisorPidStartPath, `start-${DEAD_PID}`, "utf8");

      const result = await reapStaleSupervisorState(paths.supervisorRuntimeDir);

      expect(result.status).toBe("stale");
      expect(existsSync(paths.supervisorPidPath)).toBe(false);
      expect(existsSync(paths.fleetStatePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fleet_status coherence (#2698)", () => {
  it("never reports alive:false alongside a fresh heartbeat and busy slots", async () => {
    const root = scratch();
    try {
      // The exact reported lane: ticking heartbeat, two busy slots, no pid file.
      lane(root, fleetSnapshot({ ageS: 13, slotsBusy: 2 }));

      const status = (await createCastleMcpDependencies(root).fleetStatus({
        name: "default",
      })) as {
        supervisor: {
          pid: number;
          alive: boolean;
          health: string;
          heartbeat_age_s: number;
          identity_anchor: string;
        };
        slots: { busy: number };
      };

      expect(status.slots.busy).toBe(2);
      expect(status.supervisor.heartbeat_age_s).toBeLessThan(60);
      // The invariant: a fresh heartbeat with busy slots cannot coexist with an
      // absent supervisor in the same response.
      expect(status.supervisor.alive).toBe(true);
      expect(status.supervisor.pid).toBe(LIVE_PID);
      expect(status.supervisor.health).not.toBe("absent");
      expect(status.supervisor.identity_anchor).toBe("fleet-state");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an absent supervisor when neither anchor names a live process", async () => {
    const root = scratch();
    try {
      lane(root, fleetSnapshot({ pid: DEAD_PID }));

      const status = (await createCastleMcpDependencies(root).fleetStatus({
        name: "default",
      })) as { supervisor: { pid: number; alive: boolean; health: string; identity_anchor: string } };

      expect(status.supervisor.alive).toBe(false);
      expect(status.supervisor.pid).toBe(0);
      expect(status.supervisor.health).toBe("absent");
      expect(status.supervisor.identity_anchor).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fleet_stop on a snapshot-anchored fleet (#2698)", () => {
  it("signals the live supervisor and reports the pid it stopped", async () => {
    const root = scratch();
    try {
      const paths = lane(root, fleetSnapshot());

      const result = await stopFleet(root, sink(), "default", { force: true });

      expect(result).toMatchObject({ status: "stopped", pid: LIVE_PID });
      expect(existsSync(paths.supervisorStopPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("janitor and management readers share one anchor (#2698)", () => {
  it("classifies a pid-lock-less live lane as spared, exactly as discovery resolves it", async () => {
    const root = scratch();
    try {
      // The janitor probes liveness with the real `process.kill`, so this lane is
      // anchored on THIS process — a pid both readers can independently prove
      // alive. Discovery gets the matching identity seams injected.
      const paths = lane(root, fleetSnapshot({ pid: process.pid, startTime: "own-boot" }));

      const report = await collectTmpJanitorReport(
        paths.tmpDir,
        Date.now(),
        () => "UNKNOWN",
      );

      expect(report.staleSupervisors.reclaim).toEqual([]);
      expect(report.staleSupervisors.spare.map((entry) => entry.path)).toContain(
        paths.supervisorRuntimeDir,
      );
      expect(
        await discoverLiveSupervisorPid(
          paths.supervisorRuntimeDir,
          (pid) => pid === process.pid,
          { pidStartTime: () => "own-boot" },
        ),
      ).toMatchObject({ pid: process.pid, source: "fleet-state" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
