// commands/supervise.ts — the NATIVE fleet supervisor (the hidden `__supervise`
// command fleet.ts spawns instead of supervisor.sh).
//
// It writes the supervisor pid file, polls the stop file, and drives
// runSupervisor over real SupervisorDeps. Each slot spawns a `run --once` of
// THIS SAME BUNDLE (node process.execPath bin __run-once), so the whole fleet is
// native — no bash anywhere in the loop.

import { spawn } from "node:child_process";
import { existsSync, openSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  initSupervisorState,
  resolveSupervisorConfig,
  runSupervisor,
  type SupervisorDeps,
} from "../core/supervisor.js";
import { afkPaths } from "../runtime/wire.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Build SupervisorDeps that spawn `run --once` of this bundle per slot. The
 * stall/teardown/gh surfaces are best-effort no-ops in this cutover — the
 * orchestration + circuit-breaker + respawn loop is the load-bearing part. */
function buildSupervisorDeps(root: string, logFd: number, runner: string): SupervisorDeps {
  const bundle = process.argv[1];
  return {
    proc: {
      spawnSlot: async () => {
        const child = spawn(process.execPath, [bundle, "run", "--once", "--runner", runner], {
          cwd: root,
          env: { ...process.env, RED_AFK_RUNNER: runner },
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        return { pid: child.pid ?? 0, spawnEpoch: Math.floor(Date.now() / 1000) };
      },
      isAlive,
      killTree: async (pid) => {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
      },
      inspectTree: () => [],
    },
    fs: {
      agentLaneMtime: () => 0,
      resolveIterDir: () => null,
      teardownIterDir: async () => undefined,
      parkedSlotWork: () => ({ workers: [], fastDeaths: 0, supervisorLogPath: "" }),
      removeDir: async () => undefined,
    },
    gh: {
      comment: async () => undefined,
      editLabels: async () => undefined,
      ensureRunnerErrorLabel: async () => undefined,
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}

/**
 * Drive the native fleet supervisor. Honours the same pid/stop-file protocol
 * fleet.ts's launch/stop already speak.
 */
export async function superviseCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const root = cwd;
  const paths = afkPaths(root);
  const tmp = paths.tmpDir;
  const pidFile = join(tmp, "afk-supervisor.pid");
  const stopFile = join(tmp, "afk-supervisor.stop");
  const logFile = join(tmp, "afk-supervisor.log");

  await import("../runtime/fs.js").then((m) => m.ensureDir(tmp));
  // single-supervisor lock
  if (existsSync(pidFile)) {
    try {
      const prev = Number(require("node:fs").readFileSync(pidFile, "utf8").trim());
      if (prev && isAlive(prev)) {
        process.stderr.write(`supervisor already running (pid=${prev})\n`);
        return 1;
      }
    } catch {
      // stale — overwrite
    }
  }
  writeFileSync(pidFile, String(process.pid), "utf8");
  // clear any stale stop file
  if (existsSync(stopFile)) rmSync(stopFile, { force: true });

  const logFd = openSync(logFile, "a");
  const config = resolveSupervisorConfig();
  const state = initSupervisorState(config.target);
  const deps = buildSupervisorDeps(root, logFd, config.runner);

  const stopRequested = (): boolean => existsSync(stopFile);

  try {
    await runSupervisor(state, deps, config, stopRequested);
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(stopFile, { force: true });
  }
  return 0;
}
