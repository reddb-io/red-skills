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
import { afkPaths, resolveRepoSlug } from "../runtime/wire.js";
import { inspectProcessTreeNative } from "../runtime/proc-tree.js";
import {
  agentLaneMtimeFor,
  parkedSlotWorkFor,
  resolveIterDirInfo,
  teardownIterDirNative,
} from "../runtime/supervisor-fs.js";
import * as ghx from "../runtime/gh.js";
import { removeDir as removeDirNative } from "../runtime/fs.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build SupervisorDeps backed by REAL process / filesystem / gh IO. Every
 * closure mirrors a supervisor.sh function (see runtime/proc-tree.ts +
 * runtime/supervisor-fs.ts) and is best-effort: a failed ps / stat / gh degrades
 * to the SAFE value and never throws out of the closure.
 *
 * Slot pids are tracked in a per-slot map keyed by slot index. `spawnSlot`
 * records the pid; the fs/proc closures resolve the live worker through it
 * (mirroring SLOT_PIDS[$slot] in bash, which is how find_slot_iter_dir /
 * agentLaneMtime / inspectTree all reach the running worker tree).
 */
function buildSupervisorDeps(
  root: string,
  tmpDir: string,
  logFd: number,
  runner: string,
  ghCtx: ghx.GhContext,
): SupervisorDeps {
  const bundle = process.argv[1];
  const now = () => Math.floor(Date.now() / 1000);
  // slot index → live orchestrator pid (SLOT_PIDS parity).
  const slotPids = new Map<number, number>();

  return {
    proc: {
      spawnSlot: async (slot) => {
        const child = spawn(process.execPath, [bundle, "run", "--once", "--runner", runner], {
          cwd: root,
          env: { ...process.env, RED_AFK_RUNNER: runner },
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        const pid = child.pid ?? 0;
        slotPids.set(slot, pid);
        return { pid, spawnEpoch: now() };
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
      // Real ps-backed tree sample. A ps failure returns a CONSERVATIVE BUSY
      // snapshot (never []), so a transient ps error can never authorise a reap.
      inspectTree: (pid) => inspectProcessTreeNative(pid),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    fs: {
      agentLaneMtime: (slot) => agentLaneMtimeFor(tmpDir, slotPids.get(slot) ?? null),
      resolveIterDir: (slot) => resolveIterDirInfo(tmpDir, slotPids.get(slot) ?? null, now()),
      teardownIterDir: async (info) => {
        await teardownIterDirNative(info, root);
      },
      parkedSlotWork: (slot) => parkedSlotWorkFor(tmpDir, root, slot, 0),
      removeDir: async (path) => {
        try {
          await removeDirNative(path);
        } catch {
          // best-effort
        }
      },
    },
    gh: {
      comment: async (issue, body) => {
        try {
          await ghx.comment(ghCtx, issue, body);
        } catch {
          // best-effort
        }
      },
      editLabels: async (issue, add, remove) => {
        try {
          await ghx.editLabels(ghCtx, issue, remove, add);
        } catch {
          // best-effort
        }
      },
      ensureRunnerErrorLabel: async () => {
        try {
          await ghx.ensureRunnerErrorLabel(ghCtx);
        } catch {
          // best-effort
        }
      },
    },
    now,
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
  const repo = await resolveRepoSlug(root).catch(() => "");
  const ghCtx = { cwd: root, repo };
  const deps = buildSupervisorDeps(root, tmp, logFd, config.runner, ghCtx);

  const stopRequested = (): boolean => existsSync(stopFile);

  try {
    await runSupervisor(state, deps, config, stopRequested);
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(stopFile, { force: true });
  }
  return 0;
}
