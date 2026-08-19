// core/loc-memo.ts — commit-anchored LOC memo for /afk attempt worktrees.
//
// Issue #1210 (Part B): the statusline/monitor render paths must NEVER shell out
// to `git diff --shortstat` — that ownership moves to the WRITERS (the per-attempt
// heartbeat and/or post-commit hook), which stamp `loc_added`/`loc_removed` into
// `afk.state.toon` for ALL runners (codex included — the writer is runner-agnostic,
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
  /** Runs the actual `git diff --shortstat` for the COMMITTED delta
   * (merge-base..HEAD). Invoked only on a memo miss — at most once per HEAD sha.
   */
  compute: () => Promise<{ added: number; removed: number }>;
  /** Reads the persisted memo, or null when absent/unreadable. */
  readMemo: () => LocMemo | null;
  /** Persists the memo after a recompute. Best-effort — a write failure must not
   * fail the stamp. */
  writeMemo: (memo: LocMemo) => void;
  /**
   * Optional: runs the UNCOMMITTED working-tree delta (`git diff --shortstat
   * HEAD`). Unlike {@link compute} this is NEVER memoized — it is recomputed on
   * EVERY writer tick, because the working tree changes without HEAD moving.
   *
   * #1224 Part A: a codex worker does not commit incrementally, so its HEAD sha
   * never advances during an attempt. Memoizing the combined committed+uncommitted
   * diff on HEAD sha therefore froze the first tick's `+0 -0` for the whole run.
   * Splitting the two — committed sha-memoized, uncommitted recomputed each tick —
   * lets the per-worker LOC reflect total attempt work even with zero commits,
   * without regressing the claude incremental-commit path (a new commit still
   * moves the committed delta into the sha-keyed memo). When omitted, behaviour is
   * exactly the legacy committed-only memo.
   */
  computeUncommitted?: () => Promise<{ added: number; removed: number }>;
}

/**
 * Resolve the attempt's LOC volume: the COMMITTED delta computed at most once per
 * commit, PLUS (when {@link ResolveAttemptLocInput.computeUncommitted} is
 * supplied) the UNCOMMITTED working-tree delta recomputed on every call. When the
 * persisted memo already matches {@link ResolveAttemptLocInput.headSha} the
 * committed volume is served WITHOUT calling {@link
 * ResolveAttemptLocInput.compute} (zero git subprocesses for the committed part);
 * otherwise it is computed once, persisted against the current sha, and returned.
 * A falsy/empty sha always recomputes the committed part (it is never a stable
 * memo key). The uncommitted part, being working-tree state, is always recomputed
 * — that is what lets a non-committing (codex) attempt still surface its LOC.
 */
export async function resolveAttemptLoc(
  input: ResolveAttemptLocInput,
): Promise<{ added: number; removed: number }> {
  const { headSha, compute, readMemo, writeMemo, computeUncommitted } = input;
  let committed: { added: number; removed: number } | null = null;
  if (headSha) {
    // The `readMemo` contract is "null when absent/unreadable", but a writer that
    // backs it with a raw `readFileSync` throws ENOENT on the ALWAYS-absent first
    // tick (and a codex worker, which never commits, has no memo at all). A memo
    // read must never kill the loc stamp: fail closed to a miss and recompute.
    // This is the codex permanent `+0 -0` fix — the heartbeat's async body used to
    // die on this throw before it ever stamped loc or wrote its record.
    let memo: LocMemo | null;
    try {
      memo = readMemo();
    } catch {
      memo = null;
    }
    if (memo && memo.sha === headSha) {
      committed = { added: memo.added, removed: memo.removed };
    }
  }
  if (committed === null) {
    committed = await compute();
    if (headSha) writeMemo({ sha: headSha, added: committed.added, removed: committed.removed });
  }
  if (!computeUncommitted) return committed;
  const uncommitted = await computeUncommitted();
  return {
    added: committed.added + uncommitted.added,
    removed: committed.removed + uncommitted.removed,
  };
}

/** Default on-disk location of an attempt's LOC memo, beside its state file. */
export function locMemoPath(attemptDir: string, sep = "/"): string {
  return `${attemptDir}${sep}.loc-memo.json`;
}
