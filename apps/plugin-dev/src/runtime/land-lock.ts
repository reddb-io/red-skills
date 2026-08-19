// runtime/land-lock.ts — the concrete host ports behind the global AFK land-lock
// (#1337). core/land-lock.ts owns the acquire/steal/release SEQUENCING over these
// injected closures; this file is the only place a real file, clock, or process
// table is touched.
//
// The lock file lives at `<repo>/.red/tmp/afk-land.lock`, so its scope is exactly
// "every AFK worker process on this host, landing into this repo" — which is the
// set of workers that can race each other's push to the same base.

import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createFileLandLock,
  type LandLock,
  type LandLockFs,
  type LandLockWaitInfo,
} from "../core/land-lock.js";

/** Standard land-lock path for an AFK tmp dir (`.red/tmp/afk-land.lock`). */
export function landLockPath(tmpDir: string): string {
  return join(tmpDir, "afk-land.lock");
}

/** `node:fs` behind {@link LandLockFs}. `createExclusive` uses the `wx` flag, whose
 * O_EXCL create is atomic — the whole lock rests on that one syscall. */
const nodeLandLockFs: LandLockFs = {
  async createExclusive(path, contents) {
    let handle;
    try {
      handle = await open(path, "wx");
    } catch {
      // EEXIST (already held) or a missing parent dir — either way we did not take it.
      return false;
    }
    try {
      await handle.writeFile(contents);
      return true;
    } finally {
      await handle.close();
    }
  },
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

/** Same-host pid liveness: signal 0 probes the process table without delivering a
 * signal. ESRCH → the holder crashed → its lock is stale and may be stolen. An
 * EPERM (process exists, owned by another user) counts as ALIVE — refusing to
 * steal is always the safe answer. */
function isHolderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Build a host-backed file lock at an ARBITRARY path — the same acquire/steal
 * sequencing as the land-lock, aimed at any other resource that is shared by
 * every process on this host (#2437: the singleton feedback baseline worktree).
 * Timings are caller-supplied because the contention windows differ by orders
 * of magnitude: a land holds its lock for a push, a worktree materialise holds
 * it for a `pnpm install`.
 */
export function createPathLock(
  path: string,
  holder: string,
  options: {
    waitTimeoutMs?: number;
    pollMs?: number;
    staleAfterMs?: number;
    onWait?: (info: LandLockWaitInfo) => void;
  } = {},
  pid: number = process.pid,
): LandLock {
  return createFileLandLock(
    { fs: nodeLandLockFs, clock: { now: () => Date.now(), sleep: (ms) => delay(ms) }, isHolderAlive },
    { path, holder, pid, ...options },
  );
}

/**
 * Build a host-backed sized semaphore from independent file-lock slots.
 *
 * Slot one deliberately keeps `path` unchanged, so a capacity-one host and a
 * rolling upgrade from the old mutex coordinate through the exact historical
 * lock file. Higher capacities add numbered sibling locks. Acquisition scans
 * every slot without waiting before it polls one, so a busy first slot cannot
 * hide a free later slot.
 */
export function createPathSemaphore(
  path: string,
  holder: string,
  capacity: number,
  options: {
    waitTimeoutMs?: number;
    pollMs?: number;
    staleAfterMs?: number;
    onWait?: (info: LandLockWaitInfo) => void;
  } = {},
  pid: number = process.pid,
): LandLock {
  const slots = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : 1;
  const waitTimeoutMs = options.waitTimeoutMs ?? 15 * 60_000;
  const pollMs = options.pollMs ?? 1_000;
  let nextSlot = Math.abs(pid) % slots;
  let attempt = 0;
  let startedAtMs = 0;
  let deadline = 0;

  const slotPath = (index: number): string => {
    if (index === 0) return path;
    return path.endsWith(".lock")
      ? `${path.slice(0, -".lock".length)}.${index + 1}.lock`
      : `${path}.${index + 1}`;
  };

  const lockFor = (
    index: number,
    timeout: number,
    onWait?: (info: LandLockWaitInfo) => void,
  ): LandLock => createPathLock(slotPath(index), `${holder}:slot-${index + 1}`, {
    waitTimeoutMs: timeout,
    pollMs: Math.max(1, Math.min(pollMs, timeout || pollMs)),
    ...(options.staleAfterMs == null ? {} : { staleAfterMs: options.staleAfterMs }),
    ...(onWait == null ? {} : { onWait }),
  }, pid);

  return {
    async acquire() {
      startedAtMs = Date.now();
      deadline = startedAtMs + waitTimeoutMs;
      for (;;) {
        for (let offset = 0; offset < slots; offset += 1) {
          const index = (nextSlot + offset) % slots;
          const release = await lockFor(index, 0).acquire();
          if (release !== null) return release;
        }

        const now = Date.now();
        if (now >= deadline) return null;
        const index = nextSlot;
        nextSlot = (nextSlot + 1) % slots;
        const waitForMs = Math.max(1, Math.min(pollMs, deadline - now));
        const release = await lockFor(index, waitForMs, (info) => {
          attempt += 1;
          try {
            options.onWait?.({
              ...info,
              waitedMs: Math.max(0, Date.now() - startedAtMs),
              remainingMs: Math.max(0, deadline - Date.now()),
              attempt,
            });
          } catch {
            // Observability cannot change semaphore ownership.
          }
        }).acquire();
        if (release !== null) return release;
      }
    },
  };
}

/** Build the host-backed global land-lock for this worker process. */
export function createLandLock(tmpDir: string, holder: string, pid: number = process.pid): LandLock {
  return createPathLock(landLockPath(tmpDir), holder, {}, pid);
}
