// worktree-pool — the "treehouse" warm-leased worktree pool model (issue #909,
// PRD #907 Track 1B).
//
// Today every AFK attempt gets a COLD worktree: `git worktree add` from scratch,
// then a package install before the gate can run. That cold setup is a recurring
// footgun class — a worktree that misses `node_modules` fails the feedback gate
// with a false `blocked:validation`, and even when it works it pays the full
// setup cost every attempt.
//
// This module absorbs the worktree-POOL model (the treehouse approach), not any
// Go binary: instead of one cold worktree per attempt, keep a small pool of
// WARM, dependency-preserving worktrees. A worker ACQUIRES one by LEASE and,
// when the attempt ends, RETURNS it (clears the lease) rather than destroying
// it — so the installed `node_modules` survive into the next lease.
// Concurrency is governed by a per-worktree lease
// sidecar plus PROCESS-based in-use detection (the holder pid), so two live
// workers never collide on the same slot. A safe pruner removes ONLY worktrees
// that are clean (no uncommitted work), merged (branch contained in base), and
// idle (no live lease, past the idle floor) — a dirty or in-use slot is always
// kept.
//
// Like the rest of `core/`, every effect (git, fs, pid liveness, clock) is an
// injected seam, so the decision logic — leasability, prune safety, the cold-vs-
// warm step plan the benchmark asserts on — is pure and unit-testable with no OS
// git, fs, or `ps`. The whole feature is config-gated (`afk.worktree_pool.*`);
// disabled (the default) leaves today's per-attempt cold-worktree behaviour
// exactly as it is.

import { getConfig, type ConfigValues } from "./config.js";

/** Default ceiling on the number of warm worktrees the pool keeps alive. */
export const WORKTREE_POOL_DEFAULT_MAX = 4;
/** Default lease TTL: a lease older than this is reclaimable even if its holder
 * pid still looks alive (pid-reuse / hung-holder safety). */
export const WORKTREE_POOL_DEFAULT_LEASE_TTL_S = 3600;
/** Default idle floor for the pruner: a returned worktree must have sat idle at
 * least this long before it is eligible to be pruned, so a slot that was just
 * released stays warm for the next attempt. */
export const WORKTREE_POOL_DEFAULT_MIN_IDLE_S = 1800;

/** Resolved `afk.worktree_pool.*` knobs. */
export interface WorktreePoolConfig {
  /** Master switch. `false` (default) → today's cold per-attempt worktree. */
  enabled: boolean;
  /** Max number of warm worktrees the pool holds. */
  maxSize: number;
  /** Lease TTL in seconds — see {@link WORKTREE_POOL_DEFAULT_LEASE_TTL_S}. */
  leaseTtlS: number;
  /** Idle floor in seconds before a clean/merged worktree may be pruned. */
  minIdleS: number;
}

/**
 * Resolve the pool config from the loaded `.red/config.yaml` values. Mirrors the
 * `${VAR:-default}` typo-safety used elsewhere: a non-numeric / non-positive size
 * or TTL floors back to its default so a config typo can never produce a pool of
 * size 0 (no slots) or a negative TTL (every lease instantly stale).
 */
export function resolveWorktreePoolConfig(values: ConfigValues): WorktreePoolConfig {
  const enabled = getConfig(values, "afk.worktree_pool.enabled") === "true";
  const posInt = (key: string, fallback: number): number => {
    const raw = getConfig(values, key);
    if (/^[0-9]+$/.test(raw)) {
      const n = Number(raw);
      if (n > 0) return n;
    }
    return fallback;
  };
  return {
    enabled,
    maxSize: posInt("afk.worktree_pool.max_size", WORKTREE_POOL_DEFAULT_MAX),
    leaseTtlS: posInt("afk.worktree_pool.lease_ttl_s", WORKTREE_POOL_DEFAULT_LEASE_TTL_S),
    minIdleS: posInt("afk.worktree_pool.min_idle_s", WORKTREE_POOL_DEFAULT_MIN_IDLE_S),
  };
}

/** A lease sidecar — written when a worker acquires a worktree, cleared on
 * return. Persisted next to the worktree (e.g. `<path>.lease.json`). */
