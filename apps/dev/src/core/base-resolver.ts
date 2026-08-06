// base-resolver — resolve the effective base/merge branch for a work item
// (ADR 0031; Trunk fallback by ADR 0083).
//
// AFK bases each worktree on, and merges each finished item back into, a single
// branch. This module decides which source wins by a fixed precedence
// (lock > pin > Trunk):
//
//   1. the branch-lock value — when the primary checkout is locked to a branch,
//      the lock is absolute and overrides any pin (the human pinned this
//      checkout on purpose; the lock comes from the branch-lock skill's
//      lock_store_read against `.red/tmp/branch-lock.yaml`);
//   2. else the pinned branch — the Ticket/Spec `branch:` resolution (pin-reader's
//      `resolvePin`, which collapses "no pin" to the Trunk);
//   3. else the Trunk — the repo's configured focal branch
//      (`plugins.dev.trunk`, default `main`; ADR 0083).
//
// The resolver returns a branch NAME. The daemon resolves that name to the
// exact fork SHA it grants each Worker; consumers never derive the birth ref
// from the local working-tree branch (ADR 0083, ADR 0138).
//
// Pure composition, no side effects of its own: it touches neither git nor the
// filesystem directly. All real IO (the lock file read, the gh body fetch) is
// injected, so the precedence stays unit-testable against fixed inputs.

import { DEFAULT_BRANCH, resolvePinWithSource, type ResolvePinInput } from "./pin-reader.js";

/** True when `value` has at least one non-whitespace char (mirrors `_base_is_set`). */
function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export interface ResolveBaseDeps {
  /**
   * Read the locked branch from the primary checkout's branch-lock, or
   * `undefined`/empty when the session is unlocked (empty lock file counts as
   * unlocked). Wraps the branch-lock skill's `lock_store_read`.
   */
  readLockedBranch: () => Promise<string | undefined>;
  /**
   * Static config default branch lock (`dev.lock.branch`), used when the runtime
   * branch-lock file is absent/unset. The runtime lock still overrides it, so the
   * `/branch-lock` skill can re-lock dynamically per session. Empty/undefined =
   * no config-level lock.
   */
  configLockedBranch?: string;
  /**
   * The configured Trunk (`plugins.dev.trunk`, ADR 0083): the branch a work
   * item bases on and lands to when neither a lock nor a pin names one.
   * Empty/undefined falls back to `main`, preserving pre-trunk behaviour.
   */
  configTrunk?: string;
  /** Fetch the raw body for Ticket/Spec number `n`, or `undefined` if missing. */
  fetchIssueBody: (n: number) => Promise<string | undefined>;
}

export type ResolveBaseInput = ResolvePinInput;
export type ResolveBaseSource = "lock" | "pin" | "trunk";

export interface ResolvedBase {
  branch: string;
  source: ResolveBaseSource;
}

/**
 * Resolve the effective base branch by the fixed precedence
 * runtime-lock > config-lock > pin > Trunk (ADR 0031/0083):
 *   the runtime branch-lock if present, else the static `dev.lock.branch` config
 *   default, else the resolved pin, else the configured Trunk
 *   (`plugins.dev.trunk`, default `main`).
 *
 * The runtime lock is read via the injected `readLockedBranch`; `configLockedBranch`
 * is the static `dev.lock.branch` value; the pin is delegated to pin-reader's
 * `resolvePin` (whose pinless collapse also lands on the Trunk). A
 * whitespace-only value counts as "not set".
 */
export async function resolveBaseWithSource(input: ResolveBaseInput, deps: ResolveBaseDeps): Promise<ResolvedBase> {
  const locked = await deps.readLockedBranch();
  if (isSet(locked)) return { branch: locked.trim(), source: "lock" };

  if (isSet(deps.configLockedBranch)) return { branch: deps.configLockedBranch.trim(), source: "pin" };

  const pinned = await resolvePinWithSource(input, {
    fetchIssueBody: deps.fetchIssueBody,
    defaultBranch: deps.configTrunk,
  });
  if (isSet(pinned.branch)) return pinned;

  return { branch: isSet(deps.configTrunk) ? deps.configTrunk.trim() : DEFAULT_BRANCH, source: "trunk" };
}

export async function resolveBase(input: ResolveBaseInput, deps: ResolveBaseDeps): Promise<string> {
  return (await resolveBaseWithSource(input, deps)).branch;
}
