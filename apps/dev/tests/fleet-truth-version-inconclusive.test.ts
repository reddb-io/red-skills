/**
 * A missing measurement is not a failed one (#2752).
 *
 * Five worker boots session-errored on a supervisor whose every liveness signal
 * was green — live pid, 63s heartbeat against a 300s threshold — because the one
 * red input was `version_unknown`: the watchdog respawn path stamped a fresh
 * fleet state without `bundle_version`, and the probe read absence as fault.
 *
 * The split these tests pin:
 *   1. a KNOWN version that skews stays red — a measured fault, unchanged;
 *   2. an UNKNOWN version is inconclusive — logged, surfaced, never red, and a
 *      worker boots straight through it;
 *   3. the pid file, which nobody rewrites after boot, cannot age a supervisor
 *      out while its heartbeat is fresh;
 *   4. the respawn path stamps the version, so the field stops being absent;
 *   5. the probe and `fleet_status` read one version from one snapshot — two
 *      readers, one answer.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectFleetTruthProbeInput,
  runFleetTruthProbe,
  type FleetTruthProbeData,
} from "../src/core/operational-probes/fleet-truth.js";
import { stampFreshFleetHeartbeat } from "../src/runtime/supervisor-spawn.js";
import { readFleetState } from "../src/runtime/wire/monitor.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { makeDeps, options, runBoot } from "./boot.helpers.js";

const LIVE_SUPERVISOR_PID = 2_247_922;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "red-skills-fleet-truth-version-"));
}

/** The reported field set: live supervisor, 63s heartbeat, 300s threshold. */
function healthyProbeInput(over: Record<string, unknown> = {}) {
  return {
    supervisorPid: LIVE_SUPERVISOR_PID,
    ownSupervisorPid: 777,
    supervisorPidLive: true,
    nowMs: 3_600_000,
    heartbeatEpochMs: 3_600_000 - 63_000,
    stateMtimeMs: 3_600_000 - 62_000,
    supervisorPidMtimeMs: 3_600_000 - 62_000,
    heartbeatStaleMs: 300_000,
    latestBundleVersion: "2.87.5",
    ...over,
  };
}

function probeData(result: { data?: unknown }): FleetTruthProbeData {
  return result.data as FleetTruthProbeData;
}

describe("an unknown supervisor bundle version is inconclusive, never red", () => {
  it("stays green with a live pid and a fresh heartbeat, and still says so", () => {
    const result = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: healthyProbeInput(),
    });

    expect(result.verdict).toBe("ok");
    expect(probeData(result).findings).toEqual([]);
    expect(probeData(result).notes).toEqual(["version-unknown"]);
    // Inconclusive is reported, not swallowed.
    expect(result.evidence).toContain("version_unknown inconclusive");
  });

  it("lets a worker session boot instead of session-erroring it", async () => {
    const { deps } = makeDeps();
    const logged: string[] = [];

    const result = await runBoot(
      { ...deps, log: (line: string) => logged.push(line) },
      options({
        skipSweeps: true,
        operationalProbes: {
          remoteUrls: ["git@github.com:reddb-io/red-skills.git"],
          fleetTruth: healthyProbeInput(),
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(result.operationalProbes?.findings).toEqual([]);
    expect(logged.join("\n")).toContain("version_unknown inconclusive");
  });

  it("still reds a KNOWN version that skews from latest", () => {
    const result = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: healthyProbeInput({ bundleVersion: "2.86.0" }),
    });

    expect(result.verdict).toBe("red");
    expect(probeData(result).findings).toEqual(["version-skew"]);
    expect(result.evidence).toContain("version_skew bundle=2.86.0 latest=2.87.5");
  });

  it("ignores a stale pid-file mtime while the heartbeat is fresh", () => {
    // The reported 20:00 UTC fleet: state 73s old, pid file 63 minutes old
    // because nothing rewrites it after boot.
    const result = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: healthyProbeInput({
        bundleVersion: "2.87.5",
        heartbeatEpochMs: 3_600_000 - 74_000,
        stateMtimeMs: 3_600_000 - 73_000,
        supervisorPidMtimeMs: 3_600_000 - 3_786_000,
      }),
    });

    expect(result.verdict).toBe("ok");
    expect(result.evidence).toContain("heartbeat_age=74s");
  });
});