export interface LeaseRecord {
  /** Logical owner id (worker id / issue ref) — diagnostics only. */
  owner: string;
  /** OS pid of the process holding the lease — the in-use signal. */
  pid: number;
  /** Branch checked out into the worktree for this lease. */
  branch: string;
  /** Epoch seconds the lease was acquired. */
  acquiredAt: number;
  /** Epoch seconds the lease was last released (set on return; unset while held). */
  releasedAt?: number;
}

/** A worktree in the pool: its path plus its current lease sidecar (if any). */
export interface PooledWorktree {
  /** Absolute worktree path. */
  path: string;
  /** The lease sidecar, when one exists. Absent → the slot is free. */
  lease?: LeaseRecord;
}

/** Lease state of a pooled worktree. */
export type LeaseStatus = "free" | "leased-live" | "leased-stale";

/**
 * Classify a pooled worktree's lease.
 *
 * - `free`        — no lease sidecar, OR a sidecar that has been RETURNED
 *   (`releasedAt` set). A returned slot is freely reusable; its record is kept
 *   only so the pruner can read the idle clock.
 * - `leased-live` — lease HELD (no `releasedAt`) by a LIVE pid AND inside the
 *   TTL → genuinely in use; never reused, never pruned.
 * - `leased-stale`— lease HELD but the holder pid is dead OR the lease has
 *   exceeded the TTL → reclaimable (a crashed / hung worker's slot).
 *
 * PROCESS-based detection is primary: a dead holder frees the slot immediately,
 * so a crashed worker never strands a warm worktree. The TTL is the secondary
 * guard for the pid-reuse / hung-holder case (a live-looking pid sitting on an
 * ancient lease).
 */
export function leaseStatus(
  wt: PooledWorktree,
  isAlive: (pid: number) => boolean,
  nowS: number,
  ttlS: number,
): LeaseStatus {
  const lease = wt.lease;
  if (!lease) return "free";
  // A returned lease (releasedAt recorded) is free for reuse; the record only
  // survives so the pruner's idle clock can read `releasedAt`.
  if (lease.releasedAt !== undefined) return "free";
  const expired = nowS - lease.acquiredAt >= ttlS;
  if (!isAlive(lease.pid) || expired) return "leased-stale";
  return "leased-live";
}

/** A worktree is leasable iff it is not in active use (free or stale). */
export function isLeasable(status: LeaseStatus): boolean {
  return status !== "leased-live";
}

/**
 * Pick the worktree to lease from the pool, or `undefined` when none is free.
 * Prefers a genuinely `free` slot over a `leased-stale` one so a crashed
 * worker's slot is left for last (it may still hold useful, if dirty, state for
 * salvage); among equals the first in pool order wins for determinism.
 */
export function selectLeasable(
  pool: readonly PooledWorktree[],
  isAlive: (pid: number) => boolean,
  nowS: number,
  ttlS: number,
): PooledWorktree | undefined {
  const free = pool.find((wt) => leaseStatus(wt, isAlive, nowS, ttlS) === "free");
  if (free) return free;
  return pool.find((wt) => leaseStatus(wt, isAlive, nowS, ttlS) === "leased-stale");
}

/** The materialisation steps an acquisition runs — what the benchmark counts.
 * The COLD path pays the expensive `deps-install`; the WARM
 * (reused) path skips both because the prior lease preserved them. */
export type AcquireStep =
  | "worktree-add"
  | "deps-install"
  | "fetch-base"
  | "checkout-branch"
  | "write-lease";

/**
 * The ordered step plan for an acquisition. `reused === true` (a warm leased
 * worktree) skips `worktree-add` and `deps-install` — those
 * artefacts survived the previous lease — so a pool acquisition is strictly
 * cheaper than the cold path (the benchmark criterion). The cold path is exactly
 * today's per-attempt setup.
 */
export function planAcquisition(reused: boolean): AcquireStep[] {
  if (reused) return ["fetch-base", "checkout-branch", "write-lease"];
  return ["worktree-add", "deps-install", "fetch-base", "checkout-branch", "write-lease"];
}

