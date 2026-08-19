// worktree-plan.ts — resolve a worktree request into a lane path, a branch and
// a base ref. PURE: no git, no fs.
//
// The three-part incantation this replaces is in CLAUDE.md, and it has three
// ways to go wrong that a reader cannot see:
//
//   1. the LANE — a worktree outside `.red/tmp/` is refused by the command
//      guard, whose "allowed root" is resolved from the CURRENT directory, so
//      running it from inside another worktree nests one inside the other;
//   2. the BASE — `git worktree add <dir> <branch>` resolves the LOCAL ref,
//      which can trail `origin/<branch>`, so the work is built on a stale tip
//      and the push comes back non-fast-forward;
//   3. the DIRECTION — a NEW branch takes `-b` off a base, an EXISTING one
//      takes `-B` off `origin/<branch>` after a fetch, and using one form for
//      the other silently does the wrong thing.
//
// All three are decided here, once, from what the caller asked for.

/** Lane a plan lands in. Mirrors the ADR 0098 worktree registry. */
export type WorktreeLane =
  | "manual"
  | "feedback"
  | "landing"
  | "rebase"
  | "cascade"
  | "adopt"
  | "reconcile"
  | "docs";

export const DEFAULT_WORKTREE_LANE: WorktreeLane = "manual";

export interface WorktreePlanRequest {
  /** A slug, `#123`, or `123`. */
  readonly target: string;
  readonly lane?: WorktreeLane;
  /** Base to branch FROM for a new branch. Defaults to `origin/<trunk>`. */
  readonly base?: string;
  /** Branch name override. Ignored when `checkout` is set. */
  readonly branch?: string;
  /** An EXISTING branch to check out instead of creating one. */
  readonly checkout?: string;
  /** The repo's trunk, used to build the default base. */
  readonly trunk?: string;
  /** Issue title, when the caller resolved one for a `#123` target. */
  readonly issueTitle?: string;
}

export interface WorktreePlan {
  readonly lane: WorktreeLane;
  /** Repo-relative directory the worktree lands in. */
  readonly directory: string;
  readonly branch: string;
  /** The ref the worktree is created from — always a REMOTE ref. */
  readonly base: string;
  /** True when checking out an existing branch (`-B`) rather than creating one (`-b`). */
  readonly existing: boolean;
  /** The exact argv, so what runs and what a doc shows can never disagree. */
  readonly argv: readonly string[];
}

/** Lowercase, hyphenated, trimmed to a readable length. */
export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLength).replace(/-+$/, "");
}

/** The issue number a `#123`/`123` target names, or null for a slug. */
export function issueNumberOf(target: string): number | null {
  const match = /^#?(\d+)$/.exec(target.trim());
  return match ? Number(match[1]) : null;
}

export function planWorktree(request: WorktreePlanRequest): WorktreePlan {
  const target = request.target.trim();
  if (target === "") throw new Error("worktree target must not be empty");
  const lane = request.lane ?? DEFAULT_WORKTREE_LANE;
  const trunk = request.trunk ?? "main";
  const issue = issueNumberOf(target);

  if (request.checkout !== undefined && request.checkout !== "") {
    const branch = request.checkout;
    return {
      lane,
      directory: `.red/tmp/worktrees/${lane}/${slugify(branch)}`,
      branch,
      // An existing branch is taken from ORIGIN, never from the local ref: the
      // local one can trail, and building on a stale tip is not visible until
      // the push is refused.
      base: `origin/${branch}`,
      existing: true,
      argv: ["worktree", "add", `.red/tmp/worktrees/${lane}/${slugify(branch)}`, "-B", branch, `origin/${branch}`],
    };
  }

  const named = issue === null
    ? slugify(target)
    : slugify(request.issueTitle === undefined ? `${issue}` : `${issue}-${request.issueTitle}`);
  if (named === "") throw new Error(`worktree target "${target}" has no usable slug`);
  const branch = request.branch ?? (issue === null ? `afk/${named}` : `afk/${named}`);
  const base = request.base ?? `origin/${trunk}`;
  const directory = `.red/tmp/worktrees/${lane}/${named}`;

  return {
    lane,
    directory,
    branch,
    base,
    existing: false,
    argv: ["worktree", "add", directory, "-b", branch, base],
  };
}
