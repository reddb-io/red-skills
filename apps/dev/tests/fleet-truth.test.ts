import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFleetTruthFix,
  collectFleetTruthProbeInput,
  runFleetTruthProbe,
  terminateSupervisorPid,
} from "../src/core/operational-probes/fleet-truth.js";

const children: number[] = [];

afterEach(async () => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
});

describe("fleet truth operational probe", () => {
  it("finds pid-live stale-heartbeat zombies with mtimes and ages", async () => {
    const result = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: {
        supervisorPid: 1234,
        supervisorPidLive: true,
        supervisorPidMtimeMs: 1_000,
        stateMtimeMs: 2_000,
        heartbeatEpochMs: 1_500,
        nowMs: 601_500,
        heartbeatStaleMs: 300_000,
        bundleVersion: "2.62.0",
        latestBundleVersion: "2.62.0",
      },
    });

    expect(result.verdict).toBe("red");
    expect(result.evidence).toContain("pid=1234");
    expect(result.evidence).toContain("heartbeat_age=600s");
    expect(result.evidence).toContain("pid_mtime_age=600s");
    expect(result.evidence).toContain("state_mtime_age=599s");
    expect(result.fix?.gate).toBe("confirm");
  });

  it("reports version skew and absent stamps distinctly", () => {
    const skew = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: {
        supervisorPid: 42,
        supervisorPidLive: true,
        nowMs: 10_000,
        heartbeatStaleMs: 300_000,
        heartbeatEpochMs: 9_000,
        bundleVersion: "2.62.0",
        latestBundleVersion: "2.63.0",
      },
    });
    expect(skew.verdict).toBe("red");
    expect(skew.evidence).toContain("version_skew");
    expect(skew.evidence).toContain("bundle=2.62.0 latest=2.63.0");

    const unknown = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: {
        supervisorPid: 42,
        supervisorPidLive: true,
        nowMs: 10_000,
        heartbeatStaleMs: 300_000,
        heartbeatEpochMs: 9_000,
        latestBundleVersion: "2.63.0",
      },
    });
    expect(unknown.verdict).toBe("red");
    expect(unknown.evidence).toContain("version_unknown");
  });

  it("gates SIGTERM, verifies live process exit, and leaves refusal untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "red-skills-fleet-truth-"));
    const pidPath = join(dir, "afk-supervisor.pid");
    const statePath = join(dir, "afk-supervisor.state.json");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("child process did not expose pid");
    children.push(child.pid);

    await writeFile(pidPath, `${child.pid}\n`, "utf8");
    await writeFile(
      statePath,
      JSON.stringify({ epoch: 1, bundle_version: "2.62.0", runner: "codex", slots: { total: 2 } }),
      "utf8",
    );
    const stateStat = await stat(statePath);
    const facts = await collectFleetTruthProbeInput(
      { supervisorPidPath: pidPath, fleetStatePath: statePath },
      {
        nowMs: stateStat.mtimeMs + 601_000,
        heartbeatStaleMs: 300_000,
        latestBundleVersion: "2.62.0",
      },
    );
    const finding = runFleetTruthProbe({ remoteUrls: [], fleetTruth: facts });

    const declined = await applyFleetTruthFix(finding, {
      confirm: async () => false,
      terminateSupervisor: terminateSupervisorPid,
    });
    expect(declined.status).toBe("declined");
    expect(process.kill(child.pid, 0)).toBe(true);

    const applied = await applyFleetTruthFix(finding, {
      confirm: async () => true,
      confirmRelaunch: async () => false,
      terminateSupervisor: terminateSupervisorPid,
    });
    expect(applied.status).toBe("applied");
    expect(applied.evidence).toContain("supervisor pid exited");
    await expect(async () => process.kill(child.pid!, 0)).rejects.toThrow();
    children.splice(children.indexOf(child.pid), 1);
  });
});
