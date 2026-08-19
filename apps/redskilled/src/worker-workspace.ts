/**
 * worker-workspace — where a Worker's bytes live, and who deletes them.
 *
 * ADR 0149 §1: **a Worker's workspace is created by the daemon under the OS
 * temporary directory**, `os.tmpdir()/red-skills-<uid>/workers/<id>/`, forked
 * from the daemon-owned Project workspace. Nothing a Worker writes lands in the
 * human's checkout, and the daemon deletes the whole directory when the Worker
 * dies.
 *
 * The move is not tidiness. Workers materialised under the client checkout's
 * `.red/tmp/workers/` beside human worktrees, and on one developer machine that
 * lane reached 3.1 GB across 1593 directories. The janitor that swept it needed
 * three guards against deleting the wrong thing (#2679, #3650) — all three
 * because it shared a directory with live work it did not own. **A cleaner that
 * owns everything it can see needs no guards at all**, which is why the location
 * is the fix rather than a fourth guard.
 *
 * Two properties the layout is chosen for:
 *
 *   - **The uid segment is the boundary, and `0700` is the enforcement.** The OS
 *     temporary directory is shared by every user of the machine, so a workspace
 *     holding a checkout of somebody's private repository cannot be world-
 *     readable, and two operators on one host cannot land in one directory.
 *   - **The Worker id is the whole name.** It is fixed-width base62 of the birth
 *     instant (ADR 0149 §3), so a listing sorts as a timeline and pruning births
 *     older than a cutoff is a prefix scan rather than a stat of every entry.
 *
 * The daemon may find the OS has reclaimed the directory under it — that is the
 * accepted cost of the location, and precisely why the evidence a human reads
 * after a reboot lives somewhere else (ADR 0149 §2).
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 120_000;

/** The one directory name the daemon claims inside the OS temporary directory. */
export const WORKER_TMP_ROOT_PREFIX = "red-skills";

/** The lane's leaf: the parent of every Worker directory. */
const WORKERS_SEGMENT = "workers";

/** A Worker's git worktree is the conventional direct child (ADR 0105's shape, relocated). */
const WORKTREE_SEGMENT = "worktree";

/** Raised when a workspace cannot be named or released. Fail closed: no guess. */
export class WorkerWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerWorkspaceError";
  }
}

export interface WorkerWorkspaceRootOptions {
  /** The OS temporary directory. Defaults to {@link tmpdir}, which answers on Windows too. */
  readonly tmpDir?: string;
  /** The owning user. Defaults to this process's uid, or its username where there is none. */
  readonly uid?: string | number;
}

/**
 * The root every Worker workspace on this host hangs off.
 *
 * PURE apart from its two defaults, so the layout is testable without writing to
 * the real temporary directory — and so a test never has to guess which uid the
 * process it is running under resolved to.
 */
export function workerWorkspaceRoot(options: WorkerWorkspaceRootOptions = {}): string {
  const uid = options.uid ?? process.getuid?.() ?? userInfo().username;
  const segment = String(uid).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (segment === "") throw new WorkerWorkspaceError("redskilled cannot name a Worker workspace root without a user");
  return join(options.tmpDir ?? tmpdir(), `${WORKER_TMP_ROOT_PREFIX}-${segment}`, WORKERS_SEGMENT);
}

/** One Worker's whole directory: everything released when that Worker dies. */
export function workerWorkspaceDir(root: string, workerId: string): string {
  return join(root, workspaceSegment(workerId));
}

/** The git worktree the Worker actually runs in. */
export function workerWorktreePath(root: string, workerId: string): string {
  return join(workerWorkspaceDir(root, workerId), WORKTREE_SEGMENT);
}

/** A Worker workspace that exists on disk, and the facts needed to release it. */
export interface MaterializedWorkerWorkspace {
  readonly workerId: string;
  /** The host root this workspace hangs off — the containment a release checks. */
  readonly root: string;
  /** `<root>/<workerId>`: the directory deleted at death. */
  readonly workspacePath: string;
  /** `<workspacePath>/worktree`: the Worker's working directory. */
  readonly worktreePath: string;
  /**
   * The commit the fork landed on, absent when the Project workspace holds none.
   *
   * A Project workspace with no commit is legal — a generic ACP client may bind
   * a directory that is not a repository at all — and reporting `undefined`
   * beats reporting a sha nothing points at.
   */
  readonly baseCommit?: string;
}

