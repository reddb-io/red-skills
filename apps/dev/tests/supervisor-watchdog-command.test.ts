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
import { createRequire } from "node:module";
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

    const cli = join(process.cwd(), "src", "cli.ts");
    const tsxImport = createRequire(import.meta.url).resolve("tsx");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${tsxImport}`.trim(),
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
      stdio: "ignore",
    });
    children.push(watchdog);
    await waitFor(() =>
      pinnedPid(paths.supervisorWatchdogPidPath, paths.supervisorWatchdogPidStartPath),
    );

    writeFileSync(join(root, ".ready-once"), "1", "utf8");
    const supervisorExit = once(supervisor, "exit");
    supervisor.kill("SIGKILL");
    await supervisorExit;

    const replacementPid = await waitFor(() => {
      const pid = pinnedPid(paths.supervisorPidPath, paths.supervisorPidStartPath);
      return pid !== null && pid !== firstPid ? pid : null;
    });
    await waitFor(() => (!existsSync(claim) ? true : null));

    expect(replacementPid).not.toBe(firstPid);
    expect(pinnedPid(paths.supervisorWatchdogPidPath, paths.supervisorWatchdogPidStartPath))
      .not.toBeNull();

    process.kill(replacementPid, "SIGKILL");
  }, 90_000);
});
