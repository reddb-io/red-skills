import { describe, expect, it } from "vitest";
import {
  createFileLandLock,
  resolveLandSerialization,
  type LandLockDeps,
  type LandLockFs,
} from "./land-lock.js";

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
  elapsed(): number;
  sleeps: number[];
}

function harness(
  opts: { alivePids?: number[]; onSleep?: (tick: number) => void } = {},
): Harness {
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
      isHolderAlive: (pid) =>
        opts.alivePids ? opts.alivePids.includes(pid) : true,
    },
  };
}

const LOCK = "/red/tmp/afk-land.lock";

describe("castle land serialization", () => {
  it("prefers the forge's native merge queue over the local lock", () => {
    expect(
      resolveLandSerialization({ nativeMergeQueue: true, hasLandLock: true }),
    ).toBe("native-merge-queue");
    expect(
      resolveLandSerialization({ nativeMergeQueue: true, hasLandLock: false }),
    ).toBe("native-merge-queue");
  });

  it("falls back to the global land-lock when no native queue is configured", () => {
    expect(
      resolveLandSerialization({ nativeMergeQueue: false, hasLandLock: true }),
    ).toBe("land-lock");
  });

  it("is unserialized only when neither mechanism is available", () => {
    expect(
      resolveLandSerialization({ nativeMergeQueue: false, hasLandLock: false }),
    ).toBe("unserialized");
    expect(resolveLandSerialization({})).toBe("unserialized");
  });
});

describe("castle file land-lock", () => {
  it("acquires an uncontended lock and writes the holder record", async () => {
    const h = harness();
    const lock = createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wAAAA",
      pid: 100,
    });

    const release = await lock.acquire();

    expect(release).not.toBeNull();
    expect(h.sleeps).toEqual([]);
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({
      holder: "wAAAA",
      pid: 100,
    });
  });

  it("waits for a live holder instead of stealing the lock", async () => {
    const h = harness({
      onSleep: (tick) => {
        if (tick === 2) h.fs.files.delete(LOCK);
      },
    });
    const first = createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wAAAA",
      pid: 100,
    });
    const second = createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wBBBB",
      pid: 200,
      pollMs: 5,
      waitTimeoutMs: 100,
    });
    await first.acquire();

    const release = await second.acquire();

    expect(release).not.toBeNull();
    expect(h.sleeps).toEqual([5, 5, 5]);
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({
      holder: "wBBBB",
      pid: 200,
    });
  });

  it("steals an abandoned lock and releases only its own holder record", async () => {
    const h = harness({ alivePids: [200] });
    h.fs.files.set(
      LOCK,
      JSON.stringify({ holder: "dead", pid: 100, acquiredAtMs: 0 }),
    );
    const lock = createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wBBBB",
      pid: 200,
    });

    const release = await lock.acquire();

    expect(release).not.toBeNull();
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({
      holder: "wBBBB",
      pid: 200,
    });
    h.fs.files.set(
      LOCK,
      JSON.stringify({ holder: "wCCCC", pid: 300, acquiredAtMs: 1 }),
    );
    await release?.();
    expect(JSON.parse(h.fs.files.get(LOCK) ?? "{}")).toMatchObject({
      holder: "wCCCC",
      pid: 300,
    });
  });

  it("times out when a live holder never releases", async () => {
    const h = harness();
    const first = createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wAAAA",
      pid: 100,
    });
    const second = createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wBBBB",
      pid: 200,
      pollMs: 5,
      waitTimeoutMs: 10,
    });
    await first.acquire();

    const release = await second.acquire();

    expect(release).toBeNull();
    expect(h.elapsed()).toBe(10);
  });
});

describe("land lock — a wait names itself (#2985)", () => {
  const LOCK = "/tmp/afk-land.lock";

  it("says nothing when the lock is uncontended", async () => {
    const h = harness();
    const seen: unknown[] = [];

    const release = await createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wAAAA",
      pid: 100,
      onWait: (info) => seen.push(info),
    }).acquire();

    expect(release).not.toBeNull();
    expect(seen).toEqual([]);
  });

  it("reports the holder, the wait's age and the budget left on every poll", async () => {
    const h = harness();
    await createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100 }).acquire();
    const waits: Array<Record<string, unknown>> = [];

    const release = await createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wBBBB",
      pid: 200,
      pollMs: 10,
      waitTimeoutMs: 30,
      onWait: (info) => waits.push({ ...info }),
    }).acquire();

    // 30ms budget at a 10ms poll: three announced waits, then the give-up.
    expect(release).toBeNull();
    expect(waits).toHaveLength(3);
    expect(waits[0]).toMatchObject({
      path: LOCK,
      holder: "wBBBB",
      heldBy: "wAAAA",
      heldByPid: 100,
      waitedMs: 0,
      remainingMs: 30,
      attempt: 1,
    });
    expect(waits[2]).toMatchObject({ waitedMs: 20, remainingMs: 10, attempt: 3 });
  });

  it("swallows a throwing sink — observability may never cost the lock", async () => {
    const h = harness();
    await createFileLandLock(h.deps, { path: LOCK, holder: "wAAAA", pid: 100 }).acquire();

    const release = await createFileLandLock(h.deps, {
      path: LOCK,
      holder: "wBBBB",
      pid: 200,
      pollMs: 5,
      waitTimeoutMs: 10,
      onWait: () => {
        throw new Error("sink exploded");
      },
    }).acquire();

    expect(release).toBeNull();
    expect(h.elapsed()).toBe(10);
  });
});