/** Inputs the prune decision weighs for one candidate worktree. */
export interface PruneSignals {
  /** Lease state (free / stale / live). A `leased-live` slot is always kept. */
  status: LeaseStatus;
  /** True when the worktree has NO uncommitted changes (git status empty). */
  clean: boolean;
  /** True when the worktree's branch is merged into / contained in the base. */
  merged: boolean;
  /** Seconds the worktree has sat idle (since its lease was released). */
  idleS: number;
}

/**
 * Safe-by-default prune verdict: prune ONLY a worktree that is simultaneously
 * not-in-use, clean, merged, AND idle past the floor. Any single failing signal
 * → `keep`. This is the guarantee behind "prune removes only clean/merged/idle
 * worktrees": a dirty slot (unsaved work), an unmerged branch (work not yet
 * landed), an in-use slot, or a freshly-returned slot is never destroyed.
 */
export function decidePrune(signals: PruneSignals, minIdleS: number): "keep" | "prune" {
  if (signals.status === "leased-live") return "keep";
  if (!signals.clean) return "keep";
  if (!signals.merged) return "keep";
  if (signals.idleS < minIdleS) return "keep";
  return "prune";
}

/** Effects the pool orchestration injects. Every one is faked in tests. */
export interface WorktreePoolDeps {
  /** Enumerate the pool's worktrees and their lease sidecars. */
  listPool: () => Promise<PooledWorktree[]>;
  /** Persist a lease sidecar for `path`. */
  writeLease: (path: string, lease: LeaseRecord) => Promise<void>;
  /** Mark the lease for `path` RETURNED by recording `releasedAt` (the sidecar
   * is kept, not deleted, so the pruner's idle clock survives). */
  clearLease: (path: string, releasedAt: number) => Promise<void>;
  /**
   * Cold-materialise a brand-new warm worktree at `path` on `branch` from
   * `base`: `git worktree add`, deps install. Runs only when the
   * pool has no leasable slot and is below `maxSize`.
   */
  materializeCold: (path: string, branch: string, base: string) => Promise<void>;
  /**
   * Refresh an EXISTING warm worktree for a new lease: fetch base + check out
   * `branch`. MUST NOT run `git clean` — that is what preserves
   * `node_modules` across the lease cycle.
   */
  refreshWarm: (path: string, branch: string, base: string) => Promise<void>;
  /** Reset a returned worktree to a clean base state WITHOUT deleting ignored
   * artefacts (no `git clean`) so deps survive. */
  resetForReturn: (path: string, base: string) => Promise<void>;
  /** Destroy a worktree the pruner condemned (`git worktree remove --force`). */
  removeWorktree: (path: string) => Promise<void>;
  /** Allocate the next worktree path when the pool grows (cold path). */
  nextPath: () => string;
  /** pid liveness probe — `process.kill(pid, 0)` in production. */
  isAlive: (pid: number) => boolean;
  /** Clock (epoch seconds). */
  now: () => number;
}

/** A request to acquire a leased worktree. */
export interface AcquireRequest {
  /** Logical owner id recorded on the lease. */
  owner: string;
  /** pid to record as the holder (the in-use signal). */
  pid: number;
  /** Branch to check out for this attempt. */
  branch: string;
  /** Base ref the branch is created from. */
  base: string;
}

/** The result of an acquisition. */
export interface AcquiredLease {
  /** The leased worktree path. */
  path: string;
  /** True when a warm pool worktree was reused (cheap path); false when a new
   * worktree was cold-materialised. */
  reused: boolean;
  /** The lease sidecar written for this acquisition. */
  lease: LeaseRecord;
  /** The materialisation steps run, for telemetry / the benchmark. */
  steps: AcquireStep[];
}

/**
 * Acquire a leased worktree for an attempt.
 *
 * Reuses the first leasable warm worktree (`selectLeasable`) when one exists —
 * the cheap WARM path that skips deps install. Otherwise, if
 * the pool is below `maxSize`, cold-materialises a new warm worktree. Returns
 * `undefined` when the pool is saturated (all slots live and at capacity) so the
 * caller can fall back to today's cold per-attempt worktree.
 *
 * The lease sidecar is written LAST (after the worktree is materialised /
 * refreshed and the branch checked out) so a crash mid-acquire never leaves a
 * lease pointing at a half-built worktree.
 */
