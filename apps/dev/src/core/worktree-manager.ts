// worktree-manager — the management layer that ends the recorded worktree
// "saco" (issue #933, PRD #928 / S8). It sits ON TOP of the warm-leased
// worktree pool (`worktree-pool.ts`, #909) and bakes in the four management
// concerns the bare pool does not own:
//
//   1. NAMESPACED acquisition — a deterministic, collision-free worktree path
//      per (worker, issue-ref), so two live workers never materialise the same
//      slot. Distinct raw inputs that sanitise to the same readable token are
//      still kept apart by a stable hash suffix.
//   2. PROVISIONING guarantee — submodule init + `node_modules` linking are
//      verified on every acquired worktree and remediated if missing, removing
//      the lost-deps / submodule-not-init false-`blocked:validation` footgun.
//   3. ORPHAN detection + safe prune — distinguishes a git-registered worktree
//      whose dir is gone (`registered-missing`, a `git worktree prune`
//      candidate) from a present dir git no longer tracks (`untracked-present`,
//      a leftover to remove). The prune is PROCESS-in-use aware: an untracked
//      dir whose lease holder pid is still alive is always kept.
//   4. RECOVERY — a worktree whose dir vanished mid-run is re-materialised cold
//      (its `node_modules` + submodule checkout died with the dir), so a deleted
//      worktree never strands an attempt.
//
// Like the pool, every effect (git, fs, pid liveness) is an injected seam, so
// the decision logic — namespacing, orphan classification, the recovery and
// provisioning plans — is pure and unit-testable with no OS git, fs, or `ps`.
// The manager reuses the pool's `LeaseRecord` shape and `afk.worktree_pool.*`
// config gate; it adds no new config surface.

import type { LeaseRecord } from "./worktree-pool.js";

export type { LeaseRecord };

// ---------------------------------------------------------------------------
// Namespaced acquisition — collision-free per-worker worktree paths.
// ---------------------------------------------------------------------------

/**
 * Reduce an arbitrary worker id / issue ref to a filesystem-safe path segment:
 * collapse any run of non-`[A-Za-z0-9._-]` characters to a single `-` and trim
 * leading/trailing dashes. Never returns the empty string (a fully-unsafe input
 * floors to `"x"`) so a path segment is always present.
 */
export function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/**
 * Deterministic 32-bit FNV-1a hash, base-36 encoded. Pure (no clock / RNG) so
 * the namespace is stable across processes — the same (worker, ref) always maps
 * to the same path, while distinct raw inputs diverge even when their sanitised
 * tokens collide.
 */
function fnv1a36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The namespace token for a (worker, ref) pair: a readable `<worker>-<ref>`
 * prefix plus a stable hash of the RAW inputs. The hash is what guarantees
 * collision freedom — `"a/b"` and `"a-b"` share the readable token `a-b` but
 * hash differently, so their namespaces stay distinct.
 */
export function worktreeNamespace(worker: string, ref: string): string {
  const token = `${sanitizeSegment(worker)}-${sanitizeSegment(ref)}`;
  const hash = fnv1a36(`${worker.length}:${worker}:${ref}`);
  return `${token}-${hash}`;
}

/**
 * The namespaced worktree path for an acquisition: `<root>/<namespace>`. Two
 * different workers, or one worker on two different issues, always get two
 * different paths — no cross-worker collision. The result is deterministic.
 */
export function namespacedWorktreePath(root: string, worker: string, ref: string): string {
  const base = root.replace(/\/+$/, "");
  return `${base}/${worktreeNamespace(worker, ref)}`;
}

// ---------------------------------------------------------------------------
// Provisioning guarantee — submodule init + node_modules linking.
// ---------------------------------------------------------------------------

/** What an inspection of a worktree reports about its provisioned state. */
export interface ProvisionState {
  /** True when the red-castle submodule is checked out (not an empty gitlink). */
  submoduleInitialized: boolean;
  /** True when `node_modules` is present (linked or installed). */
  nodeModulesPresent: boolean;
}

/** The remediation steps that make a worktree fully provisioned. */
export type ProvisionStep = "submodule-init" | "link-node-modules";

/**
 * The ordered remediation plan that brings `state` up to fully-provisioned:
 * a missing submodule → `submodule-init`, missing deps → `link-node-modules`.
 * An already-provisioned worktree plans nothing. Submodule init is ordered
 * first because the linked `node_modules` may resolve a submodule workspace.
 */
export function planProvisioning(state: ProvisionState): ProvisionStep[] {
  const steps: ProvisionStep[] = [];
  if (!state.submoduleInitialized) steps.push("submodule-init");
  if (!state.nodeModulesPresent) steps.push("link-node-modules");
  return steps;
}

/** Effects the provisioning guarantee injects. Faked in tests. */
export interface ProvisionDeps {
  /** Inspect a worktree's submodule + node_modules state. */
  inspect: (path: string) => Promise<ProvisionState>;
  /** `git submodule update --init` for the worktree. */
  initSubmodule: (path: string) => Promise<void>;
  /** Link (or install) `node_modules` into the worktree. */
  linkNodeModules: (path: string) => Promise<void>;
}

/**
 * Guarantee a worktree is provisioned: inspect it, run exactly the missing
 * remediation steps (idempotent — a provisioned worktree runs nothing), and
 * return the steps actually applied for telemetry. This is the contract behind
 * "submodule-init guaranteed on every acquired worktree" and "`node_modules`
 * available (linked)".
 */
