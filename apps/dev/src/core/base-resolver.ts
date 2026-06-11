// base-resolver — resolve the effective base/merge branch for a work item (ADR 0031).
//
// AFK bases each worktree on, and merges each finished item back into, a single
// branch. Three sources can name that branch; this module decides which one wins
// by a fixed precedence:
//
//   1. the branch-lock value — when the primary checkout is locked to a branch,
//      the lock is absolute and overrides any pin (the human pinned this
//      checkout on purpose; the lock comes from the branch-lock skill's
//      lock_store_read against `.red/tmp/branch-lock.yaml`);
//   2. else the pinned branch — the issue/PRD `branch:` resolution (pin-reader's
//      `resolvePin`, which already collapses "no pin" to `main`);
//   3. else `main` — today's behaviour when nothing is set.
//
// Pure composition, no side effects of its own: it touches neither git nor the
// filesystem directly. All real IO (the lock file read, the gh body fetch) is
// injected, so the precedence stays unit-testable against fixed inputs.

import { DEFAULT_BRANCH, resolvePin, type ResolvePinInput } from "./pin-reader.js";

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
  /** Fetch the raw body for issue/PRD number `n`, or `undefined` if missing. */
  fetchIssueBody: (n: number) => Promise<string | undefined>;
}

export type ResolveBaseInput = ResolvePinInput;

/**
 * Resolve the effective base branch by the fixed precedence
 * runtime-lock > config-lock > pin > main:
 *   the runtime branch-lock if present, else the static `dev.lock.branch` config
 *   default, else the resolved pin, else `main`.
 *
 * The runtime lock is read via the injected `readLockedBranch`; `configLockedBranch`
 * is the static `dev.lock.branch` value; the pin is delegated to pin-reader's
 * `resolvePin`. A whitespace-only value counts as "not set".
 */
export async function resolveBase(input: ResolveBaseInput, deps: ResolveBaseDeps): Promise<string> {
  const locked = await deps.readLockedBranch();
  if (isSet(locked)) return locked.trim();

  if (isSet(deps.configLockedBranch)) return deps.configLockedBranch.trim();

  const pinned = await resolvePin(input, { fetchIssueBody: deps.fetchIssueBody });
  if (isSet(pinned)) return pinned;

  return DEFAULT_BRANCH;
}
