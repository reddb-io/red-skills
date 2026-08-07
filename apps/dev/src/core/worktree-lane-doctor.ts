// worktree-lane-doctor.ts — every git worktree of this repo, judged against the
// ADR 0098 lane registry. PURE: git's answer is injected.
//
// Why the inventory comes from GIT and not from a sweep of `.red/`.
//
// The `.red` taxonomy audit walks `.red/` and reports lanes it does not
// recognise, which makes it blind by construction to a worktree created
// ANYWHERE ELSE. That was fine while the only way to make one was
// `git worktree add` through a shell, because the dev command guard intercepts
// that and refuses a path outside `.red/tmp/`.
//
// Host CLIs now mint worktrees themselves — `claude --worktree`, and the
// `.muse/worktrees/<repo>-<uuid>` this repo was already carrying. A flag is
// resolved before any tool call exists, so a pre-exec hook structurally cannot
// see it: it is a birth path outside the thing that judges births, the same
// shape ADR 0130 closed for Workers.
//
// So the question stops being "is there an unknown directory under `.red/`" and
// becomes "does every worktree git knows about live in a lane we own". Git
// already keeps that list, and it answers for hosts that do not exist yet.

/** One worktree as `git worktree list --porcelain` reports it. */
export interface WorktreeFact {
  /** Absolute path git reports. */
  readonly path: string;
  /** Branch ref when checked out, absent when detached. */
  readonly branch?: string;
}

export type WorktreeLaneFindingKind = "unregistered-lane";

export interface WorktreeLaneFinding {
  readonly path: string;
  readonly kind: WorktreeLaneFindingKind;
  readonly verdict: "warn";
  readonly reason: string;
  readonly canonicalFix: string;
}

export interface WorktreeLaneReport {
  readonly verdict: "ok" | "warn";
  readonly checked: number;
  readonly findings: readonly WorktreeLaneFinding[];
}

/** Worktree lanes ADR 0098 registers under `.red/tmp/worktrees/`. */
export const REGISTERED_WORKTREE_LANES: readonly string[] = [
  "manual",
  "feedback",
  "landing",
  "rebase",
  "cascade",
  "adopt",
  "reconcile",
  "docs",
];

/**
 * Hosts known to mint their own worktrees, named so the finding says WHO rather
 * than only WHERE. An unlisted host still gets the finding — it just gets it
 * without a name, which is the honest report rather than a silent pass.
 */
const HOST_LANES: Readonly<Record<string, string>> = {
  ".muse/worktrees": "a Muse `--worktree` run",
  ".claude/worktrees": "a Claude Code `--worktree` run",
  ".codex/worktrees": "a Codex worktree run",
};

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The repo-relative path, or null when the worktree lies outside the root. */
function relativeTo(root: string, path: string): string | null {
  const [r, p] = [normalise(root), normalise(path)];
  if (p === r) return "";
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

function laneIsRegistered(relative: string): boolean {
  const parts = relative.split("/");
  // `.red/tmp/worktrees/<lane>/…`
  if (parts[0] === ".red" && parts[1] === "tmp" && parts[2] === "worktrees") {
    return parts[3] !== undefined && REGISTERED_WORKTREE_LANES.includes(parts[3]);
  }
  // The AFK/`/go`/scout Worker worktree sits at `.red/tmp/<lane>/{id}/{issue}/worktree`.
  if (parts[0] === ".red" && parts[1] === "tmp" && parts[2] !== undefined) {
    const workerLane = ["workers", "go-workers", "scout-workers"].includes(parts[2]);
    return workerLane && parts.at(-1) === "worktree";
  }
  return false;
}

/** Name the host when we recognise its lane; otherwise say plainly that we do not. */
function origin(relative: string): string {
  for (const [prefix, described] of Object.entries(HOST_LANES)) {
    if (relative === prefix || relative.startsWith(`${prefix}/`)) return described;
  }
  return "an unrecognised creator";
}

/**
 * Judge every worktree git reports. The PRIMARY checkout is never a finding —
 * it is the repo, not a lane.
 */
export function auditWorktreeLanes(root: string, worktrees: readonly WorktreeFact[]): WorktreeLaneReport {
  const findings: WorktreeLaneFinding[] = [];
  for (const worktree of worktrees) {
    const relative = relativeTo(root, worktree.path);
    // The primary checkout, and any worktree parked outside the repo entirely —
    // the latter is beyond this repo's lanes to govern, and saying otherwise
    // would redden a maintainer's own scratch clone somewhere else on disk.
    if (relative === "" || relative === null) continue;
    if (laneIsRegistered(relative)) continue;
    findings.push({
      path: relative,
      kind: "unregistered-lane",
      verdict: "warn",
      reason:
        `${relative} is a git worktree of this repo outside every registered lane, left by ${origin(relative)}; ` +
        "no janitor reclaims it and no doctor but this one reports it",
      canonicalFix:
        "move the work into a registered lane (`.red/tmp/worktrees/<lane>/`) and remove the worktree, " +
        "or extend ADR 0098 to register the lane it is in",
    });
  }
  return {
    verdict: findings.length === 0 ? "ok" : "warn",
    checked: worktrees.length,
    findings,
  };
}

/**
 * Parse `git worktree list --porcelain`. Kept beside the audit so the shape the
 * classifier expects and the shape git emits are read together.
 */
export function parseWorktreePorcelain(stdout: string): WorktreeFact[] {
  const facts: WorktreeFact[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (path !== undefined) facts.push({ path, ...(branch === undefined ? {} : { branch }) });
    path = undefined;
    branch = undefined;
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim();
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return facts;
}
