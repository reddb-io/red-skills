// The ratchet that keeps the daemon always on and the client unable to start one
// (ADR 0150 §4, issue #4022).
//
// The live assertions run against the real tree and the real unit renderer. The
// unit cases below prove the ratchet itself can fail — a guard that cannot go red
// is a guard that proves nothing.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderRedskilledUserUnit } from "@reddb-io/redskilled/provision";
import {
  ALWAYS_ON_DAEMON_SITES,
  CLIENT_SITE_PATHS,
  collectAlwaysOnDaemonFindings,
  formatAlwaysOnDaemonFailure,
  unitLifetimeViolations,
  type AlwaysOnDaemonSite,
} from "../src/core/always-on-daemon-guard.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const SITE: AlwaysOnDaemonSite = {
  path: "apps/redskilled/src/daemon/lifecycle.ts",
  what: "the idle timer",
  replacement: "nothing — the daemon runs until it is asked to stop",
};

describe("the daemon lifecycle holds no idle-exit path", () => {
  it("finds no idle reach in any declared site", () => {
    const findings = collectAlwaysOnDaemonFindings(REPO_ROOT);
    expect(formatAlwaysOnDaemonFailure(findings)).toBe("");
  });

  it("declares the modules the crossing emptied, each with its route", () => {
    const paths = ALWAYS_ON_DAEMON_SITES.map((site) => site.path);
    expect(paths).toContain("apps/redskilled/src/daemon/lifecycle.ts");
    expect(paths).toContain("apps/redskilled/src/client.ts");
    // The client is the only site that also may not spawn: the provisioner's
    // `daemon-birth.ts` is deliberately absent, because starting the daemon is
    // exactly the job it exists to do.
    expect(CLIENT_SITE_PATHS).toEqual(["apps/redskilled/src/client.ts"]);
    expect(paths).not.toContain("apps/redskilled/src/daemon-birth.ts");
    for (const site of ALWAYS_ON_DAEMON_SITES) {
      expect(site.what.trim()).not.toBe("");
      expect(site.replacement.trim()).not.toBe("");
    }
  });
});

describe("the provisioned unit has no idle timer", () => {
  it("renders a restart-always service with no lifetime knob", () => {
    const unit = renderRedskilledUserUnit({
      command: "/usr/bin/node /opt/redskilled.bundle.min.mjs",
      socketPath: "/run/user/1000/redskilled.sock",
    });

    expect(unitLifetimeViolations(unit)).toEqual([]);
    expect(unit).toContain("Restart=always");
    // The ExecStart is the whole of the daemon's argv, so an idle flag would be
    // visible right here — this is the assertion the flag's removal is for.
    expect(unit).not.toContain("--idle-ms");
    expect(unit).not.toContain("RuntimeMaxSec");
  });
});

describe("the ratchet can go red", () => {
  it("catches an idle timer reintroduced into the lifecycle", () => {
    const findings = collectAlwaysOnDaemonFindings(
      "/repo",
      [SITE],
      () => "  const idleMs = options.idleMs ?? 300_000;\n",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.match).toBe("idleMs");
    expect(formatAlwaysOnDaemonFailure(findings)).toContain("ADR 0143");
  });

  it("catches a spawn reintroduced into the client", () => {
    const findings = collectAlwaysOnDaemonFindings(
      "/repo",
      [{ ...SITE, path: "apps/redskilled/src/client.ts" }],
      () => 'import { spawn } from "node:child_process";\n',
    );
    expect(findings.map((finding) => finding.match)).toEqual(['from "node:child_process"']);
  });

  it("reads prose about the removed idle exit as documentation, not as a reach", () => {
    const findings = collectAlwaysOnDaemonFindings(
      "/repo",
      [SITE],
      () => "// The idleMs option and armIdleTimer were removed by ADR 0150 §4.\nconst live = true;\n",
    );
    expect(findings).toEqual([]);
  });

  it("fails a declared site that has been renamed out from under the list", () => {
    const findings = collectAlwaysOnDaemonFindings("/repo", [SITE], () => null);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.match).toBe("<missing>");
  });

  it("fails a unit that could stop or re-start the daemon on a timer", () => {
    expect(unitLifetimeViolations("[Service]\nRestart=always\nRuntimeMaxSec=300\n"))
      .toEqual([expect.stringContaining("RuntimeMaxSec")]);
    expect(unitLifetimeViolations("[Service]\nExecStart=/bin/redskilled serve --idle-ms 300000\nRestart=always\n"))
      .toEqual([expect.stringContaining("idle knob")]);
    expect(unitLifetimeViolations("[Service]\nExecStart=/bin/redskilled serve\nRestart=on-failure\n"))
      .toEqual([expect.stringContaining("Restart=always")]);
  });
});
