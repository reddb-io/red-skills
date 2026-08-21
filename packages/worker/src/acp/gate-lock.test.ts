import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHostGateLock, hostGateLockPath } from "./gate-lock.js";

// #4161: two Workers running their gates simultaneously on one host poisoned
// each other, and the Verdict read the contention as branch fault. The gate
// slot is one host-wide lock; this suite pins its whole contract.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function lockDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-gate-lock-"));
  roots.push(root);
  return root;
}

describe("the host-wide gate slot (#4161)", () => {
  it("acquires a free slot immediately and releases it", async () => {
    const lockPath = join(await lockDir(), "gate.lock");
    const slot = await acquireHostGateLock({ lockPath, pid: 4242 });
    expect(slot.unlocked).toBe(false);
    expect((await readFile(lockPath, "utf8")).trim()).toBe("4242");
    await slot.release();
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("waits for a live holder and takes the slot when it releases", async () => {
    const lockPath = join(await lockDir(), "gate.lock");
    const first = await acquireHostGateLock({ lockPath, pid: 1 });
    const waits: Array<number | null> = [];
    let clock = 0;
    const second = acquireHostGateLock({
      lockPath,
      pid: 2,
      pollMs: 10,
      deadlineMs: 10_000,
      now: () => clock,
      sleep: async () => { clock += 10; await first.release(); },
      pidAlive: () => true,
      onWait: (holder) => { waits.push(holder); },
    });
    const slot = await second;
    expect(slot.unlocked).toBe(false);
    expect(waits).toEqual([1]);
    expect((await readFile(lockPath, "utf8")).trim()).toBe("2");
    await slot.release();
  });

  it("breaks a dead holder's lock immediately", async () => {
    const lockPath = join(await lockDir(), "gate.lock");
    await writeFile(lockPath, "999999\n");
    const slot = await acquireHostGateLock({ lockPath, pid: 7, pidAlive: () => false });
    expect(slot.unlocked).toBe(false);
    expect((await readFile(lockPath, "utf8")).trim()).toBe("7");
    await slot.release();
  });

  it("proceeds unlocked past the deadline instead of parking the Worker forever", async () => {
    const lockPath = join(await lockDir(), "gate.lock");
    await writeFile(lockPath, "1\n");
    let clock = 0;
    const slot = await acquireHostGateLock({
      lockPath,
      pid: 7,
      pollMs: 10,
      deadlineMs: 25,
      now: () => clock,
      sleep: async () => { clock += 10; },
      pidAlive: () => true,
    });
    expect(slot.unlocked).toBe(true);
    // The holder's lock is not ours to delete: release must not clobber it.
    await slot.release();
    expect((await readFile(lockPath, "utf8")).trim()).toBe("1");
  });

  it("names one lock per user per machine", () => {
    expect(hostGateLockPath("/tmp", 1000)).toBe("/tmp/red-skills-1000/gate.lock");
    expect(hostGateLockPath("/tmp", "Some User")).toBe("/tmp/red-skills-some-user/gate.lock");
  });
});
