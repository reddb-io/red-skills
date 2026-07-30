import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { readPidStartTime } from "../src/core/state.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { afkPaths } from "../src/runtime/wire.js";
import { supervisorWatchdogCommand } from "../src/commands/supervisor-watchdog.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pinnedPid(pidPath: string, startPath: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    const start = readFileSync(startPath, "utf8").trim();
    return Number.isSafeInteger(pid) && pid > 0 && live(pid) && readPidStartTime(pid) === start
      ? pid
      : null;
  } catch {
    return null;
  }
}

async function waitFor<T>(probe: () => T | null, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for integration condition");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent supervisor watchdog command (#2442)", () => {
  it("reclaims a watchdog pid reused by an unrelated live process", async () => {
    const root = mkdtempSync(join(tmpdir(), "supervisor-watchdog-owner-"));
    roots.push(root);
    const paths = afkPaths(root);
    mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(unrelated);
    const unrelatedPid = await waitFor(() => unrelated.pid ?? null);
    writeFileSync(paths.supervisorWatchdogPidPath, String(unrelatedPid), "utf8");
    writeFileSync(paths.supervisorWatchdogPidStartPath, "recycled-start", "utf8");
    writeFileSync(paths.supervisorStopPath, "stop", "utf8");

    await expect(supervisorWatchdogCommand([], root)).resolves.toBe(0);

    expect(existsSync(paths.supervisorWatchdogPidPath)).toBe(false);
    expect(existsSync(paths.supervisorWatchdogPidStartPath)).toBe(false);
  });

  it("respawns a real steady-state supervisor and reconciles its dead claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "supervisor-watchdog-integration-"));
    roots.push(root);
    const paths = afkPaths(root);
    const bin = join(root, "bin");
    const claim = join(paths.claimsDir, "2442");
    mkdirSync(bin, { recursive: true });
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "pid"), "999999999", "utf8");

    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
case "$*" in
  *"repo view"*) printf 'owner/repo\\n' ;;
  *"issue view 2442"*) printf '{"labels":[{"name":"running"}]}\\n' ;;
  *"issue edit 2442"*) touch "$PWD/.claim-reconciled" ;;
  *"issue list"*)
    if [ -f "$PWD/.ready-once" ]; then
      rm -f "$PWD/.ready-once"
      printf '[{"number":2442}]\\n'
    else
      printf '[]\\n'
    fi
    ;;
  *) printf '[]\\n' ;;
esac
`,
      "utf8",
    );
    chmodSync(gh, 0o755);

    const cli = join(root, "dev-cli.mjs");
    buildSync({
      entryPoints: [join(process.cwd(), "src", "cli.ts")],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      define: {
        __RED_BUILD_VERSION__: JSON.stringify("0.0.0-test"),
        __RED_BUILD_GIT_SHA__: JSON.stringify("test"),
        __RED_BUILD_TIME__: JSON.stringify("2026-07-22T00:00:00.000Z"),
        __RED_BUNDLE_ASSET__: JSON.stringify("dev.bundle.min.mjs"),
        __REDDB_SDK_VERSION__: JSON.stringify(""),
        __REDDB_BINARY_TAG__: JSON.stringify(""),
      },
    });
    // The watchdog's respawn reaches the host daemon before it launches anything
    // (#2851), so this integration needs a REAL one. Bundling it beside the dev
    // CLI is how the shipped resolver finds it, and the session key is pinned to
    // this sandbox so the walk can never be served by a stranger's daemon — nor
    // leave one behind for the next test.
    buildSync({
      entryPoints: [join(process.cwd(), "tests", "fixtures", "mcp-lane-canary", "redskilled-entry.ts")],
      outfile: join(root, "redskilled.bundle.min.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    });

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REDSKILLED_SESSION: `watchdog-integration-${process.pid}`,
      RED_AFK_POLL_S: "1",
      RED_AFK_WAKE_FALLBACK_S: "1",
      RED_AFK_TARGET: "1",
      RED_AFK_RUNNER: "codex",
    };

    const supervisor = spawn(process.execPath, [cli, "__supervise"], {
      cwd: root,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(supervisor);
    let supervisorStderr = "";
    supervisor.stderr?.on("data", (chunk) => {
      supervisorStderr += String(chunk);
    });
    const firstPid = await waitFor(() => {
      if (supervisor.exitCode !== null) {
        throw new Error(`real supervisor exited during startup: ${supervisorStderr}`);
      }
      return pinnedPid(paths.supervisorPidPath, paths.supervisorPidStartPath);
    });
    const epoch = Math.floor(Date.now() / 1000);
    writeFileSync(
      paths.fleetStatePath,
      encodeDevSnapshotToon({
        ts: new Date(epoch * 1000).toISOString(),
        epoch,
        last_progress_epoch: epoch,
        target: 1,
        runner: "codex",
        ready_for_agent: 0,
        slots: { busy: 0, free: 1, total: 1, parked: 0 },
        slot_pids: [],
        spawns_this_tick: 0,
      }),
      "utf8",
    );

    const watchdog = spawn(process.execPath, [cli, "__watchdog"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(watchdog);
    let watchdogOutput = "";
    watchdog.stdout?.on("data", (chunk) => {
      watchdogOutput += String(chunk);
    });
    watchdog.stderr?.on("data", (chunk) => {
      watchdogOutput += String(chunk);
    });
    await waitFor(() => {
      if (watchdog.exitCode !== null || watchdog.signalCode !== null) {
        throw new Error(`watchdog exited during startup: ${watchdogOutput}`);
      }
      return pinnedPid(paths.supervisorWatchdogPidPath, paths.supervisorWatchdogPidStartPath);
    });

    writeFileSync(join(root, ".ready-once"), "1", "utf8");
    const supervisorExit = once(supervisor, "exit");
    const killedAt = Date.now();
    supervisor.kill("SIGKILL");
    await supervisorExit;

    let replacementPid: number;
    try {
      replacementPid = await waitFor(() => {
        if (watchdog.exitCode !== null || watchdog.signalCode !== null) {
          throw new Error(`watchdog exited before recovery: ${watchdogOutput}`);
        }
        const pid = pinnedPid(paths.supervisorPidPath, paths.supervisorPidStartPath);
        return pid !== null && pid !== firstPid ? pid : null;
      }, 5_000);
    } catch (error) {
      throw new Error(`${String(error)}; watchdog output: ${watchdogOutput}`);
    }
    expect(Date.now() - killedAt).toBeLessThanOrEqual(5_000);
    await waitFor(() => (!existsSync(claim) ? true : null), 60_000);
    expect(existsSync(join(root, ".claim-reconciled"))).toBe(true);

    expect(replacementPid).not.toBe(firstPid);
    expect(pinnedPid(paths.supervisorWatchdogPidPath, paths.supervisorWatchdogPidStartPath))
      .not.toBeNull();

    process.kill(replacementPid, "SIGKILL");
  }, 120_000);
});
