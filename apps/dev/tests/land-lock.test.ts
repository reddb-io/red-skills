import { describe, expect, it } from "vitest";
import {
  createFileLandLock,
  resolveLandSerialization,
  type LandLockDeps,
  type LandLockFs,
} from "../src/core/land-lock.js";

// The global AFK land-lock (#1337) serializes the landing critical section so two
// near-simultaneous workers can never race on a non-fast-forward push to the same
// base. Every side effect is injected: the lock file lives in a fake in-memory fs,
// time only moves when the fake clock's `sleep` is awaited, and holder liveness is
// a fake `isHolderAlive`. No real fs / process is touched here.

/** In-memory `LandLockFs` with O_EXCL semantics — `createExclusive` fails when the
 * path already exists, exactly like `fs.open(path, "wx")`. */
function memFs(): LandLockFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async createExclusive(path, contents) {
      if (files.has(path)) return false;
      files.set(path, contents);
      return true;
    },
    async read(path) {
      return files.get(path) ?? null;
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

interface Harness {
  deps: LandLockDeps;
  fs: ReturnType<typeof memFs>;
  /** ms the fake clock has advanced (only `sleep` moves it). */
  elapsed(): number;
  /** every `sleep` duration awaited, in order. */
  sleeps: number[];
}

interface Opts {
  /** pids the fake `isHolderAlive` reports as running. Default: every pid is alive. */
  alivePids?: number[];
  /** Invoked before each fake `sleep` resolves — lets a test mutate the lock file mid-wait. */
  onSleep?: (tick: number) => void;
}

function harness(opts: Opts = {}): Harness {
  const fs = memFs();
  const sleeps: number[] = [];
  let clock = 0;
  let tick = 0;
  return {
    fs,
    sleeps,
    elapsed: () => clock,
    deps: {
      fs,
      clock: {
        now: () => clock,
        async sleep(ms) {
          sleeps.push(ms);
          clock += ms;
          opts.onSleep?.(tick++);
        },
      },
      isHolderAlive: (pid) => (opts.alivePids ? opts.alivePids.includes(pid) : true),
    },
  };
}

const LOCK = "/red/tmp/afk-land.lock";

describe("resolveLandSerialization", () => {
  it("prefers the forge's native merge queue over the local lock", () => {
    expect(resolveLandSerialization({ nativeMergeQueue: true, hasLandLock: true })).toBe("native-merge-queue");
    expect(resolveLandSerialization({ nativeMergeQueue: true, hasLandLock: false })).toBe("native-merge-queue");
  });

  it("falls back to the global land-lock when no native queue is configured", () => {
    expect(resolveLandSerialization({ nativeMergeQueue: false, hasLandLock: true })).toBe("land-lock");
  });

  it("is unserialized only when neither mechanism is available", () => {
    expect(resolveLandSerialization({ nativeMergeQueue: false, hasLandLock: false })).toBe("unserialized");
    expect(resolveLandSerialization({})).toBe("unserialized");
  });
});

describe("createFileLandLock", () => {
  it("acquires an uncontended lock and writes the holder record", async () => {
    const h = harness();
    const lock = createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100 });

    const release = await lock.acquire();

    expect(release).not.toBeNull();
    expect(h.sleeps).toEqual([]);
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({ holder: "wAAAA", pid: 100 });
  });

  it("release removes the lock file so the next worker can acquire", async () => {
    const h = harness();
    const lock = createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100 });

    const release = await lock.acquire();
    await release?.();

    expect(h.fs.files.has(LOCK)).toBe(false);
  });

  it("a contended acquire waits, polling, until the holder releases", async () => {
    const h = harness({
      // The incumbent releases on the third poll — the waiter must not have
      // acquired before that.
      onSleep: (tick) => {
        if (tick === 2) h.fs.files.delete(LOCK);
      },
    });
    const incumbent = createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100 });
    expect(await incumbent.acquire()).not.toBeNull();

    const waiter = createFileLandLock(h.deps, { path: LOCK, holder: "wBBBB", pid: 200, pollMs: 50 });
    const release = await waiter.acquire();

    expect(release).not.toBeNull();
    expect(h.sleeps).toEqual([50, 50, 50]);
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({ holder: "wBBBB", pid: 200 });
  });

  it("gives up with null when the holder never releases within the wait timeout", async () => {
    const h = harness();
    const incumbent = createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100 });
    await incumbent.acquire();

    const waiter = createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wBBBB",
      pid: 200,
      pollMs: 100,
      waitTimeoutMs: 250,
    });

    expect(await waiter.acquire()).toBeNull();
    // Still the incumbent's record: a timed-out waiter never steals a live lock.
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({ holder: "wAAAA" });
  });

  it("steals a lock whose record is older than staleAfterMs", async () => {
    const h = harness();
    h.fs.files.set(LOCK, JSON.stringify({ holder: "wDEAD", pid: 100, acquiredAtMs: -60_000 }));

    const lock = createFileLandLock(h.deps, { path: LOCK, holder: "wBBBB", pid: 200, staleAfterMs: 30_000 });
    const release = await lock.acquire();

    expect(release).not.toBeNull();
    expect(h.sleeps).toEqual([]);
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({ holder: "wBBBB" });
  });

  it("steals a lock whose holder process is gone", async () => {
    const h = harness({ alivePids: [200] });
    h.fs.files.set(LOCK, JSON.stringify({ holder: "wDEAD", pid: 100, acquiredAtMs: 0 }));

    const lock = createFileLandLock(h.deps, { path: LOCK, holder: "wBBBB", pid: 200 });

    expect(await lock.acquire()).not.toBeNull();
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({ holder: "wBBBB" });
  });

  it("steals an unparseable lock file rather than deadlocking on it", async () => {
    const h = harness();
    h.fs.files.set(LOCK, "{ not json");

    const lock = createFileLandLock(h.deps, { path: LOCK, holder: "wBBBB", pid: 200 });

    expect(await lock.acquire()).not.toBeNull();
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({ holder: "wBBBB" });
  });

  it("release never removes a lock another worker now owns", async () => {
    const h = harness();
    const lock = createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100 });
    const release = await lock.acquire();

    // Our lock was stolen (stale takeover) and re-taken by another worker.
    h.fs.files.set(LOCK, JSON.stringify({ holder: "wBBBB", pid: 200, acquiredAtMs: 5 }));
    await release?.();

    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({ holder: "wBBBB" });
  });

  it("serializes two concurrent acquires — the second only enters after the first releases", async () => {
    const h = harness();
    const a = createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100, pollMs: 10 });
    const b = createFileLandLock(h.deps, { path: LOCK, holder: "wBBBB", pid: 200, pollMs: 10 });
    const inside: string[] = [];

    async function land(name: string, lock: { acquire: () => Promise<(() => Promise<void>) | null> }) {
      const release = await lock.acquire();
      expect(release).not.toBeNull();
      inside.push(`enter:${name}`);
      await h.deps.clock.sleep(10); // the critical section: rebase + revalidate + push
      inside.push(`exit:${name}`);
      await release?.();
    }

    await Promise.all([land("A", a), land("B", b)]);

    // Never `enter:A, enter:B` — the second land waits out the first.
    expect(inside).toEqual(["enter:A", "exit:A", "enter:B", "exit:B"]);
  });
});
