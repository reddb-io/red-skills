/**
 * index-lock — reclaiming an abandoned `.git/index.lock` without robbing a racer.
 *
 * It sits apart from the merge flow because it is a claim about one file and two
 * processes, not about merging: the same contention reaches the local trunk
 * fast-forward, a Worker preparing its branch, and anything else that writes an
 * index in a repository several Workers share.
 */
import type { Exec, ExecResult } from "./merge.js";

export interface IndexLockRetry {
  readonly result: ExecResult;
  readonly reclaimed: boolean;
  readonly refusal?: string;
}

/**
 * How old an empty `.git/index.lock` must be before it counts as abandoned.
 *
 * One minute is far past the milliseconds Git spends between creating the lock
 * and renaming the finished index over it, and far short of any wait an operator
 * would notice. The number exists to separate two states that `stat` and `fuser`
 * report identically: a lock nobody will ever come back for, and a lock whose
 * owner is mid-write.
 */
const ORPHANED_INDEX_LOCK_MIN_AGE_MINUTES = 1;

/**
 * Did this Git failure come from the index lock? PURE.
 *
 * Two spellings, because Git names the same contention from both ends. The
 * process that could not TAKE the lock says `index.lock`; the process whose lock
 * was taken away mid-write says `could not write new index file`, naming no lock
 * at all. Matching only the first left the second as an unexplained boot error
 * with no route to the retry that would have cured it.
 */
function failedOnIndexLock(result: ExecResult): boolean {
  if (result.code === 0) return false;
  const output = `${result.stderr}\n${result.stdout}`;
  if (/could not write new index file/i.test(output)) return true;
  return /(?:^|[/\\])index\.lock(?:['":\s]|$)/i.test(output);
}

/**
 * Retry one index-writing Git command after the only safe lock reclamation:
 * the lock is zero bytes and `fuser` reports that no live process has it open.
 * `fuser` is the kernel-backed ownership answer; an absent tool or ambiguous
 * result refuses closed. A new Git process cannot race the unlink by adopting
 * this existing lock — Git acquires it with exclusive creation.
 */
export async function retryAfterOrphanedIndexLock(
  exec: Exec,
  gitRepo: string,
  args: string[],
): Promise<IndexLockRetry> {
  const first = await exec(args);
  if (!failedOnIndexLock(first)) return { result: first, reclaimed: false };

  const lockPath = `${gitRepo}/.git/index.lock`;
  const measured = await exec(["stat", "-c", "%s", lockPath]);
  if (measured.code !== 0) {
    // The owner may have completed between Git's refusal and inspection. With
    // no lock left to reclaim, one bounded retry is safe and avoids a false halt.
    return { result: await exec(args), reclaimed: false };
  }
  const size = measured.stdout.trim();
  if (!/^\d+$/.test(size)) {
    return {
      result: first,
      reclaimed: false,
      refusal: "condition failed: index-lock (could not determine .git/index.lock size)",
    };
  }
  if (size !== "0") {
    return {
      result: first,
      reclaimed: false,
      refusal: `condition failed: index-lock (non-empty .git/index.lock has ${size} byte(s))`,
    };
  }

  const held = await exec(["fuser", "--silent", lockPath]);
  if (held.code === 0) {
    return {
      result: first,
      reclaimed: false,
      refusal: "condition failed: index-lock (empty .git/index.lock is held by a live process)",
    };
  }
  // `fuser` answers "is it open NOW", and a lock Git created microseconds ago is
  // zero bytes and not yet open for write — indistinguishable from an orphan by
  // size and ownership alone. Deleting one produces `fatal: Could not write new
  // index file` in the process that created it, which is a birth-killing error
  // carrying no hint of who took its lock. Age is the discriminator the other two
  // conditions cannot supply: an abandoned lock is left by a process that already
  // died, so it is old, while the racer's lock is younger than the window it takes
  // Git to write and rename. Refusing a young lock costs one retry; reclaiming it
  // costs another Worker its boot.
  const aged = await exec(["find", lockPath, "-mmin", `+${ORPHANED_INDEX_LOCK_MIN_AGE_MINUTES}`]);
  if (aged.code !== 0 || aged.stdout.trim() === "") {
    return {
      result: first,
      reclaimed: false,
      refusal:
        `condition failed: index-lock (empty .git/index.lock is younger than ` +
        `${ORPHANED_INDEX_LOCK_MIN_AGE_MINUTES}m, so it may belong to a Git process still acquiring it)`,
    };
  }
  if (held.code !== 1) {
    return {
      result: first,
      reclaimed: false,
      refusal: "condition failed: index-lock (could not prove .git/index.lock is unheld)",
    };
  }

  const removed = await exec(["rm", "--", lockPath]);
  if (removed.code !== 0) {
    return {
      result: first,
      reclaimed: false,
      refusal: "condition failed: index-lock (could not reclaim empty unheld .git/index.lock)",
    };
  }
  return { result: await exec(args), reclaimed: true };
}

