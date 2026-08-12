// Where an AUTO-SPAWNED daemon is born, and how a host reports where the one it
// already has ended up.
//
// The defect (#3657): auto-spawn forked the daemon as a child of whichever
// client first touched the socket, so on a desktop the whole host daemon lived
// inside `app-gnome-<terminal>-….scope`. systemd-oomd kills a CGROUP, not a
// process, so closing — or pressuring — the terminal took the daemon and every
// Worker with it. The cure is a resource group of the daemon's own.
import { describe, expect, it } from "vitest";
import {
  classifyDaemonCgroup,
  detectDaemonPlacementProbes,
  daemonPlacementEnabled,
  planRedskilledDaemonPlacement,
  redskilledDaemonScopeName,
  REDSKILLED_DAEMON_PLACEMENT_ENV,
  type DaemonPlacementProbes,
} from "../src/daemon-placement.js";

const SESSION = "0123456789ab";

const SYSTEMD_HOST: DaemonPlacementProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
};

function plan(probes: DaemonPlacementProbes, overrides: { readonly enabled?: boolean } = {}) {
  return planRedskilledDaemonPlacement({
    command: "/usr/bin/node",
    args: ["/bundles/redskilled.bundle.min.mjs", "serve", "--socket", "/run/user/1000/red/redskilled.sock"],
    sessionKeyHash: SESSION,
    probes,
    ...overrides,
  });
}

describe("auto-spawn placement", () => {
  it("puts the daemon in a transient scope of its own, under the user's app slice", () => {
    const placed = plan(SYSTEMD_HOST);

    expect(placed.isolated).toBe(true);
    expect(placed.backend).toBe("transient-scope");
    expect(placed.scope).toBe(`redskilled-${SESSION}.scope`);
    expect(placed.command).toBe("/usr/bin/systemd-run");
    expect(placed.args.slice(0, placed.args.indexOf("--"))).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=redskilled-${SESSION}.scope`,
      "--slice=app.slice",
    ]);
    // Everything after `--` is the daemon argv, verbatim and in order.
    expect(placed.args.slice(placed.args.indexOf("--") + 1)).toEqual([
      "/usr/bin/node",
      "/bundles/redskilled.bundle.min.mjs",
      "serve",
      "--socket",
      "/run/user/1000/red/redskilled.sock",
    ]);
    expect(placed.warning).toBeUndefined();
  });

  it("names one scope per session location, so two runtime dirs never collide", () => {
    expect(redskilledDaemonScopeName("aaaaaaaaaaaa")).toBe("redskilled-aaaaaaaaaaaa.scope");
    expect(redskilledDaemonScopeName("bbbbbbbbbbbb")).not.toBe(redskilledDaemonScopeName("aaaaaaaaaaaa"));
  });

  it("degrades to the caller's own group, loudly, when systemd-run is not on PATH", () => {
    const fallback = plan({ ...SYSTEMD_HOST, systemdRun: null });

    expect(fallback.isolated).toBe(false);
    expect(fallback.backend).toBe("none");
    expect(fallback.command).toBe("/usr/bin/node");
    expect(fallback.args[0]).toBe("/bundles/redskilled.bundle.min.mjs");
    expect(fallback.warning).toMatch(/systemd-run is not on PATH/);
    // The blast radius is the point of the sentence, not an aside.
    expect(fallback.warning).toMatch(/dies with it/);
  });

  it("degrades with a sentence when there is no systemd --user session", () => {
    const fallback = plan({ ...SYSTEMD_HOST, userSession: false });

    expect(fallback.isolated).toBe(false);
    expect(fallback.warning).toMatch(/no systemd --user session/);
  });

  it("degrades with a sentence on a platform that has no transient scopes at all", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const fallback = plan({ platform, systemdRun: null, userSession: false });
      expect(fallback.isolated).toBe(false);
      expect(fallback.warning).toContain(`platform=${platform}`);
    }
  });

  it("obeys the kill-switch, and still says what the caller now carries", () => {
    const off = plan(SYSTEMD_HOST, { enabled: false });

    expect(off.isolated).toBe(false);
    expect(off.command).toBe("/usr/bin/node");
    expect(off.warning).toContain(REDSKILLED_DAEMON_PLACEMENT_ENV);
  });

  it("reads the kill-switch the way every other one in this app is read", () => {
    expect(daemonPlacementEnabled({})).toBe(true);
    expect(daemonPlacementEnabled({ [REDSKILLED_DAEMON_PLACEMENT_ENV]: "" })).toBe(true);
    expect(daemonPlacementEnabled({ [REDSKILLED_DAEMON_PLACEMENT_ENV]: "off" })).toBe(false);
    expect(daemonPlacementEnabled({ [REDSKILLED_DAEMON_PLACEMENT_ENV]: "0" })).toBe(false);
    expect(daemonPlacementEnabled({ [REDSKILLED_DAEMON_PLACEMENT_ENV]: "no" })).toBe(false);
  });

  it("probes a non-Linux host without pretending it has systemd", () => {
    const probes = detectDaemonPlacementProbes({ PATH: "/usr/bin" }, "darwin");
    expect(probes).toEqual({ platform: "darwin", systemdRun: null, userSession: false });
  });
});

describe("where the daemon actually ended up", () => {
  it("reads its own transient scope as isolated", () => {
    const verdict = classifyDaemonCgroup(
      `/user.slice/user-1000.slice/user@1000.service/app.slice/redskilled-${SESSION}.scope`,
    );
    expect(verdict.placement).toBe("own-unit");
  });

  it("reads the installed supervisor unit as isolated too", () => {
    const verdict = classifyDaemonCgroup("/user.slice/user-1000.slice/user@1000.service/app.slice/redskilled.service");
    expect(verdict.placement).toBe("own-unit");
  });

  it("names the terminal scope it found the daemon inside, and what kills it there", () => {
    const verdict = classifyDaemonCgroup(
      "/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-wezterm-4242.scope",
    );

    expect(verdict.placement).toBe("shared-group");
    expect(verdict.reason).toContain("app-gnome-wezterm-4242.scope");
    expect(verdict.reason).toMatch(/memory pressure|oomd/i);
  });

  it("reads a login session scope as shared too — a login ends like a terminal does", () => {
    expect(classifyDaemonCgroup("/user.slice/user-1000.slice/session-3.scope").placement).toBe("shared-group");
  });

  it("says `unknown` rather than guessing when there is no cgroup to read", () => {
    for (const path of [null, "", "/"]) {
      const verdict = classifyDaemonCgroup(path);
      expect(verdict.placement).toBe("unknown");
      expect(verdict.reason).not.toBe("");
    }
  });
});
