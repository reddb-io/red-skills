/**
 * The watchdog respawn stamps the supervisor's bundle version (#2752).
 *
 * A respawn writes a placeholder heartbeat so the next watchdog pass does not
 * double-fire while the new supervisor boots. That placeholder carried no
 * `bundle_version`, so for the whole boot window every worker probing the lane
 * read `version_unknown` — a field absent only because the writer never wrote it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const LIVE_PID = 515_151;
const SPAWNED_PID = 626_262;

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

// Only the spawn is modeled. `stampFreshFleetHeartbeat` is deliberately REAL —
// it is the writer under test.
vi.mock("../src/runtime/supervisor-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/supervisor-spawn.js")>();
  return { ...actual, spawnSupervisor: vi.fn(async () => SPAWNED_PID) };
});

import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { runFleetTruthProbe, collectFleetTruthProbeInput } from "../src/core/operational-probes/fleet-truth.js";
import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
import { buildWatchdogIO } from "../src/runtime/watchdog-io.js";
import { readFleetState } from "../src/runtime/wire/monitor.js";
import { afkPaths } from "../src/runtime/wire.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-relaunch-version-"));
}

function sink(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

describe("the watchdog relaunch leaves a version behind", () => {
  it("stamps bundle_version into the fresh fleet state", async () => {
    const root = scratch();
    try {
      const paths = afkPaths(root);
      mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
      const epoch = Math.floor(Date.now() / 1_000) - 5;
      writeFileSync(
        paths.fleetStatePath,
        encodeDevSnapshotToon({
          ts: new Date(epoch * 1_000).toISOString(),
          epoch,
          runner: "claude",
          target: 2,
          pid: LIVE_PID,
          pid_start_time: `start-${LIVE_PID}`,
          ready_for_agent: 3,
          slots: { busy: 0, free: 2, total: 2, parked: 0 },
          slot_pids: [],
          spawns_this_tick: 0,
        }),
        "utf8",
      );
      vi.mocked(spawnSupervisor).mockImplementation(async () => {
        writeFileSync(paths.supervisorPidPath, String(SPAWNED_PID), "utf8");
        writeFileSync(paths.supervisorPidStartPath, `start-${SPAWNED_PID}`, "utf8");
        return SPAWNED_PID;
      });

      const io = buildWatchdogIO(root, sink());
      await io.liveness();
      expect(await io.relaunch()).toBe(true);

      const fleet = await readFleetState(paths.fleetStatePath);
      expect(fleet?.bundleVersion).toBeTruthy();
      expect(readFileSync(paths.fleetStatePath, "utf8")).toContain("bundle_version");

      // The probe a booting worker runs now resolves a version from that stamp,
      // so the respawn window no longer reads as unknown.
      const facts = await collectFleetTruthProbeInput(
        { supervisorPidPath: paths.supervisorPidPath, fleetStatePath: paths.fleetStatePath },
        {
          heartbeatStaleMs: 300_000,
          latestBundleVersion: fleet?.bundleVersion,
          ownSupervisorPid: 777,
          pidLive: (pid) => pid === SPAWNED_PID,
        },
      );
      expect(facts.bundleVersion).toBe(fleet?.bundleVersion);
      const result = runFleetTruthProbe({ remoteUrls: [], fleetTruth: facts });
      expect(result.verdict).toBe("ok");
      expect((result.data as { notes: string[] }).notes).toEqual([]);
    } finally {
      vi.mocked(spawnSupervisor).mockReset();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
