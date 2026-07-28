import { describe, expect, it } from "vitest";
import {
  detectFleetScopeProbes,
  fleetScopeUnitName,
  planFleetScope,
  readFleetScopeSettings,
  readSelfCgroupScope,
  type FleetScopeProbes,
} from "../src/runtime/fleet-scope.js";
import { loadConfig } from "../src/core/config.js";

const linux: FleetScopeProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
};

const settings = { enabled: true, memoryHigh: "70%" };

function plan(overrides: Partial<Parameters<typeof planFleetScope>[0]> = {}) {
  return planFleetScope({
    fleet: "default",
    command: "/usr/bin/node",
    args: ["dev.bundle.min.mjs", "__supervise", "--fleet", "default"],
    settings,
    probes: linux,
    salt: 4242,
    ...overrides,
  });
}

describe("planFleetScope", () => {
  it("runs the supervisor in a transient scope with Delegate=yes and the configured MemoryHigh", () => {
    const result = plan();

    expect(result.isolated).toBe(true);
    expect(result.command).toBe("/usr/bin/systemd-run");
    expect(result.args).toContain("--user");
    expect(result.args).toContain("--scope");
    expect(result.args).toContain("--property=Delegate=yes");
    expect(result.args).toContain("--property=MemoryHigh=70%");
    expect(result.args).toContain(`--unit=${result.unit}`);
    // The real command follows the `--` separator, unchanged.
    expect(result.args.slice(result.args.indexOf("--") + 1)).toEqual([
      "/usr/bin/node",
      "dev.bundle.min.mjs",
      "__supervise",
      "--fleet",
      "default",
    ]);
    expect(result.warning).toBeUndefined();
  });

  it("omits MemoryHigh when the configured value is empty", () => {
    const result = plan({ settings: { enabled: true, memoryHigh: "" } });

    expect(result.isolated).toBe(true);
    expect(result.args.some((a) => a.startsWith("--property=MemoryHigh"))).toBe(false);
  });

  it("launches directly AND warns when there is no systemd user session", () => {
    const result = plan({ probes: { ...linux, userSession: false } });

    expect(result.isolated).toBe(false);
    expect(result.command).toBe("/usr/bin/node");
    expect(result.args[0]).toBe("dev.bundle.min.mjs");
    expect(result.warning).toContain("no systemd --user session");
  });

  it("launches directly AND warns when systemd-run is not on PATH", () => {
    const result = plan({ probes: { ...linux, systemdRun: null } });

    expect(result.isolated).toBe(false);
    expect(result.warning).toContain("systemd-run is not on PATH");
  });

  it("launches directly AND warns off Linux", () => {
    const result = plan({ probes: { platform: "darwin", systemdRun: null, userSession: false } });

    expect(result.isolated).toBe(false);
    expect(result.warning).toContain("Linux-only");
  });

  it("launches directly AND warns when isolation is switched off", () => {
    const result = plan({ settings: { enabled: false, memoryHigh: "70%" } });

    expect(result.isolated).toBe(false);
    expect(result.warning).toContain("disabled by config");
  });

  it("derives the scope name from the fleet name, so two named fleets get two scopes", () => {
    const a = plan({ fleet: "default" });
    const b = plan({ fleet: "nightly" });

    expect(a.unit).not.toBe(b.unit);
    expect(a.unit).toContain("red-fleet-default");
    expect(b.unit).toContain("red-fleet-nightly");
  });
});

describe("fleetScopeUnitName", () => {
  it("produces a valid .scope unit name from an awkward fleet name", () => {
    const unit = fleetScopeUnitName("Nightly Fleet/2!", 7);

    expect(unit).toBe("red-fleet-nightly-fleet-2-7.scope");
  });

  it("falls back to the default lane for an empty fleet name", () => {
    expect(fleetScopeUnitName("", 7)).toBe("red-fleet-default-7.scope");
  });

  it("varies with the salt so a relaunch cannot collide with the live unit", () => {
    expect(fleetScopeUnitName("default", 1)).not.toBe(fleetScopeUnitName("default", 2));
  });
});

describe("readFleetScopeSettings", () => {
  const defaults = loadConfig("/nonexistent/.red/config.yaml", {
    ignoreActivationGate: true,
    warn: () => undefined,
  });

  it("defaults to enabled with a documented MemoryHigh", () => {
    expect(readFleetScopeSettings(defaults, {})).toEqual({ enabled: true, memoryHigh: "70%" });
  });

  it("reads plugins.dev.afk.fleet.scope.* from .red/config.yaml", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      ignoreActivationGate: true,
      warn: () => undefined,
      read: () =>
        "plugins:\n  dev:\n    afk:\n      fleet:\n        scope:\n          enabled: false\n          memory_high: 6G\n",
    });

    expect(readFleetScopeSettings(values, {})).toEqual({ enabled: false, memoryHigh: "6G" });
  });

  it("lets the environment kill-switch and MemoryHigh override the config", () => {
    expect(readFleetScopeSettings(defaults, { RED_AFK_FLEET_SCOPE: "off" }).enabled).toBe(false);
    expect(readFleetScopeSettings(defaults, { RED_AFK_FLEET_SCOPE_MEMORY_HIGH: "4G" }).memoryHigh)
      .toBe("4G");
  });
});

describe("detectFleetScopeProbes", () => {
  it("reports no isolation support off Linux without touching the filesystem", () => {
    expect(detectFleetScopeProbes({ XDG_RUNTIME_DIR: "/run/user/1000" }, "darwin")).toEqual({
      platform: "darwin",
      systemdRun: null,
      userSession: false,
    });
  });

  it("reports no user session when XDG_RUNTIME_DIR is unset", () => {
    expect(detectFleetScopeProbes({ PATH: "" }, "linux").userSession).toBe(false);
  });
});

describe("readSelfCgroupScope (#2707)", () => {
  it("names the transient scope that actually holds this process", () => {
    const cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/red-fleet-main-4242.scope\n";
    expect(readSelfCgroupScope(() => cgroup)).toBe("red-fleet-main-4242.scope");
  });

  it("omits the attribution rather than naming a cgroup that does not hold us", () => {
    // A fleet whose scope was declined by the host runs in the caller's slice —
    // the record must say nothing instead of repeating the launcher's intent.
    expect(readSelfCgroupScope(() => "0::/user.slice/user-1000.slice\n")).toBeUndefined();
    expect(
      readSelfCgroupScope(() => {
        throw new Error("ENOENT /proc/self/cgroup");
      }),
    ).toBeUndefined();
  });
});
