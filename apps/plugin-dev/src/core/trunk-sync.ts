// trunk-sync — in-attempt trunk synchronisation (issue #2481, item 2).
//
// A long attempt never pulled `origin/<trunk>` into its working branch, so the
// drift between the branch's base and live trunk only ever grew: five sequential
// workers once carried 65 micro-commits on a base twelve hours stale while main
// merged ten PRs, and the landing rebase then replayed every one of them into the
// same conflicts. The cure is to keep the drift SMALL: at each iteration boundary
// merge the fetched trunk into the working branch, so conflicts surface while the
// inner agent is still present to resolve them.
//
// A MERGE, not a rebase: the branch is already pushed (continuous push), so
// rewriting its history mid-attempt would force a force-push race with the
// running agent. The landing squash (`preMergeRebase`) collapses the merge
// commits anyway, so the micro-history costs nothing downstream.

import type { Exec } from "./merge.js";

/** What one in-attempt trunk sync did. */
export type TrunkSyncStatus =
  | "current" // the branch already contains the fetched trunk tip — nothing to do
  | "synced" // trunk was merged into the working branch
  | "conflict" // the merge conflicted; it was aborted and handed to the agent
  | "dirty" // uncommitted work in the worktree — never merge over an agent's WIP
  | "failed"; // the fetch or the probe could not run

export interface TrunkSyncResult {
  status: TrunkSyncStatus;
  /** Commits the branch is behind the fetched trunk tip, when measured. */
  behind?: number;
}

export interface TrunkSyncInput {
  /** Dir passed to `git -C` — the attempt's own worktree. */
  repo: string;
  /** Remote name (e.g. `origin`). */
  remote: string;
  /** Trunk branch to pull in (e.g. `main`). */
  base: string;
}

/**
 * Merge `<remote>/<base>` into the attempt's working branch (issue #2481).
 *
 * Refuses on a dirty worktree — an in-flight edit is the agent's, and no
 * background sync may risk it. A conflicting merge is ABORTED rather than left
 * half-applied: the worktree stays usable, and {@link renderTrunkSyncNote} hands
 * the agent an explicit instruction to redo the merge and resolve it as its next
 * action. Every failure is non-fatal — the attempt continues on its old base,
 * exactly as it did before this existed.
 */
export async function syncTrunkIntoBranch(exec: Exec, input: TrunkSyncInput): Promise<TrunkSyncResult> {
  const { repo, remote, base } = input;
  const baseRef = `${remote}/${base}`;
  const fetch = await exec(["git", "-C", repo, "fetch", remote, base, "--quiet"]);
  if (fetch.code !== 0) return { status: "failed" };

  const behindCount = await exec(["git", "-C", repo, "rev-list", "--count", `HEAD..${baseRef}`]);
  const behind = Number.parseInt(behindCount.stdout.trim(), 10);
  if (behindCount.code !== 0 || !Number.isFinite(behind)) return { status: "failed" };
  if (behind === 0) return { status: "current", behind: 0 };

  const status = await exec(["git", "-C", repo, "status", "--porcelain"]);
  if (status.code !== 0) return { status: "failed", behind };
  if (status.stdout.trim().length > 0) return { status: "dirty", behind };

  const merge = await exec(["git", "-C", repo, "merge", "--no-edit", "--no-verify", baseRef]);
  if (merge.code !== 0) {
    await exec(["git", "-C", repo, "merge", "--abort"]);
    return { status: "conflict", behind };
  }
  return { status: "synced", behind };
}

/**
 * The note carried into the NEXT iteration's handoff, or `undefined` when the
 * sync changed nothing worth telling the agent. A conflict is not a footnote —
 * it becomes the agent's first instruction, because deferring it to landing is
 * exactly the pathology this module exists to prevent.
 */
export function renderTrunkSyncNote(result: TrunkSyncResult, base: string): string | undefined {
  const behind = result.behind ?? 0;
  switch (result.status) {
    case "synced":
      return (
        `Trunk sync: \`origin/${base}\` had moved ${behind} commit(s) ahead and was merged ` +
        "into your branch. Re-read any file you were mid-way through — it may have changed."
      );
    case "conflict":
      return (
        `Trunk sync: merging \`origin/${base}\` (${behind} commit(s) ahead) CONFLICTS with your branch, ` +
        "and the merge was aborted so your worktree stays clean. FIRST, before any other work: run " +
        `\`git merge origin/${base}\`, resolve every conflict honoring both sides, and commit. ` +
        "Resolving now, while the drift is small, is far cheaper than at landing."
      );
    case "dirty":
      return (
        `Trunk sync: \`origin/${base}\` is ${behind} commit(s) ahead but the worktree had uncommitted ` +
        `changes, so nothing was merged. Commit your work, then run \`git merge origin/${base}\`.`
      );
    default:
      return undefined;
  }
}
