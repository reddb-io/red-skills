// Continuous remote-branch push for AFK workers (issue #191).
//
// Remote namespace:
//   - afk/{issue}-{slug}                   deterministic live-issue namespace.
//   - afk/{worker}/{issue}-{slug}          legacy live-iteration namespace.
//       push_initial at worktree-create, post-commit hook syncs every commit,
//       delete_remote on DONE. Mirrors HEAD so a SIGKILL preserves the diff and
//       terminal failures have a durable forensic ref without a snapshot branch.
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

/** Tri-state push contract (#2811). A consumer that only reads `ok` cannot tell
 * "the git call never ran" from "it ran and the remote refused it", and both
 * were being reported to humans as *the push failed*:
 *
 *   - `skipped` — input validation refused; no git call was made.
 *   - `failed`  — the push ran, exited non-zero, AND the remote ref does not
 *                 carry the local tip. Nothing reached origin.
 *   - `pushed`  — the branch is on origin at the local tip. Includes a non-zero
 *                 exec whose ref check proves the remote already carries the
 *                 work (a concurrent/duplicate push, a `--force-with-lease`
 *                 race): a successful push is NEVER recorded as a failed push.
 */
export type RemoteBranchStatus = "skipped" | "pushed" | "failed";

/** Outcome of a best-effort remote operation. `ran` is false when input
 * validation skipped the git call entirely (empty branch / malformed ref). */
export interface RemoteBranchOutcome {
  ok: boolean;
  ran: boolean;
  status: RemoteBranchStatus;
  warn?: string;
}

export type RemoteNamespace = "afk";

const SLUG_RE = /^[a-z0-9-]+$/;
const ISSUE_RE = /^[0-9]+$/;
const REF_RE = /^afk\/(?:[0-9]+-[a-z0-9-]+|[A-Za-z0-9._-]+\/[0-9]+-[a-z0-9-]+)$/;

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

/** True for a well-formed live worker ref. Mirrors afk_ref_validate. */
export function isValidRef(ref: string): boolean {
  return REF_RE.test(ref);
}

/** Build the deterministic `{namespace}/{issue}-{slug}` ref from a pre-built
 * slug. `worker` is retained as a compatibility parameter for callers that also
 * record worker provenance, but it is deliberately absent from the ref: every
 * attempt for one issue must collide on the same GitHub head branch (#2416).
 * Returns null on malformed issue/slug input. */
export function buildRefFromSlug(
  namespace: RemoteNamespace,
  _worker: string,
  issue: string | number,
  slug: string,
): string | null {
  if (namespace !== "afk") return null;
  // ISSUE_RE matches branch-ref.sh's `^[0-9]+$` exactly — it intentionally
  // accepts a leading-zero token (e.g. "01"), unlike worker-paths.ts.
  const issueToken = typeof issue === "number" ? String(issue) : issue;
  if (!ISSUE_RE.test(issueToken)) return null;
  if (!SLUG_RE.test(slug)) return null;
  const ref = `${namespace}/${issueToken}-${slug}`;
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

/** argv for the direct live-branch push used by landing/reconcile handoffs:
 * a plain `<branch>:refs/heads/<remote>` refspec — no -u, no --force-with-lease. */
export function pushAttemptArgs(repoDir: string, branch: string, remoteName: string): string[] {
  return ["-C", repoDir, "push", "origin", `${branch}:refs/heads/${remoteName}`];
}

/** argv resolving a local ref to its sha (push verification, #2811). */
export function localShaArgs(repoDir: string, ref: string): string[] {
  return ["-C", repoDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
}

/** argv resolving the remote head's sha (push verification, #2811). */
export function remoteShaArgs(repoDir: string, remoteName: string): string[] {
  return ["-C", repoDir, "ls-remote", "origin", `refs/heads/${remoteName}`];
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
    return { ok: true, ran: false, status: "skipped", warn: "push_initial called with empty worktree or branch — skipping" };
  }
  const { code } = await git(pushInitialArgs(worktree, branch));
  if (code !== 0) {
    return { ok: true, ran: true, status: "failed", warn: `initial push for ${branch} failed, continuing without remote backup` };
  }
  return { ok: true, ran: true, status: "pushed" };
}

/** Body of the executable post-commit hook installed into a worktree's gitdir.
 * The `|| true` guard keeps the hook a pure side-effect — a failed push never
 * affects the commit. stderr is NOT suppressed: push failures surface in the
 * agent stream and in the teardown safety-push's unpushed-commit count. */
export const POST_COMMIT_HOOK_BODY = [
  "#!/usr/bin/env bash",
  "# AFK continuous-push hook (issue #191)",
  "# Fire-and-forget: push the worker branch to origin after every commit so a",
  "# SIGKILL of the orchestrator at any point preserves the diff on the remote.",
  "git push origin HEAD --force-with-lease || true",
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
    return { ok: true, ran: false, status: "skipped", warn: "delete_remote called with empty branch — skipping" };
  }
  if (!isValidRef(branch)) {
    return { ok: true, ran: false, status: "skipped", warn: `delete_remote called with non-live branch ${branch} — skipping` };
  }
  const { code } = await git(deleteRemoteArgs(repoDir, branch));
  if (code !== 0) {
    return {
      ok: true,
      ran: true,
      status: "failed",
      warn: `failed to delete remote ${branch} after close, branch survives on origin for cleanup later`,
    };
  }
  return { ok: true, ran: true, status: "pushed" };
}

