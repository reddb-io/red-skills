// worktree-pool-integration — end-to-end proof of the two #987 acceptance
// criteria that the seam-level unit tests in `worktree-pool.test.ts` do not
// cover as a single flow:
//
//   1. A full lease → return → acquire cycle reuses the SAME warm worktree with
//      `node_modules` still present (no cold setup, no reinstall), and the warm
//      acquisition is measurably cheaper than the
//      cold one it replaces.
//   2. Two concurrent workers never acquire the same pool slot — process-based
//      in-use detection keeps a live holder's worktree off-limits — across an
//      interleaved sequence of leases and returns (collision-free lease/return).
//
// Rather than fake each seam call in isolation, this drives the REAL
// `acquireLease` / `releaseLease` orchestration against a small in-memory model
// of the worktree world (each worktree carries its own `node_modules` state plus
// a live-pid registry). The model faithfully mirrors the production contract:
// `materializeCold` INSTALLS deps, `refreshWarm` and `resetForReturn` NEVER
// touch them (no `git clean`). If the
// orchestration ever reinstalled or wiped deps on the warm path, these tests
// break.

import { describe, expect, it } from "vitest";
import {
  acquireLease,
  releaseLease,
  type AcquiredLease,
  type LeaseRecord,
  type PooledWorktree,
  type WorktreePoolConfig,
  type WorktreePoolDeps,
} from "../src/core/worktree-pool.js";

const NOW = 2_000_000;

function cfg(over: Partial<WorktreePoolConfig> = {}): WorktreePoolConfig {
  return { enabled: true, maxSize: 4, leaseTtlS: 3600, minIdleS: 1800, ...over };
}

/** One worktree in the in-memory world — the durable artefact (`node_modules`)
 * lives HERE, so a lease→return→acquire cycle that preserves it is observable
 * directly. */
interface WorldWorktree {
  path: string;
  /** True once `node_modules` has been installed (cold setup). */
  nodeModules: boolean;
  /** Uncommitted tracked changes present (cleared by a return's reset). */
  dirty: boolean;
  branch?: string;
  lease?: LeaseRecord;
}

/**
 * The in-memory worktree world + a `WorktreePoolDeps` bound to it. `now` is a
 * fixed clock (leases stay well within TTL) and `isAlive` reads a mutable
 * live-pid set, so the test can bring a "worker" up or down by adding/removing
 * its pid — exactly the process-based in-use signal the pool relies on.
 */
class World {
  worktrees: WorldWorktree[] = [];
  live = new Set<number>();
  private nextId = 0;
  /** How many times a slot was cold-materialised — a reinstall would bump this. */
  coldCount = 0;
  /** How many times a slot was warm-refreshed (the cheap reuse path). */
  warmCount = 0;

  find(path: string): WorldWorktree {
    const wt = this.worktrees.find((w) => w.path === path);
    if (!wt) throw new Error(`no worktree at ${path}`);
    return wt;
  }

  /** Snapshot the paths currently held by a LIVE lease (no releasedAt, live pid). */
  liveHeld(): { path: string; pid: number }[] {
    return this.worktrees
      .filter((w) => w.lease && w.lease.releasedAt === undefined && this.live.has(w.lease.pid))
      .map((w) => ({ path: w.path, pid: w.lease!.pid }));
  }

  deps(): WorktreePoolDeps {
    return {
      listPool: async (): Promise<PooledWorktree[]> =>
        this.worktrees.map((w) => ({ path: w.path, lease: w.lease })),
      writeLease: async (path, lease) => {
        this.find(path).lease = { ...lease };
      },
      clearLease: async (path, releasedAt) => {
        const l = this.find(path).lease;
        if (l) l.releasedAt = releasedAt;
      },
      materializeCold: async (path, branch) => {
        // Cold setup: create the worktree AND install the durable artefact.
        this.coldCount++;
        this.worktrees.push({ path, nodeModules: true, dirty: false, branch });
      },
      refreshWarm: async (path, branch) => {
        // Warm reuse: only re-point the branch. MUST NOT touch node_modules —
        // that is what preserves it across the lease cycle.
        this.warmCount++;
        const wt = this.find(path);
        wt.branch = branch;
        wt.dirty = false;
      },
      resetForReturn: async (path) => {
        // Return reset: drop uncommitted tracked work only (no `git clean`), so
        // ignored artefacts (node_modules) survive.
        this.find(path).dirty = false;
      },
      removeWorktree: async (path) => {
        this.worktrees = this.worktrees.filter((w) => w.path !== path);
      },
      nextPath: () => `/pool/wt-${this.nextId++}`,
      isAlive: (pid) => this.live.has(pid),
      now: () => NOW,
    };
  }
}