export interface MaterializeWorkerWorkspaceInput {
  readonly root: string;
  readonly workerId: string;
  /** The daemon-owned Project workspace this Worker forks from (ADR 0144 §5). */
  readonly projectWorkspacePath: string;
  /**
   * Run git in a directory, rejecting when `required`. Injected so the layout is
   * testable without a clone.
   */
  readonly git?: (cwd: string, args: readonly string[], required?: boolean) => Promise<string | undefined>;
}

/**
 * Create one Worker's workspace, forked from the Project workspace's base commit.
 *
 * The fork is a CLONE rather than a `git worktree add`, and that is deliberate:
 * a worktree is registered in the repository it hangs off, so a Worker's would
 * appear in the Project workspace's inventory and its removal would leave a
 * stale registration behind — the failure that made the old janitor prune after
 * every sweep (#2866). A clone is registered in itself and takes the whole
 * directory with it when it goes.
 */
export async function materializeWorkerWorkspace(
  input: MaterializeWorkerWorkspaceInput,
): Promise<MaterializedWorkerWorkspace> {
  const git = input.git ?? runGit;
  const workspacePath = workerWorkspaceDir(input.root, input.workerId);
  const worktreePath = join(workspacePath, WORKTREE_SEGMENT);
  // `0700` on the way down: the OS temporary directory is shared by every user
  // of the machine, and a Worker's worktree is a checkout of somebody's code.
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });

  const isRepository = await git(input.projectWorkspacePath, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!isRepository) {
    await mkdir(worktreePath, { recursive: true, mode: 0o700 });
    return { workerId: input.workerId, root: input.root, workspacePath, worktreePath };
  }

  await git(input.projectWorkspacePath, [
    "clone",
    "--no-hardlinks",
    "--quiet",
    "--",
    input.projectWorkspacePath,
    worktreePath,
  ], true);
  const baseCommit = await git(worktreePath, ["rev-parse", "HEAD"]);
  return {
    workerId: input.workerId,
    root: input.root,
    workspacePath,
    worktreePath,
    ...(baseCommit == null ? {} : { baseCommit }),
  };
}

/**
 * Delete a dead Worker's workspace, and refuse to delete anything else.
 *
 * The containment check is not defensive habit: this is the one call in the
 * daemon that removes a directory tree recursively, and the failure it is
 * modelled on deleted a live worktree because a path was assembled from the
 * wrong two halves. A workspace carries the root it was born under, so the
 * check compares two facts rather than re-deriving one.
 *
 * Idempotent by construction — a workspace the OS already reclaimed is the
 * expected case in temporary storage, not an error.
 */
export async function releaseWorkerWorkspace(workspace: MaterializedWorkerWorkspace): Promise<void> {
  const expected = workerWorkspaceDir(workspace.root, workspace.workerId);
  if (workspace.workspacePath !== expected) {
    throw new WorkerWorkspaceError(
      `redskilled refuses to release ${JSON.stringify(workspace.workspacePath)}: Worker ` +
        `${workspace.workerId} owns ${JSON.stringify(expected)} under its host root`,
    );
  }
  await rm(workspace.workspacePath, { recursive: true, force: true });
}

/** A single path segment: never empty, never a separator, never a traversal. */
function workspaceSegment(workerId: string): string {
  const segment = workerId.trim();
  if (segment === "" || segment === "." || segment === ".." || /[/\\]/.test(segment)) {
    throw new WorkerWorkspaceError(
      `invalid Worker id ${JSON.stringify(workerId)}: it would escape the host's workspace root.`,
    );
  }
  return segment;
}

async function runGit(cwd: string, args: readonly string[], required = false): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (error != null) {
        if (required) reject(error);
        else resolve(undefined);
        return;
      }
      const value = stdout.trim();
      resolve(value === "" ? undefined : value);
    });
  });
}
