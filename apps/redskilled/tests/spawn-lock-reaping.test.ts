// An orphaned spawn lock blocked every auto-spawn, forever (#3123).
//
// The lock was zero bytes and six hours old. It named no pid and no instant, so
// nothing could decide it was stale; rule 7's auto-spawn is the only path a fresh
// session has to a daemon, so the machine was permanently un-spawnable until a
// human deleted a file they had no reason to look for. And the sentence they got
// meanwhile — "the daemon did not start" — described a spawn that was never
// attempted, sending them to inspect a daemon that was perfectly healthy.
//
// These checks pin both halves: the lock now carries its owner and its age and is
// REAPED past a stated bound, and a spawn refused by a lock names THE LOCK.
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireSpawnLock,
  describeSpawnLockHolder,
  parseSpawnLockHolder,
  releaseSpawnLock,
  type SpawnLockHeld,
  type SpawnLockReaping,
  type SpawnLockTaken,
} from "@reddb-io/shared/resident-core.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-lock-"));
  roots.push(root);
  return join(root, "redskilled.spawn.lock");
}

/** The exact artifact from the field: zero bytes, aged by its mtime alone. */
async function orphanedLock(path: string, ageMs: number): Promise<void> {
  await writeFile(path, "");
  const aged = new Date(Date.now() - ageMs);
  await utimes(path, aged, aged);
}

describe("an aged spawn lock is reaped rather than obeyed", () => {
  it("reaps a zero-byte lock older than the stated bound, and says it did", async () => {
    const path = await lockPath();
    await orphanedLock(path, 6 * 60 * 60 * 1_000);

    const reaped: SpawnLockReaping[] = [];
    const outcome = await acquireSpawnLock(path, { maxAgeMs: 60_000, onReap: (r) => reaped.push(r) });

    expect(outcome.acquired, "an unattributed six-hour lock blocked the spawn").toBe(true);
    // The reaping is logged, not silent: deleting another process's lock on a
    // guess must leave a trail for the day the guess was wrong.
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.reason).toBe("unattributed");
    expect(reaped[0]!.ageMs).toBeGreaterThan(5 * 60 * 60 * 1_000);

    await releaseSpawnLock(outcome as SpawnLockTaken);
  });

  it("reaps a lock whose named holder is dead, however young it is", async () => {
    const path = await lockPath();
    const held = await acquireSpawnLock(path, { pid: 4242, now: () => Date.now() });
    expect(held.acquired).toBe(true);
    // The handle stays open: the holder crashed, it did not release.
    (held as SpawnLockTaken).handle.close();

    const reaped: SpawnLockReaping[] = [];
    const outcome = await acquireSpawnLock(path, {
      isPidAlive: (pid) => pid !== 4242,
      onReap: (r) => reaped.push(r),
    });

    expect(outcome.acquired).toBe(true);
    expect(reaped.map((r) => r.reason)).toEqual(["holder-dead"]);
    expect(reaped[0]!.holder?.pid).toBe(4242);
    await releaseSpawnLock(outcome as SpawnLockTaken);
  });

  it("reaps a live holder that has held the lock past the bound", async () => {
    const path = await lockPath();
    const taken = await acquireSpawnLock(path, { now: () => Date.now() - 120_000 });
    expect(taken.acquired).toBe(true);
    await (taken as SpawnLockTaken).handle.close();

    const outcome = await acquireSpawnLock(path, { maxAgeMs: 60_000, isPidAlive: () => true });
    expect(outcome.acquired).toBe(true);
    await releaseSpawnLock(outcome as SpawnLockTaken);
  });

  it("obeys a fresh lock held by a live owner — the race it exists to resolve", async () => {
    const path = await lockPath();
    const first = await acquireSpawnLock(path, { pid: 777 });
    expect(first.acquired).toBe(true);

    const second = await acquireSpawnLock(path, { maxAgeMs: 60_000, isPidAlive: () => true });

    expect(second.acquired, "a live holder's fresh lock was robbed").toBe(false);
    const held = second as SpawnLockHeld;
    expect(held.holder?.pid).toBe(777);
    expect(held.ageMs).not.toBeNull();
    await releaseSpawnLock(first as SpawnLockTaken);
  });
});

describe("the lock says who took it and when", () => {
  it("writes an attributed, human-legible line", async () => {
    const path = await lockPath();
    const taken = await acquireSpawnLock(path, { pid: 31337, now: () => Date.parse("2026-08-03T05:00:00.000Z") });

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("pid=31337");
    expect(parseSpawnLockHolder(raw)).toEqual({ pid: 31337, takenAt: "2026-08-03T05:00:00.000Z" });

    await releaseSpawnLock(taken as SpawnLockTaken);
    // Released means gone: a closed handle beside a standing file is the orphan.
    await expect(stat(path)).rejects.toThrow();
  });

  it("reads an older bundle's unattributed lock as naming nobody", () => {
    expect(parseSpawnLockHolder("")).toBeNull();
    expect(parseSpawnLockHolder("something else entirely\n")).toBeNull();
    expect(parseSpawnLockHolder("resident-spawn-lock v1 pid=0 taken=nonsense")).toBeNull();
  });
});

describe("a refused spawn names the gate that refused it", () => {
  it("names the lock, its holder and how to clear it", async () => {
    const path = await lockPath();
    const first = await acquireSpawnLock(path, { pid: 909 });
    const second = await acquireSpawnLock(path, { maxAgeMs: 60_000, isPidAlive: () => true });

    const sentence = describeSpawnLockHolder(second as SpawnLockHeld);

    expect(sentence).toContain(path);
    expect(sentence).toContain("pid 909");
    expect(sentence).toContain("no spawn was attempted");
    expect(sentence).toContain("remove the file to clear it");
    // The sentence it replaces must not be what an operator reads here.
    expect(sentence).not.toContain("did not start");

    await releaseSpawnLock(first as SpawnLockTaken);
  });
});
