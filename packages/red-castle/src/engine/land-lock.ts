export interface LandLockRecord {
  holder: string;
  pid: number;
  acquiredAtMs: number;
}

export interface LandLockFs {
  createExclusive(path: string, contents: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
}

export interface LandLockClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface LandLockDeps {
  fs: LandLockFs;
  clock: LandLockClock;
  isHolderAlive(pid: number): boolean;
}

/**
 * One observation of a WAIT — emitted before every poll sleep, so a contended
 * lock is loud instead of silent. A file lock's whole cost is invisible by
 * construction: no child process, no socket, no write, just `sleep(pollMs)` in
 * a loop, which is exactly the shape an orchestrator hang wears (#2985). The
 * waiter names what it waits for so nobody has to read a stack to find out.
 */
export interface LandLockWaitInfo {
  /** The contended lock's path. */
  path: string;
  /** Who this waiter is. */
  holder: string;
  /** Who currently holds it, when the record could be read. */
  heldBy?: string;
  /** The holder's pid, when the record could be read. */
  heldByPid?: number;
  /** How long the CURRENT holder has held it. */
  heldForMs?: number;
  /** How long THIS waiter has waited so far. */
  waitedMs: number;
  /** How much of the wait budget is left before `acquire()` gives up. */
  remainingMs: number;
  /** 1-based poll count. */
  attempt: number;
}

export interface LandLockOptions {
  path: string;
  holder: string;
  pid: number;
  waitTimeoutMs?: number;
  pollMs?: number;
  staleAfterMs?: number;
  /**
   * Called before each poll sleep with {@link LandLockWaitInfo}. A throw is
   * swallowed: observability may never cost the lock.
   */
  onWait?: (info: LandLockWaitInfo) => void;
}

export type LandLockRelease = () => Promise<void>;

export interface LandLock {
  acquire(): Promise<LandLockRelease | null>;
}

export type LandSerialization =
  "native-merge-queue" | "land-lock" | "unserialized";

export function resolveLandSerialization(input: {
  nativeMergeQueue?: boolean;
  hasLandLock?: boolean;
}): LandSerialization {
  if (input.nativeMergeQueue === true) return "native-merge-queue";
  return input.hasLandLock === true ? "land-lock" : "unserialized";
}

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 30 * 60_000;

function parseRecord(raw: string | null): LandLockRecord | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { holder, pid, acquiredAtMs } = parsed as Partial<LandLockRecord>;
  if (
    typeof holder !== "string" ||
    typeof pid !== "number" ||
    typeof acquiredAtMs !== "number"
  )
    return null;
  return { holder, pid, acquiredAtMs };
}

function sameRecord(a: LandLockRecord, b: LandLockRecord): boolean {
  return (
    a.holder === b.holder &&
    a.pid === b.pid &&
    a.acquiredAtMs === b.acquiredAtMs
  );
}

export function createFileLandLock(
  deps: LandLockDeps,
  options: LandLockOptions,
): LandLock {
  const { fs, clock, isHolderAlive } = deps;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  async function tryTake(): Promise<LandLockRelease | null> {
    const mine: LandLockRecord = {
      holder: options.holder,
      pid: options.pid,
      acquiredAtMs: clock.now(),
    };
    if (!(await fs.createExclusive(options.path, JSON.stringify(mine))))
      return null;
    return async () => {
      const current = parseRecord(await fs.read(options.path));
      if (current !== null && !sameRecord(current, mine)) return;
      await fs.remove(options.path);
    };
  }

  /** Fire the wait sink, swallowing its throw. */
  function notifyWait(info: LandLockWaitInfo): void {
    try {
      options.onWait?.(info);
    } catch {
      /* observability may never cost the lock */
    }
  }

  function abandoned(record: LandLockRecord | null): boolean {
    if (record === null) return true;
    if (clock.now() - record.acquiredAtMs >= staleAfterMs) return true;
    return !isHolderAlive(record.pid);
  }

  return {
    async acquire(): Promise<LandLockRelease | null> {
      const startedAtMs = clock.now();
      const deadline = startedAtMs + waitTimeoutMs;
      let attempt = 0;
      for (;;) {
        const taken = await tryTake();
        if (taken) return taken;

        const record = parseRecord(await fs.read(options.path));
        if (abandoned(record)) {
          await fs.remove(options.path);
          const stolen = await tryTake();
          if (stolen) return stolen;
        }

        const now = clock.now();
        if (now >= deadline) return null;
        attempt += 1;
        notifyWait({
          path: options.path,
          holder: options.holder,
          ...(record === null
            ? {}
            : {
                heldBy: record.holder,
                heldByPid: record.pid,
                heldForMs: Math.max(0, now - record.acquiredAtMs),
              }),
          waitedMs: Math.max(0, now - startedAtMs),
          remainingMs: Math.max(0, deadline - now),
          attempt,
        });
        await clock.sleep(pollMs);
      }
    },
  };
}