export async function ensureProvisioned(deps: ProvisionDeps, path: string): Promise<ProvisionStep[]> {
  const steps = planProvisioning(await deps.inspect(path));
  for (const step of steps) {
    if (step === "submodule-init") await deps.initSubmodule(path);
    else await deps.linkNodeModules(path);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Orphan detection + safe, process-in-use-aware prune.
// ---------------------------------------------------------------------------

/**
 * - `registered-missing` — git's worktree registry points at a dir that no
 *   longer exists on disk (a `git worktree prune` candidate).
 * - `untracked-present`  — a dir lives under the pool root that git's registry
 *   does not know about (a leftover to remove).
 */
export type OrphanKind = "registered-missing" | "untracked-present";

/** One detected orphan. */
export interface Orphan {
  path: string;
  kind: OrphanKind;
}

/** Inputs to the orphan scan: git's worktree registry vs the on-disk dirs. */
export interface OrphanScan {
  /** Worktree paths git's registry reports (excluding the primary checkout). */
  registered: string[];
  /** Worktree dirs actually present on disk under the pool root. */
  present: string[];
}

/**
 * Classify the orphans in a scan. A path that is BOTH registered and present is
 * healthy (not returned). Registry entries missing from disk are
 * `registered-missing`; disk dirs missing from the registry are
 * `untracked-present`.
 */
export function detectOrphans(scan: OrphanScan): Orphan[] {
  const present = new Set(scan.present);
  const registered = new Set(scan.registered);
  const orphans: Orphan[] = [];
  for (const path of scan.registered) {
    if (!present.has(path)) orphans.push({ path, kind: "registered-missing" });
  }
  for (const path of scan.present) {
    if (!registered.has(path)) orphans.push({ path, kind: "untracked-present" });
  }
  return orphans;
}

/** Effects the orphan pruner injects. Faked in tests. */
export interface OrphanPruneDeps {
  /** `git worktree prune` — drops registry entries whose dir is gone. */
  pruneRegistry: () => Promise<void>;
  /** Remove an untracked leftover dir (`rm -rf`). */
  removeDir: (path: string) => Promise<void>;
  /** The lease sidecar for a path, if any — the in-use signal source. */
  leaseFor: (path: string) => LeaseRecord | undefined;
  /** pid liveness probe — `process.kill(pid, 0)` in production. */
  isAlive: (pid: number) => boolean;
}

/** Outcome of one orphan-prune sweep. */
export interface OrphanPruneResult {
  /** Orphan paths actually removed (registry entries + untracked dirs). */
  pruned: string[];
  /** True when `git worktree prune` was run for ≥1 registered-missing orphan. */
  registryPruned: boolean;
  /** Orphans inspected but kept, with the reason. */
  kept: Array<{ path: string; reason: "in-use" }>;
}

/**
 * Sweep and safely remove orphaned worktrees. A `registered-missing` orphan
 * (its dir already gone) is dropped from the git registry. An
 * `untracked-present` orphan is removed ONLY when no live process holds it: an
 * untracked dir whose lease holder pid is still alive is kept (`in-use`) so a
 * mid-run worktree is never destroyed under a live worker. Registry pruning runs
 * at most once even with several missing entries.
 */
export async function pruneOrphans(scan: OrphanScan, deps: OrphanPruneDeps): Promise<OrphanPruneResult> {
  const orphans = detectOrphans(scan);
  const result: OrphanPruneResult = { pruned: [], registryPruned: false, kept: [] };

  const missing = orphans.filter((o) => o.kind === "registered-missing");
  if (missing.length > 0) {
    await deps.pruneRegistry();
    result.registryPruned = true;
    for (const o of missing) result.pruned.push(o.path);
  }

  for (const o of orphans) {
    if (o.kind !== "untracked-present") continue;
    const lease = deps.leaseFor(o.path);
    if (lease && deps.isAlive(lease.pid)) {
      result.kept.push({ path: o.path, reason: "in-use" });
      continue;
    }
    await deps.removeDir(o.path);
    result.pruned.push(o.path);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recovery — a worktree deleted mid-run is re-materialised cold.
// ---------------------------------------------------------------------------

/** `intact` — the leased dir is still there; `rematerialize` — it vanished. */
export type RecoveryDecision = "intact" | "rematerialize";

/**
 * Decide recovery from whether the leased worktree dir is still present. A
 * vanished dir took its `node_modules` and submodule checkout with it, so the
 * only safe recovery is a COLD re-materialise, not a warm refresh.
 */
export function decideRecovery(dirPresent: boolean): RecoveryDecision {
  return dirPresent ? "intact" : "rematerialize";
}

/** Effects recovery injects. Faked in tests. */
export interface RecoveryDeps {
  /** True when the worktree dir is still present on disk. */
  exists: (path: string) => Promise<boolean>;
  /** Cold-materialise a fresh worktree at `path` on `branch` from `base`. */
  materializeCold: (path: string, branch: string, base: string) => Promise<void>;
}

/**
 * Recover a leased worktree that may have been deleted mid-run: if its dir is
 * gone, cold-materialise a fresh one at the same path on the same branch so the
 * attempt can continue; otherwise leave the intact worktree untouched. Returns
 * the decision taken.
 */
export async function recoverWorktree(
  deps: RecoveryDeps,
  path: string,
  branch: string,
  base: string,
): Promise<RecoveryDecision> {
  const decision = decideRecovery(await deps.exists(path));
  if (decision === "rematerialize") await deps.materializeCold(path, branch, base);
  return decision;
}
