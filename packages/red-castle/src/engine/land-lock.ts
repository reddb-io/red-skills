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

export interface LandLockOptions {
  path: string;
  holder: string;
  pid: number;
  waitTimeoutMs?: number;
  pollMs?: number;
  staleAfterMs?: number;
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

  function abandoned(record: LandLockRecord | null): boolean {
    if (record === null) return true;
    if (clock.now() - record.acquiredAtMs >= staleAfterMs) return true;
    return !isHolderAlive(record.pid);
  }

  return {
    async acquire(): Promise<LandLockRelease | null> {
      const deadline = clock.now() + waitTimeoutMs;
      for (;;) {
        const taken = await tryTake();
        if (taken) return taken;

        if (abandoned(parseRecord(await fs.read(options.path)))) {
          await fs.remove(options.path);
          const stolen = await tryTake();
          if (stolen) return stolen;
        }

        if (clock.now() >= deadline) return null;
        await clock.sleep(pollMs);
      }
    },
  };
}
