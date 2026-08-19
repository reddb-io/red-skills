import { describe, expect, it } from "vitest";
import {
  WORKTREE_POOL_DEFAULT_MAX,
  WORKTREE_POOL_DEFAULT_LEASE_TTL_S,
  WORKTREE_POOL_DEFAULT_MIN_IDLE_S,
  acquireLease,
  decidePrune,
  isLeasable,
  leaseStatus,
  planAcquisition,
  pruneIdleWorktrees,
  releaseLease,
  resolveWorktreePoolConfig,
  selectLeasable,
  type AcquireStep,
  type LeaseRecord,
  type PooledWorktree,
  type WorktreePoolConfig,
  type WorktreePoolDeps,
} from "../src/core/worktree-pool.js";
import { CONFIG_DEFAULTS } from "../src/core/config.js";

const NOW = 1_000_000;
const ALIVE = (_pid: number) => true;
const DEAD = (_pid: number) => false;

function lease(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return { owner: "w1", pid: 4242, branch: "afk/x", acquiredAt: NOW, ...over };
}

// ---------------------------------------------------------------------------
// Config gate — disabled by default; typo-safe knobs.
// ---------------------------------------------------------------------------
describe("resolveWorktreePoolConfig", () => {
  it("is disabled by default (today's cold per-attempt worktree)", () => {
    const cfg = resolveWorktreePoolConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxSize).toBe(WORKTREE_POOL_DEFAULT_MAX);
    expect(cfg.leaseTtlS).toBe(WORKTREE_POOL_DEFAULT_LEASE_TTL_S);
    expect(cfg.minIdleS).toBe(WORKTREE_POOL_DEFAULT_MIN_IDLE_S);
  });

  it("reads enabled + numeric overrides", () => {
    const cfg = resolveWorktreePoolConfig({
      "afk.worktree_pool.enabled": "true",
      "afk.worktree_pool.max_size": "8",
      "afk.worktree_pool.lease_ttl_s": "120",
      "afk.worktree_pool.min_idle_s": "60",
    });
    expect(cfg).toEqual({ enabled: true, maxSize: 8, leaseTtlS: 120, minIdleS: 60 });
  });

  it("floors non-numeric / zero knobs back to defaults (typo safety)", () => {
    const cfg = resolveWorktreePoolConfig({
      "afk.worktree_pool.enabled": "true",
      "afk.worktree_pool.max_size": "0",
      "afk.worktree_pool.lease_ttl_s": "abc",
      "afk.worktree_pool.min_idle_s": "-5",
    });
    expect(cfg.maxSize).toBe(WORKTREE_POOL_DEFAULT_MAX);
    expect(cfg.leaseTtlS).toBe(WORKTREE_POOL_DEFAULT_LEASE_TTL_S);
    expect(cfg.minIdleS).toBe(WORKTREE_POOL_DEFAULT_MIN_IDLE_S);
  });

  it("ships the documented defaults in CONFIG_DEFAULTS", () => {
    expect(CONFIG_DEFAULTS["afk.worktree_pool.enabled"]).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// Lease classification — process-based in-use detection + TTL safety.
// ---------------------------------------------------------------------------
describe("leaseStatus", () => {
  it("no sidecar → free", () => {
    expect(leaseStatus({ path: "/p" }, ALIVE, NOW, 3600)).toBe("free");
  });

  it("live holder within TTL → leased-live (in use)", () => {
    const wt: PooledWorktree = { path: "/p", lease: lease({ acquiredAt: NOW - 10 }) };
    expect(leaseStatus(wt, ALIVE, NOW, 3600)).toBe("leased-live");
  });

  it("dead holder → leased-stale (reclaimable immediately)", () => {
    const wt: PooledWorktree = { path: "/p", lease: lease({ acquiredAt: NOW - 10 }) };
    expect(leaseStatus(wt, DEAD, NOW, 3600)).toBe("leased-stale");
  });

  it("live holder past TTL → leased-stale (hung-holder / pid-reuse safety)", () => {
    const wt: PooledWorktree = { path: "/p", lease: lease({ acquiredAt: NOW - 5000 }) };
    expect(leaseStatus(wt, ALIVE, NOW, 3600)).toBe("leased-stale");
  });

  it("isLeasable excludes only leased-live", () => {
    expect(isLeasable("free")).toBe(true);
    expect(isLeasable("leased-stale")).toBe(true);
    expect(isLeasable("leased-live")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Selection — concurrent workers never collide on a live slot.
// ---------------------------------------------------------------------------
describe("selectLeasable", () => {
  const live: PooledWorktree = { path: "/live", lease: lease({ pid: 1 }) };
  const free: PooledWorktree = { path: "/free" };
  const stale: PooledWorktree = { path: "/stale", lease: lease({ pid: 2, acquiredAt: NOW - 9999 }) };

  it("never returns a live-leased worktree", () => {
    expect(selectLeasable([live], ALIVE, NOW, 3600)).toBeUndefined();
  });

  it("prefers a free slot over a stale one", () => {
    const pick = selectLeasable([stale, free, live], ALIVE, NOW, 3600);
    expect(pick?.path).toBe("/free");
  });

  it("falls back to a stale slot when none are free", () => {
    const pick = selectLeasable([live, stale], ALIVE, NOW, 3600);
    expect(pick?.path).toBe("/stale");
  });
});

// ---------------------------------------------------------------------------
// Benchmark — pool acquisition is strictly cheaper than cold setup.
// ---------------------------------------------------------------------------
describe("planAcquisition (benchmark)", () => {
  it("warm reuse skips the expensive cold setup steps", () => {
    const cold = planAcquisition(false);
    const warm = planAcquisition(true);
    expect(warm.length).toBeLessThan(cold.length);
    const expensive: AcquireStep[] = ["worktree-add", "deps-install"];
    for (const step of expensive) {
      expect(cold).toContain(step);
      expect(warm).not.toContain(step);
    }
  });
});

// ---------------------------------------------------------------------------
// Prune safety — only clean + merged + idle, never in-use/dirty/unmerged/fresh.
// ---------------------------------------------------------------------------
describe("decidePrune", () => {
  const clean = { status: "free" as const, clean: true, merged: true, idleS: 99999 };

  it("prunes a clean, merged, idle, free worktree", () => {
    expect(decidePrune(clean, 1800)).toBe("prune");
  });

  it("keeps an in-use (live) worktree", () => {
    expect(decidePrune({ ...clean, status: "leased-live" }, 1800)).toBe("keep");
  });

  it("keeps a dirty worktree (unsaved work)", () => {
    expect(decidePrune({ ...clean, clean: false }, 1800)).toBe("keep");
  });

  it("keeps an unmerged worktree (work not yet landed)", () => {
    expect(decidePrune({ ...clean, merged: false }, 1800)).toBe("keep");
  });

  it("keeps a freshly-returned worktree (below idle floor)", () => {
    expect(decidePrune({ ...clean, idleS: 10 }, 1800)).toBe("keep");
  });
});

// ---------------------------------------------------------------------------
// Orchestration with injected seams.
// ---------------------------------------------------------------------------
function cfg(over: Partial<WorktreePoolConfig> = {}): WorktreePoolConfig {
  return { enabled: true, maxSize: 4, leaseTtlS: 3600, minIdleS: 1800, ...over };
}

interface Recorder {
  deps: WorktreePoolDeps;
  calls: string[];
  written: Array<{ path: string; lease: LeaseRecord }>;
  cleared: string[];
  removed: string[];
}

function recorder(pool: PooledWorktree[], over: Partial<WorktreePoolDeps> = {}): Recorder {
  const calls: string[] = [];
  const written: Array<{ path: string; lease: LeaseRecord }> = [];
  const cleared: string[] = [];
  const removed: string[] = [];
  let nextId = pool.length;
  const deps: WorktreePoolDeps = {
    listPool: async () => pool,
    writeLease: async (path, l) => {
      calls.push(`writeLease:${path}`);
      written.push({ path, lease: l });
    },
    clearLease: async (path) => {
      calls.push(`clearLease:${path}`);
      cleared.push(path);
    },
    materializeCold: async (path) => {
      calls.push(`materializeCold:${path}`);
    },
    refreshWarm: async (path) => {
      calls.push(`refreshWarm:${path}`);
    },
    resetForReturn: async (path) => {
      calls.push(`resetForReturn:${path}`);
    },
    removeWorktree: async (path) => {
      calls.push(`removeWorktree:${path}`);
      removed.push(path);
    },
    nextPath: () => `/pool/wt-${nextId++}`,
    isAlive: ALIVE,
    now: () => NOW,
    ...over,
  };
  return { deps, calls, written, cleared, removed };
}

describe("acquireLease", () => {
  it("reuses a free warm worktree (refreshWarm, no cold materialise)", async () => {
    const r = recorder([{ path: "/pool/wt-0" }]);
    const got = await acquireLease(r.deps, cfg(), { owner: "w1", pid: 7, branch: "afk/x", base: "main" });
    expect(got?.reused).toBe(true);
    expect(got?.path).toBe("/pool/wt-0");
    expect(r.calls).toContain("refreshWarm:/pool/wt-0");
    expect(r.calls).not.toContain("materializeCold:/pool/wt-0");
    // Lease written last, after refresh.
    expect(r.calls).toEqual(["refreshWarm:/pool/wt-0", "writeLease:/pool/wt-0"]);
    expect(r.written[0]?.lease).toMatchObject({ owner: "w1", pid: 7, branch: "afk/x", acquiredAt: NOW });
  });

  it("cold-materialises a new worktree when none are leasable and below max", async () => {
    const r = recorder([{ path: "/pool/wt-0", lease: lease({ pid: 1 }) }], { isAlive: ALIVE });
    const got = await acquireLease(r.deps, cfg({ maxSize: 4 }), { owner: "w2", pid: 8, branch: "afk/y", base: "main" });
    expect(got?.reused).toBe(false);
    expect(got?.path).toBe("/pool/wt-1");
    expect(r.calls).toContain("materializeCold:/pool/wt-1");
  });

  it("returns undefined when the pool is saturated (all live, at max)", async () => {
    const full: PooledWorktree[] = [
      { path: "/pool/wt-0", lease: lease({ pid: 1 }) },
      { path: "/pool/wt-1", lease: lease({ pid: 2 }) },
    ];
    const r = recorder(full, { isAlive: ALIVE });
    const got = await acquireLease(r.deps, cfg({ maxSize: 2 }), { owner: "w3", pid: 9, branch: "afk/z", base: "main" });
    expect(got).toBeUndefined();
    expect(r.calls).toEqual([]); // no materialise, no lease write
  });

  it("two concurrent workers never collide: a dead-holder slot is reused, a live one is skipped", async () => {
    const pool: PooledWorktree[] = [
      { path: "/pool/wt-0", lease: lease({ pid: 1 }) }, // live → off-limits
      { path: "/pool/wt-1", lease: lease({ pid: 2, acquiredAt: NOW - 9999 }) }, // stale
    ];
    const r = recorder(pool, { isAlive: (pid) => pid === 1 });
    const got = await acquireLease(r.deps, cfg(), { owner: "w4", pid: 3, branch: "afk/q", base: "main" });
    expect(got?.path).toBe("/pool/wt-1"); // the live slot 0 is never chosen
    expect(got?.reused).toBe(true);
  });
});

describe("releaseLease", () => {
  it("resets the worktree (preserving deps) and clears the lease — never removes it", async () => {
    const r = recorder([{ path: "/pool/wt-0", lease: lease() }]);
    await releaseLease(r.deps, "/pool/wt-0", "main");
    expect(r.calls).toEqual(["resetForReturn:/pool/wt-0", "clearLease:/pool/wt-0"]);
    expect(r.removed).toEqual([]); // the slot survives for the next lease
  });

  it("does NOT run git clean (deps survive the cycle)", async () => {
    // The contract is enforced by the seam shape: releaseLease only ever calls
    // resetForReturn (a `git reset --hard <base>`, no `git clean`) + clearLease.
    // A real resetForReturn keeping node_modules is the production wiring's job;
    // here we assert no destructive call is issued.
    const r = recorder([{ path: "/pool/wt-0", lease: lease() }]);
    await releaseLease(r.deps, "/pool/wt-0", "main");
    expect(r.calls.some((c) => c.startsWith("removeWorktree"))).toBe(false);
  });
});

describe("pruneIdleWorktrees", () => {
  const allClean = { isClean: async () => true, isMerged: async () => true };

  it("prunes only clean + merged + idle free worktrees", async () => {
    const pool: PooledWorktree[] = [
      { path: "/idle", lease: lease({ releasedAt: NOW - 9999 }) },
    ];
    const r = recorder(pool);
    const res = await pruneIdleWorktrees(r.deps, cfg(), allClean);
    expect(res.pruned).toEqual(["/idle"]);
    expect(r.removed).toEqual(["/idle"]);
  });

  it("keeps an in-use worktree", async () => {
    const pool: PooledWorktree[] = [{ path: "/live", lease: lease({ pid: 1 }) }];
    const r = recorder(pool, { isAlive: ALIVE });
    const res = await pruneIdleWorktrees(r.deps, cfg(), allClean);
    expect(res.pruned).toEqual([]);
    expect(res.kept).toEqual([{ path: "/live", reason: "in-use" }]);
  });

  it("keeps a dirty worktree", async () => {
    const pool: PooledWorktree[] = [{ path: "/dirty", lease: lease({ releasedAt: NOW - 9999 }) }];
    const r = recorder(pool);
    const res = await pruneIdleWorktrees(r.deps, cfg(), { isClean: async () => false, isMerged: async () => true });
    expect(res.pruned).toEqual([]);
    expect(res.kept).toEqual([{ path: "/dirty", reason: "dirty" }]);
  });

  it("keeps an unmerged worktree", async () => {
    const pool: PooledWorktree[] = [{ path: "/unmerged", lease: lease({ releasedAt: NOW - 9999 }) }];
    const r = recorder(pool);
    const res = await pruneIdleWorktrees(r.deps, cfg(), { isClean: async () => true, isMerged: async () => false });
    expect(res.pruned).toEqual([]);
    expect(res.kept).toEqual([{ path: "/unmerged", reason: "unmerged" }]);
  });

  it("keeps a freshly-returned worktree (below idle floor)", async () => {
    const pool: PooledWorktree[] = [{ path: "/fresh", lease: lease({ releasedAt: NOW - 10 }) }];
    const r = recorder(pool);
    const res = await pruneIdleWorktrees(r.deps, cfg({ minIdleS: 1800 }), allClean);
    expect(res.pruned).toEqual([]);
    expect(res.kept).toEqual([{ path: "/fresh", reason: "fresh" }]);
  });
});