/** Push a live worker branch to another live worker ref. Returns ok:false
 * (caller warns) on a non-zero exec, never throws. Empty or non-live refs skip
 * the git call (ran:false). */
export async function pushAttempt(
  git: GitExec,
  repoDir: string,
  branch: string,
  remoteName: string,
): Promise<RemoteBranchOutcome> {
  if (!branch || !remoteName) {
    return { ok: false, ran: false, status: "skipped", warn: "push_attempt called with empty branch or remote — skipping" };
  }
  if (!isValidRef(branch) || !isValidRef(remoteName)) {
    return { ok: false, ran: false, status: "skipped", warn: "push_attempt called with non-live branch or remote — skipping" };
  }
  const { code } = await git(pushAttemptArgs(repoDir, branch, remoteName));
  if (code !== 0) {
    // #2811: a non-zero push is EVIDENCE OF NOTHING until the remote ref is
    // read. A concurrent post-commit-hook push, a stale `--force-with-lease`
    // lease, or a transient forge hiccup on a ref that already advanced all
    // exit non-zero while origin carries the exact work. Recording those as a
    // failed push stranded 624 committed lines on a branch nobody looked at.
    const verified = await verifyPushed(git, repoDir, branch, remoteName);
    if (verified.pushed) {
      return {
        ok: true,
        ran: true,
        status: "pushed",
        warn: `push to origin/${remoteName} exited non-zero but origin already carries ${verified.sha} — the push succeeded`,
      };
    }
    return { ok: false, ran: true, status: "failed", warn: `failed to push attempt branch to origin/${remoteName}` };
  }
  return { ok: true, ran: true, status: "pushed" };
}

/** Read a ref's sha, or "" when it does not resolve. */
async function shaOf(git: GitExec, args: string[], pick: (stdout: string) => string): Promise<string> {
  try {
    const { code, stdout } = await git(args);
    if (code !== 0) return "";
    return pick(stdout).trim();
  } catch {
    return "";
  }
}

/**
 * Prove — or refuse to assume — that `branch` reached `origin/<remoteName>`
 * (#2811). The remote ref either exists at the local tip or it does not, and
 * reading it is one cheap `ls-remote`. Any inability to resolve either side is
 * reported as NOT pushed: this verifier only ever turns a reported failure into
 * a success on positive evidence, never the reverse.
 */
export async function verifyPushed(
  git: GitExec,
  repoDir: string,
  branch: string,
  remoteName: string,
): Promise<{ pushed: boolean; sha: string; remoteSha: string }> {
  const local = await shaOf(git, localShaArgs(repoDir, branch), (out) => out);
  const remote = await shaOf(git, remoteShaArgs(repoDir, remoteName), (out) => out.split(/\s+/)[0] ?? "");
  return { pushed: local !== "" && local === remote, sha: local, remoteSha: remote };
}
