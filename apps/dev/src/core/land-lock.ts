// land-lock — the global mutual exclusion that SERIALIZES AFK landings (#1337).
//
// Root cause it closes (Spec #1333, root cause 2): two workers finish within the
// same window and land into the same base. A pushes; B's push is rejected as a
// non-fast-forward; B re-integrates and — if the two diffs overlap — conflicts.
// Nothing about B's work was wrong; the two lands merely raced.
//
// TWO MECHANISMS, ONE PREFERENCE ORDER ({@link resolveLandSerialization}):
//   1. `native-merge-queue` — the forge already serializes. When the base branch
//      has a merge queue configured, AFK enqueues instead of merging directly and
//      takes NO local lock: the queue rebases + revalidates each entry onto the
//      current tip itself, which is exactly the guarantee we would otherwise build.
//   2. `land-lock` — no native queue: only one worker at a time enters the local
//      landing critical section (rebase/integrate → revalidate → merge → push), so
//      every land observes a base tip no other worker can move underneath it.
//   3. `unserialized` — neither is available. The pre-#1337 behaviour; the caller
//      lands unguarded rather than refusing.
//
// PURE SEQUENCING over injected ports. The lock file, the clock, and holder
// liveness are all injected; no real fs / process / timer is touched here.
//
// STALE TAKEOVER. A crashed worker must not deadlock the fleet forever, so a lock
// is stolen when its record is older than `staleAfterMs`, when its holder process
// is gone, or when the file is unparseable. Holder liveness is a same-host pid
// probe — the lock file lives under the repo's local `.red/tmp/`, so every holder
// shares this machine's process table.

/** The holder record serialized into the lock file. */
export interface LandLockRecord {
  /** Worker id that owns the lock (observability + release ownership check). */
  holder: string;
  /** Holder's pid, probed by {@link LandLockDeps.isHolderAlive} for stale takeover. */
  pid: number;
  /** Wall-clock ms the lock was taken, compared against `staleAfterMs`. */
  acquiredAtMs: number;
}

/** The three lock-file operations, injected so the lock is testable without fs. */
export interface LandLockFs {
  /**
   * Create the lock file with O_EXCL semantics: `true` when THIS call created it,
   * `false` when it already existed. The exclusivity of this one call is what makes
   * the lock a lock — it must never overwrite an existing file.
   */
  createExclusive(path: string, contents: string): Promise<boolean>;
  /** Read the lock file; `null` when it does not exist. */
  read(path: string): Promise<string | null>;
  /** Remove the lock file (best-effort; a missing file is not an error). */
  remove(path: string): Promise<void>;
}

/** Injected time — `now` for the stale/timeout arithmetic, `sleep` between polls. */
export interface LandLockClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface LandLockDeps {
  fs: LandLockFs;
  clock: LandLockClock;
  /** Same-host pid liveness probe; `false` → the holder crashed → steal the lock. */
  isHolderAlive(pid: number): boolean;
}

export interface LandLockOptions {
  /** Absolute path of the lock file (one per repo, e.g. `.red/tmp/afk-land.lock`). */
  path: string;
  /** This worker's id, recorded so a release only removes a lock we still own. */
  holder: string;
  /** This worker's pid, recorded for the stale-takeover liveness probe. */
  pid: number;
  /** Total time a contended acquire waits before giving up. Default 15min. */
  waitTimeoutMs?: number;
  /** Delay between contention polls. Default 1s. */
  pollMs?: number;
  /** A lock older than this is considered abandoned and stolen. Default 30min. */
  staleAfterMs?: number;
}

/** Release the lock. Idempotent, and a NO-OP once another worker owns the file. */
export type LandLockRelease = () => Promise<void>;

export interface LandLock {
  /**
   * Enter the landing critical section. Resolves with the release fn once the lock
   * is held, or `null` when the wait timed out — the caller must then abort the
   * landing rather than push unserialized.
   */
  acquire(): Promise<LandLockRelease | null>;
}

/** Which serialization mechanism a landing should use. Native queue wins: the forge
 * serializes better than we can, and double-serializing would only add latency. */
export type LandSerialization = "native-merge-queue" | "land-lock" | "unserialized";

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

/** Parse a lock file's contents. `null` for absent, malformed, or wrong-shaped
 * records — all of which are treated as an abandoned lock worth stealing, since a
 * file we cannot read is a file whose holder we cannot wait for. */
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
  if (typeof holder !== "string" || typeof pid !== "number" || typeof acquiredAtMs !== "number") return null;
  return { holder, pid, acquiredAtMs };
}

function sameRecord(a: LandLockRecord, b: LandLockRecord): boolean {
  return a.holder === b.holder && a.pid === b.pid && a.acquiredAtMs === b.acquiredAtMs;
}

export function createFileLandLock(deps: LandLockDeps, options: LandLockOptions): LandLock {
  const { fs, clock, isHolderAlive } = deps;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  /** Take the file, returning the release fn bound to the record we wrote — so a
   * release after a stale takeover cannot delete the new owner's lock. */
  async function tryTake(): Promise<LandLockRelease | null> {
    const mine: LandLockRecord = { holder: options.holder, pid: options.pid, acquiredAtMs: clock.now() };
    if (!(await fs.createExclusive(options.path, JSON.stringify(mine)))) return null;
    return async () => {
      const current = parseRecord(await fs.read(options.path));
      if (current !== null && !sameRecord(current, mine)) return;
      await fs.remove(options.path);
    };
  }

  /** An abandoned lock: unreadable, older than `staleAfterMs`, or holder is gone. */
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

        // Contended. Steal it only when the incumbent is provably abandoned — a
        // LIVE holder is waited out, never evicted (that would resurrect the race).
        if (abandoned(parseRecord(await fs.read(options.path)))) {
          await fs.remove(options.path);
          const stolen = await tryTake();
          if (stolen) return stolen;
        }

        // Every iteration ends on the deadline check + a poll sleep, so a lock we
        // can neither take nor steal times out instead of spinning.
        if (clock.now() >= deadline) return null;
        await clock.sleep(pollMs);
      }
    },
  };
}
