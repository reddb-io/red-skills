// core/loc-memo.ts — commit-anchored LOC memo for /afk attempt worktrees.
//
// Issue #1210 (Part B): the statusline/monitor render paths must NEVER shell out
// to `git diff --shortstat` — that ownership moves to the WRITERS (the per-attempt
// heartbeat and/or post-commit hook), which stamp `loc_added`/`loc_removed` into
// `afk.state.json` for ALL runners (codex included — the writer is runner-agnostic,
// so the historical codex `0/0` gap that forced the render fallback disappears).
//
// The diffstat is EXPENSIVE (two git subprocesses via {@link diffstatShortstat}),
// so this module memoizes it against the current HEAD sha in the attempt dir: the
// diffstat is recomputed AT MOST ONCE PER COMMIT. While HEAD is unchanged the
// memoized volume is served without spawning git; a new commit (HEAD moves)
// invalidates the memo and triggers exactly one recompute. Pure and fully
// injectable — the compute/read/write seams are passed in so the writer wires the
// real git + fs closures and tests drive it hermetically.

/** The persisted memo: the committed LOC volume anchored to the HEAD it was
 * measured at. */
export interface LocMemo {
  /** Full HEAD sha the {@link added}/{@link removed} volume was measured against. */
  sha: string;
  added: number;
  removed: number;
}

export interface ResolveAttemptLocInput {
  /** Full HEAD sha of the attempt worktree. Empty when HEAD cannot be resolved
   * (unborn branch / detached probe failure) — an empty sha never memoizes, so
   * every call recomputes rather than caching a meaningless key. */
  headSha: string;
  /** Runs the actual `git diff --shortstat` (merge-base vs worktree). Invoked
   * only on a memo miss — at most once per HEAD sha. */
  compute: () => Promise<{ added: number; removed: number }>;
  /** Reads the persisted memo, or null when absent/unreadable. */
  readMemo: () => LocMemo | null;
  /** Persists the memo after a recompute. Best-effort — a write failure must not
   * fail the stamp. */
  writeMemo: (memo: LocMemo) => void;
}

/**
 * Resolve the attempt's committed LOC volume, computing the diffstat at most once
 * per commit. When the persisted memo already matches {@link
 * ResolveAttemptLocInput.headSha} the memoized volume is returned WITHOUT calling
 * {@link ResolveAttemptLocInput.compute} (zero git subprocesses); otherwise the
 * diffstat is computed once, persisted against the current sha, and returned. A
 * falsy/empty sha always recomputes (it is never a stable memo key).
 */
export async function resolveAttemptLoc(
  input: ResolveAttemptLocInput,
): Promise<{ added: number; removed: number }> {
  const { headSha, compute, readMemo, writeMemo } = input;
  if (headSha) {
    const memo = readMemo();
    if (memo && memo.sha === headSha) {
      return { added: memo.added, removed: memo.removed };
    }
  }
  const { added, removed } = await compute();
  if (headSha) writeMemo({ sha: headSha, added, removed });
  return { added, removed };
}

/** Default on-disk location of an attempt's LOC memo, beside its state file. */
export function locMemoPath(attemptDir: string, sep = "/"): string {
  return `${attemptDir}${sep}.loc-memo.json`;
}