describe("worktree pool — lease→return→acquire preserves deps and is cheaper", () => {
  it("a second attempt on the same issue reuses the warm slot with deps intact, no reinstall", async () => {
    const world = new World();
    const deps = world.deps();
    const req = { owner: "w987", branch: "afk/987", base: "main" };

    // First attempt: empty pool → COLD setup (installs node_modules).
    world.live.add(100);
    const cold = (await acquireLease(deps, cfg(), { ...req, pid: 100 })) as AcquiredLease;
    expect(cold.reused).toBe(false);
    expect(cold.steps).toContain("deps-install");
    const slot = cold.path;
    const wt = world.find(slot);
    // Simulate the attempt doing work in the tree.
    wt.dirty = true;
    expect(wt.nodeModules).toBe(true);

    // Attempt ends: worker dies, worktree returned (not destroyed).
    world.live.delete(100);
    await releaseLease(deps, slot, "main");
    // Deps survive the return; tracked work is reset.
    expect(wt.nodeModules).toBe(true);
    expect(wt.dirty).toBe(false);
    expect(world.worktrees).toHaveLength(1); // slot kept, not removed

    // Second attempt on the SAME issue: acquires the warm slot.
    world.live.add(101);
    const warm = (await acquireLease(deps, cfg(), { ...req, pid: 101 })) as AcquiredLease;
    expect(warm.reused).toBe(true);
    expect(warm.path).toBe(slot); // same physical worktree
    // No cold setup on the warm path.
    expect(warm.steps).not.toContain("deps-install");
    // Measurably cheaper than the cold acquisition it replaced.
    expect(warm.steps.length).toBeLessThan(cold.steps.length);
    // node_modules is STILL the original install — never reinstalled.
    expect(wt.nodeModules).toBe(true);
    expect(world.coldCount).toBe(1); // exactly one install across the whole cycle
    expect(world.warmCount).toBe(1);
  });
});

describe("worktree pool — collision-free concurrent lease/return (two workers)", () => {
  it("two live workers never hold the same slot across interleaved leases and returns", async () => {
    const world = new World();
    const deps = world.deps();
    const A = 201; // worker A pid
    const B = 202; // worker B pid
    const acquire = (pid: number, branch: string) =>
      acquireLease(deps, cfg({ maxSize: 4 }), { owner: `w${pid}`, pid, branch, base: "main" });

    // Invariant checked after every mutation: no path is held by two live pids.
    const assertNoCollision = () => {
      const held = world.liveHeld();
      const byPath = new Map<string, number>();
      for (const { path, pid } of held) {
        const other = byPath.get(path);
        expect(other, `slot ${path} held by both pid ${other} and ${pid}`).toBeUndefined();
        byPath.set(path, pid);
      }
    };

    // A comes up and leases.
    world.live.add(A);
    const a1 = (await acquire(A, "afk/a-1")) as AcquiredLease;
    assertNoCollision();

    // B comes up and leases WHILE A still holds its slot → must be a different one.
    world.live.add(B);
    const b1 = (await acquire(B, "afk/b-1")) as AcquiredLease;
    expect(b1.path).not.toBe(a1.path);
    assertNoCollision();

    // A returns; B is still live on its slot.
    await releaseLease(deps, a1.path, "main");
    assertNoCollision();

    // A leases again: it may reuse its own just-freed slot, but must NEVER take
    // B's live slot.
    const a2 = (await acquire(A, "afk/a-2")) as AcquiredLease;
    expect(a2.path).not.toBe(b1.path);
    assertNoCollision();

    // B returns, then re-acquires; must never collide with A's live slot.
    await releaseLease(deps, b1.path, "main");
    assertNoCollision();
    const b2 = (await acquire(B, "afk/b-2")) as AcquiredLease;
    expect(b2.path).not.toBe(a2.path);
    assertNoCollision();

    // Two workers, two distinct live slots the whole time — the pool never grew
    // past what genuine concurrency required.
    expect(world.liveHeld()).toHaveLength(2);
    expect(new Set(world.worktrees.map((w) => w.path)).size).toBe(world.worktrees.length);
  });

  it("a crashed worker's slot is reclaimed by the next lease (process-based prune)", async () => {
    const world = new World();
    const deps = world.deps();

    // Worker A leases, then CRASHES without returning (pid goes dead).
    world.live.add(301);
    const a = (await acquireLease(deps, cfg(), { owner: "wA", pid: 301, branch: "afk/a", base: "main" })) as AcquiredLease;
    world.live.delete(301); // crash — lease sidecar still present, holder dead

    // Next worker acquires: the dead holder's slot is leasable again (reused),
    // no new worktree is materialised.
    world.live.add(302);
    const b = (await acquireLease(deps, cfg(), { owner: "wB", pid: 302, branch: "afk/b", base: "main" })) as AcquiredLease;
    expect(b.reused).toBe(true);
    expect(b.path).toBe(a.path); // reclaimed the crashed worker's warm slot
    expect(world.worktrees).toHaveLength(1);
    expect(world.coldCount).toBe(1); // only the very first cold setup, never a second
  });
});
