// Continuous remote-branch push for AFK workers (issue #191).
//
// Two remote namespaces, never overlapping:
//   - afk/{worker}/{issue}-{slug}          live-iteration namespace.
//       push_initial at worktree-create, post-commit hook syncs every commit,
//       delete_remote on DONE. Mirrors HEAD so a SIGKILL preserves the diff.
//   - afk-attempts/{worker}/{issue}-{slug} failure-only forensic namespace.
//       pushed by the terminal-failure path, never deleted by the orchestrator.
//
// This is a PURE command-construction + decision layer. Every real git call is
// routed through an injected GitExec so the exact argv is observable in tests
// without touching a repository. Live-iteration pushes use --force-with-lease
// and are best-effort: a non-zero exec is logged as a warn result, never thrown.

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitExec = (args: string[]) => Promise<GitExecResult>;

/** Outcome of a best-effort remote operation. `ran` is false when input
 * validation skipped the git call entirely (empty branch / malformed ref). */
export interface RemoteBranchOutcome {
  ok: boolean;
  ran: boolean;
  warn?: string;
}

export type RemoteNamespace = "afk" | "afk-attempts";

const SLUG_RE = /^[a-z0-9-]+$/;
const WORKER_RE = /^[A-Za-z0-9._-]+$/;
const ISSUE_RE = /^[0-9]+$/;
const REF_RE = /^afk(-attempts)?\/[A-Za-z0-9._-]+\/[0-9]+-[a-z0-9-]+$/;

/** Lowercase / collapse-to-dash / trim-dashes / cap-40 title slug. Mirrors
 * afk_ref_slugify in lib/branch-ref.sh. */
export function slugifyRef(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      // The slice can land mid-word and re-introduce a TRAILING dash after the
      // earlier trim (e.g. "…hide-a-duplicate-"). That trailing-dash slug feeds
      // the branch ref and the sandcastle worktree name, which gets normalised
      // inconsistently downstream → `fatal: … is not a working tree` (#442).
      // Re-trim trailing dashes after the slice so the slug is always clean.
      .replace(/-+$/g, "")
  );
}

/** True for a well-formed live or attempt ref. Mirrors afk_ref_validate. */
export function isValidRef(ref: string): boolean {
  return REF_RE.test(ref);
}

/** Build `{namespace}/{worker}/{issue}-{slug}` from a pre-built slug, rejecting
 * malformed inputs (mirrors afk_ref_build_from_slug). Returns null on rejection
 * so callers warn-and-skip instead of pushing a bad ref. */
export function buildRefFromSlug(
  namespace: RemoteNamespace,
  worker: string,
  issue: string | number,
  slug: string,
): string | null {
  if (namespace !== "afk" && namespace !== "afk-attempts") return null;
  if (!WORKER_RE.test(worker)) return null;
  // ISSUE_RE matches branch-ref.sh's `^[0-9]+$` exactly — it intentionally
  // accepts a leading-zero token (e.g. "01"), unlike worker-paths.ts.
  const issueToken = typeof issue === "number" ? String(issue) : issue;
  if (!ISSUE_RE.test(issueToken)) return null;
  if (!SLUG_RE.test(slug)) return null;
  const ref = `${namespace}/${worker}/${issueToken}-${slug}`;
  return isValidRef(ref) ? ref : null;
}

/** Build a ref from a raw title (slugifies first). Mirrors afk_ref_build. */
export function buildRef(
  namespace: RemoteNamespace,
  worker: string,
  issue: string | number,
  title: string,
): string | null {
  return buildRefFromSlug(namespace, worker, issue, slugifyRef(title));
}

// ---------- argv builders (pure) ----------

/** argv for the worktree-create initial push: HEAD → origin live branch with
 * upstream tracking and --force-with-lease. */
export function pushInitialArgs(worktree: string, branch: string): string[] {
  return ["-C", worktree, "push", "origin", "-u", `HEAD:refs/heads/${branch}`, "--force-with-lease"];
}

/** argv the installed post-commit hook fires after every inner-agent commit. */
export function postCommitPushArgs(): string[] {
  return ["push", "origin", "HEAD", "--force-with-lease"];
}

/** argv to delete the live remote branch from the primary checkout on DONE. */
export function deleteRemoteArgs(repoDir: string, branch: string): string[] {
  return ["-C", repoDir, "push", "origin", "--delete", branch];
}

/** argv for the failure-only afk-attempts push. Mirrors envelope_push_attempt:
 * a plain `<branch>:refs/heads/<remote>` refspec — no -u, no --force-with-lease. */
export function pushAttemptArgs(repoDir: string, branch: string, remoteName: string): string[] {
  return ["-C", repoDir, "push", "origin", `${branch}:refs/heads/${remoteName}`];
}

// ---------- best-effort operations ----------

/** Push HEAD of <worktree> to origin live branch, --force-with-lease, upstream
 * tracking. Best-effort: a non-zero exec yields a warn outcome, never throws.
 * An empty worktree or branch skips the git call (ran:false). */
export async function pushInitial(
  git: GitExec,
  worktree: string,
  branch: string,
): Promise<RemoteBranchOutcome> {
  if (!worktree || !branch) {
    return { ok: true, ran: false, warn: "push_initial called with empty worktree or branch — skipping" };
  }
  const { code } = await git(pushInitialArgs(worktree, branch));
  if (code !== 0) {
    return { ok: true, ran: true, warn: `initial push for ${branch} failed, continuing without remote backup` };
  }
  return { ok: true, ran: true };
}

/** Body of the executable post-commit hook installed into a worktree's gitdir.
 * The `|| true` guard keeps the hook a pure side-effect — a failed push never
 * affects the commit. */
export const POST_COMMIT_HOOK_BODY = [
  "#!/usr/bin/env bash",
  "# AFK continuous-push hook (issue #191)",
  "# Fire-and-forget: push the worker branch to origin after every commit so a",
  "# SIGKILL of the orchestrator at any point preserves the diff on the remote.",
  "git push origin HEAD --force-with-lease 2>/dev/null || true",
  "",
].join("\n");

/** Delete the live remote branch (DONE path) from the primary checkout.
 * Best-effort: a non-zero exec yields a warn outcome, never throws. An empty
 * branch skips the git call (ran:false). */
export async function deleteRemote(
  git: GitExec,
  repoDir: string,
  branch: string,
): Promise<RemoteBranchOutcome> {
  if (!branch) {
    return { ok: true, ran: false, warn: "delete_remote called with empty branch — skipping" };
  }
  const { code } = await git(deleteRemoteArgs(repoDir, branch));
  if (code !== 0) {
    return {
      ok: true,
      ran: true,
      warn: `failed to delete remote ${branch} after close, branch survives on origin for cleanup later`,
    };
  }
  return { ok: true, ran: true };
}

/** Failure-only push to the afk-attempts namespace. Mirrors envelope_push_attempt:
 * returns ok:false (caller warns) on a non-zero exec, never throws. An empty
 * branch or remote skips the git call (ran:false). */
export async function pushAttempt(
  git: GitExec,
  repoDir: string,
  branch: string,
  remoteName: string,
): Promise<RemoteBranchOutcome> {
  if (!branch || !remoteName) {
    return { ok: false, ran: false, warn: "push_attempt called with empty branch or remote — skipping" };
  }
  const { code } = await git(pushAttemptArgs(repoDir, branch, remoteName));
  if (code !== 0) {
    return { ok: false, ran: true, warn: `failed to push attempt branch to origin/${remoteName}` };
  }
  return { ok: true, ran: true };
}