describe("the version stops being absent at its source", () => {
  it("stamps the supervisor's bundle version on the watchdog respawn path", async () => {
    const root = scratch();
    try {
      const statePath = join(root, "state.toon");

      stampFreshFleetHeartbeat(statePath, 1_700_000_000, "claude", 3, "2.87.5");

      expect(readFileSync(statePath, "utf8")).toContain("2.87.5");
      const fleet = await readFleetState(statePath);
      expect(fleet?.bundleVersion).toBe("2.87.5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults the stamp to the running bundle so no caller can omit it", async () => {
    const root = scratch();
    try {
      const statePath = join(root, "state.toon");

      stampFreshFleetHeartbeat(statePath, 1_700_000_000, "claude", 3);

      const fleet = await readFleetState(statePath);
      expect(fleet?.bundleVersion).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives the probe and fleet_status the same version from one snapshot", async () => {
    const root = scratch();
    try {
      const pidPath = join(root, "afk-supervisor.pid");
      const statePath = join(root, "afk-supervisor.state.toon");
      writeFileSync(pidPath, `${LIVE_SUPERVISOR_PID}\n`, "utf8");
      stampFreshFleetHeartbeat(statePath, 1_700_000_000, "claude", 3, "2.87.5");

      const facts = await collectFleetTruthProbeInput(
        { supervisorPidPath: pidPath, fleetStatePath: statePath },
        {
          nowMs: 1_700_000_060_000,
          heartbeatStaleMs: 300_000,
          latestBundleVersion: "2.87.5",
          ownSupervisorPid: 777,
          pidLive: (pid) => pid === LIVE_SUPERVISOR_PID,
        },
      );
      const fleet = await readFleetState(statePath);

      // The two readers of one fact must not disagree (ADR 0128).
      expect(facts.bundleVersion).toBe(fleet?.bundleVersion);
      const result = runFleetTruthProbe({ remoteUrls: [], fleetTruth: facts });
      expect(result.verdict).toBe("ok");
      expect(probeData(result).notes).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A snapshot written by an older bundle carries no version; it must read as
// unknown, never as a match with latest.
describe("a legacy snapshot without bundle_version", () => {
  it("is read as unknown by the probe", async () => {
    const root = scratch();
    try {
      const pidPath = join(root, "afk-supervisor.pid");
      const statePath = join(root, "afk-supervisor.state.toon");
      writeFileSync(pidPath, `${LIVE_SUPERVISOR_PID}\n`, "utf8");
      writeFileSync(
        statePath,
        encodeDevSnapshotToon({
          ts: "2026-07-28T20:00:00.000Z",
          epoch: 1_700_000_000,
          runner: "claude",
          ready_for_agent: 0,
          slots: { busy: 0, free: 3, total: 3, parked: 0 },
          spawns_this_tick: 0,
        }),
        "utf8",
      );

      const facts = await collectFleetTruthProbeInput(
        { supervisorPidPath: pidPath, fleetStatePath: statePath },
        {
          nowMs: 1_700_000_060_000,
          heartbeatStaleMs: 300_000,
          latestBundleVersion: "2.87.5",
          ownSupervisorPid: 777,
          pidLive: (pid) => pid === LIVE_SUPERVISOR_PID,
        },
      );
      const result = runFleetTruthProbe({ remoteUrls: [], fleetTruth: facts });

      expect(facts.bundleVersion).toBeUndefined();
      expect(result.verdict).toBe("ok");
      expect(probeData(result).notes).toEqual(["version-unknown"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
