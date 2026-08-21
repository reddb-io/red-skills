/**
 * After the turn, the Worker asks its ACP parent to publish.
 *
 * The other half of the terminal policy. Refusing `git push` only teaches a
 * contract if something else keeps the promise, so when a prompt turn ends the
 * Worker reads what the inner agent committed and hands the parent the branch
 * and the commit. redskilled's Project-bound gateway performs the write; no
 * credential crosses this seam in either direction (ADR 0148, ADR 0144 §3).
 *
 * EXACTLY ONE request per turn, and none at all when there is nothing new to
 * publish. A Worker may span several prompt turns, and a second request naming
 * the commit the parent already has is not a retry — it is the same publication
 * asked for twice, which the gateway would have to deduplicate on the Worker's
 * behalf.
 */
import { execFile } from "node:child_process";
import { REDSKILLS_ACP_METHODS, type RedskilledPublishRequest } from "@reddb-io/protocol-acp";

/** The ACP method the Worker's publication request travels on. */
export const WORKER_PUBLISH_METHOD = REDSKILLS_ACP_METHODS.publish;

/** What the inner agent left behind in the Worktree, ready to publish. */
export interface WorkerPublication {
  readonly branch: string;
  readonly commit: string;
}

export interface WorkerPublisherOptions {
  /** The Worktree the inner agent committed in. */
  readonly cwd: string;
  /** Sends the request to the ACP parent; the parent owns the credential. */
  readonly request: (method: string, params: RedskilledPublishRequest) => Promise<unknown>;
  /** Stable per-Worker prefix, so a re-asked publication is the same write. */
  readonly idempotencyScope: string;
  /** Test seam over `git rev-parse`. Production reads the real Worktree. */
  readonly readPublication?: (cwd: string) => Promise<WorkerPublication | null>;
  /** Test seam over `git update-ref`. Production writes the real Worktree. */
  readonly updateRef?: (cwd: string, ref: string, commit: string) => Promise<void>;
  /**
   * The commit the Worktree held BEFORE the implementer ran (#4157). A turn
   * that produced no new commit still had a HEAD, and publishing it opened a
   * doomed land: the branch equalled main and GitHub answered "No commits
   * between". A HEAD equal to the baseline publishes nothing.
   */
  readonly baselineCommit?: string;
  /**
   * The branch this publication PUBLISHES AS, regardless of the Worktree's
   * local branch name. An inner agent that commits on `main` would otherwise
   * publish `refs/heads/main` (rejected non-fast-forward at the canonical
   * repository), and one that names its branch after an old merged branch
   * collides with the corpse (#4157: both happened in one evening). A Ticket
   * turn passes the Worker-unique ref; absent keeps the local name.
   */
  readonly publishRef?: string;
}

export interface WorkerPublisher {
  /**
   * Publish what this turn produced.
   *
   * Resolves to the publication that was asked for, or `null` when the turn
   * committed nothing new. Never rejects: a parent that cannot publish must not
   * also cost the Worker the turn's answer, so the failure is returned.
   */
  publishTurn(): Promise<WorkerPublishOutcome | null>;
}

export type WorkerPublishOutcome =
  | { readonly status: "requested"; readonly publication: WorkerPublication; readonly receipt: unknown }
  | { readonly status: "refused"; readonly publication: WorkerPublication; readonly detail: string };

export function createWorkerPublisher(options: WorkerPublisherOptions): WorkerPublisher {
  const readPublication = options.readPublication ?? readWorktreePublication;
  let published: string | undefined = options.baselineCommit;
  return {
    async publishTurn() {
      const local = await readPublication(options.cwd).catch(() => null);
      const publication = local == null
        ? null
        : options.publishRef == null ? local : { ...local, branch: options.publishRef };
      if (publication == null || publication.commit === published) return null;
      // The publish-as ref must EXIST in the Worktree: the daemon delivers by
      // fetching `refs/heads/<branch>` from here, and a name that is only a
      // request field fetches nothing ("couldn't find remote ref", #4157).
      if (options.publishRef != null) {
        const anchored = await (options.updateRef ?? updateWorktreeRef)(
          options.cwd, `refs/heads/${options.publishRef}`, publication.commit,
        ).then(() => true).catch(() => false);
        if (!anchored) {
          return {
            status: "refused",
            publication,
            detail: `the Worktree refused to anchor ${options.publishRef} at ${publication.commit}`,
          };
        }
      }
      published = publication.commit;
      const request: RedskilledPublishRequest = {
        idempotency_key: `${options.idempotencyScope}:${publication.commit}`,
        branch: publication.branch,
        commit: publication.commit,
      };
      try {
        return { status: "requested", publication, receipt: await options.request(WORKER_PUBLISH_METHOD, request) };
      } catch (error) {
        return { status: "refused", publication, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * The Worktree's current branch and commit, or `null` when there is neither.
 *
 * A detached HEAD is `null` on purpose: publication needs a ref name, and
 * guessing one for a Worker that never checked a branch out would push work
 * somewhere nobody asked for it.
 */
export async function readWorktreePublication(cwd: string): Promise<WorkerPublication | null> {
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch == null || branch === "HEAD") return null;
  const commit = await git(cwd, ["rev-parse", "HEAD"]);
  return commit == null ? null : { branch, commit };
}

/** The Worktree's HEAD commit, or null when it has none. */
export async function worktreeHead(cwd: string): Promise<string | null> {
  return await git(cwd, ["rev-parse", "HEAD"]);
}

/** Anchor the publish-as ref at the commit, so the daemon's fetch finds it. */
async function updateWorktreeRef(cwd: string, ref: string, commit: string): Promise<void> {
  const done = await git(cwd, ["update-ref", ref, commit]);
  // `update-ref` prints nothing on success, so only an error resolves null AND
  // leaves the ref absent; verify by reading it back.
  void done;
  const at = await git(cwd, ["rev-parse", ref]);
  if (at !== commit) throw new Error(`could not anchor ${ref} at ${commit}`);
}

function git(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd }, (error, stdout) => {
      resolve(error != null ? null : stdout.trim() || null);
    });
  });
}