export async function acquireLease(
  deps: WorktreePoolDeps,
  cfg: WorktreePoolConfig,
  req: AcquireRequest,
): Promise<AcquiredLease | undefined> {
  const pool = await deps.listPool();
  const nowS = deps.now();
  const pick = selectLeasable(pool, deps.isAlive, nowS, cfg.leaseTtlS);

  let path: string;
  let reused: boolean;
  if (pick) {
    path = pick.path;
    reused = true;
    await deps.refreshWarm(path, req.branch, req.base);
  } else {
    if (pool.length >= cfg.maxSize) return undefined;
    path = deps.nextPath();
    reused = false;
    await deps.materializeCold(path, req.branch, req.base);
  }

  const lease: LeaseRecord = {
    owner: req.owner,
    pid: req.pid,
    branch: req.branch,
    acquiredAt: nowS,
  };
  await deps.writeLease(path, lease);
  return { path, reused, lease, steps: planAcquisition(reused) };
}

/**
 * Return a leased worktree to the pool: reset it to a clean base state (keeping
 * ignored deps) and clear the lease so the slot is free for the next attempt.
 * The worktree is NOT destroyed — that is the whole point of the pool. Pruning
 * of genuinely stale/idle slots is the pruner's separate, safe-by-default job.
 */
export async function releaseLease(
  deps: WorktreePoolDeps,
  path: string,
  base: string,
): Promise<void> {
  await deps.resetForReturn(path, base);
  await deps.clearLease(path, deps.now());
}

/** Per-worktree probes the pruner needs beyond the lease sidecar. */
export interface PruneProbe {
  /** True when the worktree has no uncommitted changes. */
  isClean: (path: string) => Promise<boolean>;
  /** True when the worktree's branch is merged into / contained in the base. */
  isMerged: (path: string) => Promise<boolean>;
}

/** Outcome of one prune sweep. */
export interface PruneResult {
  /** Paths actually removed. */
  pruned: string[];
  /** Paths inspected but kept, with the reason. */
  kept: Array<{ path: string; reason: "in-use" | "dirty" | "unmerged" | "fresh" }>;
}

/**
 * Sweep the pool and remove ONLY clean + merged + idle worktrees that are not in
 * use. Every kept worktree is reported with the reason it survived, so the sweep
 * is auditable (no silent retention). Safe-by-default: any probe ambiguity keeps
 * the worktree.
 */
export async function pruneIdleWorktrees(
  deps: WorktreePoolDeps,
  cfg: WorktreePoolConfig,
  probe: PruneProbe,
): Promise<PruneResult> {
  const pool = await deps.listPool();
  const nowS = deps.now();
  const result: PruneResult = { pruned: [], kept: [] };

  for (const wt of pool) {
    const status = leaseStatus(wt, deps.isAlive, nowS, cfg.leaseTtlS);
    if (status === "leased-live") {
      result.kept.push({ path: wt.path, reason: "in-use" });
      continue;
    }
    const clean = await probe.isClean(wt.path);
    if (!clean) {
      result.kept.push({ path: wt.path, reason: "dirty" });
      continue;
    }
    const merged = await probe.isMerged(wt.path);
    if (!merged) {
      result.kept.push({ path: wt.path, reason: "unmerged" });
      continue;
    }
    // Idle clock: time since the lease was released (or acquired, if a stale
    // lease never recorded a release). A free worktree with no lease is treated
    // as fully idle.
    const since = wt.lease?.releasedAt ?? wt.lease?.acquiredAt ?? 0;
    const idleS = since > 0 ? nowS - since : Number.POSITIVE_INFINITY;
    if (decidePrune({ status, clean, merged, idleS }, cfg.minIdleS) === "keep") {
      result.kept.push({ path: wt.path, reason: "fresh" });
      continue;
    }
    await deps.removeWorktree(wt.path);
    result.pruned.push(wt.path);
  }
  return result;
}
