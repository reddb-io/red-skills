// Named multi-fleet substrate (#2304): two named fleets must resolve to disjoint
// supervisor runtime lanes with independent pid locks, and discovering one
// fleet's supervisor must never report another fleet's pid.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetRegistryValidationError } from "@reddb-io/red-castle/engine";
import { afkPaths } from "../src/runtime/wire.js";
import { discoverLiveSupervisorPid } from "../src/runtime/supervisor-state.js";
import { parseFleetFlag, resolveFleetFromArgs, FLEET_NAME_ENV } from "../src/core/fleet-name.js";
import { slotFilterArgs } from "../src/commands/supervise.js";
import { parseRunFlags } from "../src/commands/run/flags.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-named-fleet-"));
}

/** Seed a fleet's runtime lane with a pid file. */
function seedPidFile(root: string, fleet: string, pid: number): string {
  const paths = afkPaths(root, fleet);
  mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
  writeFileSync(paths.supervisorPidPath, String(pid), "utf8");
  writeFileSync(paths.supervisorPidStartPath, `start-${pid}`, "utf8");
  return paths.supervisorRuntimeDir;
}

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
const pinnedStart = (pid: number) => `start-${pid}`;

describe("afkPaths — named fleet lanes", () => {
  it("defaults to the `default` lane when unnamed", () => {
    const paths = afkPaths("/repo");
    expect(paths.fleet).toBe("default");
    expect(paths.supervisorRuntimeDir).toBe("/repo/.red/tmp/supervisors/default");
  });

  it("gives two named fleets disjoint supervisor runtime lanes", () => {
    const alpha = afkPaths("/repo", "alpha");
    const beta = afkPaths("/repo", "beta");
    expect(alpha.supervisorRuntimeDir).toBe("/repo/.red/tmp/supervisors/alpha");
    expect(beta.supervisorRuntimeDir).toBe("/repo/.red/tmp/supervisors/beta");
    for (const key of [
      "supervisorPidPath",
      "supervisorStopPath",
      "supervisorResizePath",
      "fleetStatePath",
      "fleetFirehosePath",
      "supervisorRestartsPath",
      "runnerCircuitDir",
    ] as const) {
      expect(alpha[key], key).not.toBe(beta[key]);
    }
  });

  it("keeps the repo-wide lanes shared across fleets", () => {
    const alpha = afkPaths("/repo", "alpha");
    const beta = afkPaths("/repo", "beta");
    // The 3-layer claim coordinates across these — partitioning them would let
    // two fleets claim the same issue.
    expect(alpha.claimsDir).toBe(beta.claimsDir);
    expect(alpha.workersRoot).toBe(beta.workersRoot);
    expect(alpha.landLockPath).toBe(beta.landLockPath);
  });

  it("refuses a fleet name that would escape the supervisors dir", () => {
    expect(() => afkPaths("/repo", "../escape")).toThrow(FleetRegistryValidationError);
  });
});

describe("fleet name resolution", () => {
  it("reads --fleet in both spellings and falls back to the env, then default", () => {
    expect(parseFleetFlag(["--fleet", "alpha"])).toBe("alpha");
    expect(parseFleetFlag(["--fleet=beta"])).toBe("beta");
    expect(parseFleetFlag(["--spec", "7"])).toBeUndefined();
    expect(() => parseFleetFlag(["--fleet"])).toThrow("--fleet requires a value");
    expect(resolveFleetFromArgs([], { [FLEET_NAME_ENV]: "gamma" })).toBe("gamma");
    expect(resolveFleetFromArgs(["--fleet", "alpha"], { [FLEET_NAME_ENV]: "gamma" })).toBe("alpha");
    expect(resolveFleetFromArgs([], {})).toBe("default");
  });
});

describe("discoverLiveSupervisorPid — per-fleet pid locks", () => {
  it("resolves each fleet's own live pid file independently", async () => {
    const root = scratch();
    const alphaDir = seedPidFile(root, "alpha", 111);
    const betaDir = seedPidFile(root, "beta", 222);
    const isLive = alive([111, 222]);

    expect(await discoverLiveSupervisorPid(alphaDir, isLive, { fleet: "alpha", pidStartTime: pinnedStart })).toMatchObject({
      pid: 111,
      source: "pid-file",
    });
    expect(await discoverLiveSupervisorPid(betaDir, isLive, { fleet: "beta", pidStartTime: pinnedStart })).toMatchObject({
      pid: 222,
      source: "pid-file",
    });
  });

  it("reports nothing for a fleet whose supervisor is dead, even while a sibling fleet runs", async () => {
    const root = scratch();
    const alphaDir = seedPidFile(root, "alpha", 111);
    seedPidFile(root, "beta", 222);
    expect(await discoverLiveSupervisorPid(alphaDir, alive([222]), { fleet: "alpha", pidStartTime: pinnedStart })).toBeNull();
  });

  it("never crosses fleets through the s<pid> lane-dir fallback", async () => {
    const root = scratch();
    const alphaDir = afkPaths(root, "alpha").supervisorRuntimeDir;
    const betaDir = afkPaths(root, "beta").supervisorRuntimeDir;
    mkdirSync(alphaDir, { recursive: true });
    // beta's supervisor lane exists and is live; alpha has no pid file at all.
    mkdirSync(join(betaDir, "s999"), { recursive: true });
    expect(await discoverLiveSupervisorPid(alphaDir, alive([999]), { fleet: "alpha" })).toBeNull();
    expect(await discoverLiveSupervisorPid(betaDir, alive([999]), { fleet: "beta" })).toMatchObject({
      pid: 999,
      source: "snapshot-dir",
    });
  });

  it("still honours the legacy flat s<pid> layout for the default fleet only", async () => {
    const root = scratch();
    const defaultDir = afkPaths(root, "default").supervisorRuntimeDir;
    const alphaDir = afkPaths(root, "alpha").supervisorRuntimeDir;
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(alphaDir, { recursive: true });
    // A pre-named-fleet supervisor lane, a sibling of the fleet dirs.
    mkdirSync(join(defaultDir, "..", "s777"), { recursive: true });
    expect(await discoverLiveSupervisorPid(defaultDir, alive([777]))).toMatchObject({
      pid: 777,
      source: "snapshot-dir",
    });
    expect(await discoverLiveSupervisorPid(alphaDir, alive([777]), { fleet: "alpha" })).toBeNull();
  });
});

describe("a fleet's selector survives launch → supervise → slot", () => {
  it("the supervisor forwards --selector into every slot's run --once", () => {
    const selector = JSON.stringify({ spec: 2303, lane: "go" });
    expect(slotFilterArgs(["--fleet", "alpha", "--selector", selector])).toEqual([
      "--selector",
      selector,
    ]);
    expect(slotFilterArgs([`--selector=${selector}`])).toEqual(["--selector", selector]);
  });

  it("run parses --selector back into the selector filter", () => {
    const parsed = parseRunFlags(["--selector", '{"spec":2303,"lane":"go"}']);
    expect(parsed.filter).toEqual({
      kind: "selector",
      selector: { spec: 2303, lane: "go" },
    });
  });

  it("rejects a --selector that is not a valid selector object", () => {
    expect(() => parseRunFlags(["--selector", "not-json"])).toThrow(/--selector requires a JSON object/);
    expect(() => parseRunFlags(["--selector", '{"spec":-1}'])).toThrow(/--selector is invalid/);
  });
});
