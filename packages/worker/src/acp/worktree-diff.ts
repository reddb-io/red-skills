/**
 * worktree-diff — how much this Worker has actually produced, measured by the
 * Worker, in its own Worktree (#4286 follow-up).
 *
 * **The measurement belongs where the Worktree is.** The statusline's `loc=`
 * cell answers the one question no other cell on the Worker row answers — is
 * this Worker producing anything, or is it alive and idle — and the daemon
 * cannot answer it. It holds no checkout: deriving the figure daemon-side would
 * be a git walk per render, against a directory the daemon only knows the path
 * of. So the Worker measures its own diff ONCE PER STAGE TRANSITION and pulses
 * the pair; the daemon stores what it was handed and the renderer prints it,
 * exactly as `phase` and `step` already travel.
 *
 * **One diff, against the merge base, including uncommitted work.** Two diffs
 * summed — `base...HEAD` for the commits plus `HEAD` for the working tree —
 * double-count every line a later edit touched again, so the cell would climb
 * while the branch stood still. `git merge-base` then a single `git diff` from
 * that commit to the WORKING TREE is one coherent diff: it holds the committed
 * rounds and the round the implementer is still typing, each line once. An
 * agent mid-implement has committed nothing, and the cell still moves.
 *
 * The one thing it does not see is an untracked file, which git will not
 * diffstat without being told the file exists. Counting those means reading
 * arbitrary files on every stage transition, which is the per-render cost this
 * module exists to refuse — and the round's commit brings them in a stage later.
 *
 * **A measurement that could delay a stage is not taken.** The read is bounded
 * by {@link WORKTREE_DIFF_TIMEOUT_MS} and every failure — no merge base, a
 * shallow clone, a git that never answered — returns `null`, which renders as
 * an ABSENT cell. `loc=0` is a Worker that has produced nothing; absence is a
 * Worker nobody measured, and the two must never be spelled the same way.
 */
import { execFile } from "node:child_process";

/** The signed pair one Worktree's diff comes to. */
export interface WorktreeDiffStat {
  readonly added: number;
  readonly removed: number;
}

/**
 * How long the Worker waits for git before giving the cell up.
 *
 * Generous against a cold page cache on a large repository, and far short of
 * anything a stage transition would notice. The bound is enforced by
 * `execFile`'s own kill, so nothing here polls and no wait is declared.
 */
export const WORKTREE_DIFF_TIMEOUT_MS = 5_000;

/** How a command was run; the seam a test drives without a git on PATH. */
export type WorktreeDiffExec = (
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string }>;

export interface WorktreeDiffOptions {
  /** The Worker's own checkout — `held.request.cwd`, never another Worker's. */
  readonly worktree: string;
  /** The trunk the Ticket is opened against, from the handoff. */
  readonly base: string;
  readonly timeoutMs?: number;
  readonly exec?: WorktreeDiffExec;
}

/**
 * Sum one `git diff --numstat` output. PURE.
 *
 * A binary file reports `-` on both sides rather than a count; it is skipped
 * instead of read as zero, because a binary asset is not a line of work and
 * `Number("-")` is `NaN` waiting to poison the total.
 */
export function parseNumstat(output: string): WorktreeDiffStat {
  let added = 0;
  let removed = 0;
  for (const line of output.split("\n")) {
    const [left, right] = line.split("\t");
    if (left == null || right == null) continue;
    const plus = Number(left);
    const minus = Number(right);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
    added += plus;
    removed += minus;
  }
  return { added, removed };
}

/**
 * Measure this Worktree against the Ticket's base, or say nothing.
 *
 * The merge base is asked for first so a base branch that has advanced since
 * the Worker cut its branch does not show up as the Worker DELETING the lines
 * trunk gained. When git cannot name one — a fixture repository, a shallow
 * clone, a first commit — the diff is taken from the base ref directly, and
 * only a base that is not a commit at all gives up.
 */
export async function measureWorktreeDiff(
  options: WorktreeDiffOptions,
): Promise<WorktreeDiffStat | null> {
  const run = options.exec ?? gitExec(options.worktree, options.timeoutMs ?? WORKTREE_DIFF_TIMEOUT_MS);
  const mergeBase = await run(["merge-base", options.base, "HEAD"]);
  const from = mergeBase.code === 0 ? mergeBase.stdout.trim() : options.base;
  if (from === "") return null;
  const diff = await run(["diff", "--numstat", from]);
  return diff.code === 0 ? parseNumstat(diff.stdout) : null;
}

/** One bounded `git` in the Worktree; a git that never answered is `code` non-zero. */
function gitExec(worktree: string, timeoutMs: number): WorktreeDiffExec {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "git",
        [...args],
        { cwd: worktree, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => {
          resolve({ code: error == null ? 0 : 1, stdout: String(stdout) });
        },
      );
    });
}
