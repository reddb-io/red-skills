// acp-worktree — the daemon side of `worktree_add` and `worktree_list` (ADR 0150 §4).
//
// The interactive Working mode is the one a human returns to, so its worktree
// stays under the client checkout's manual lane rather than moving into the
// daemon's own storage. What moves is WHO creates it: the daemon, into a lane
// it names, forked from a trunk it fetched — not a hand-typed `git worktree
// add` whose base resolves to a LOCAL ref that can trail the remote, which is
// how work gets built on a stale tip and only the refused push says so.
//
// `worktree_list` is the other half, and the reason the pair is one slice: an
// interactive worktree lives in the client checkout and a Worker's lives in the
// daemon's storage (ADR 0149), so before this there was no single question that
// could be asked about both. Two half-inventories is the shape a worktree is
// forgotten in.
import { execFile } from "node:child_process";
import {
  REDSKILLS_ACP_METHODS,
  WORKTREE_REFUSAL_REASONS,
  WORKTREE_SCHEMA,
  emptyRedskillsParams,
  worktreeAddParams,
  worktreeRefusal,
  type WorktreeAddAnswer,
  type WorktreeAddParams,
  type WorktreeEntry,
  type WorktreeKind,
  type WorktreeListAnswer,
} from "@reddb-io/protocol-acp";

import {
  redskillsAcpMethod,
  type RedskillsAcpMethodContext,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import type { RedskilledTrunk } from "./project-registration.js";

const GIT_TIMEOUT_MS = 30_000;

/**
 * The lane an interactive worktree lands in.
 *
 * `manual` and nothing else, because it is the ONE lane ADR 0098 registers for
 * work a human returns to — and `apps/dev/tests/worktree-lane-doctor.test.ts`
 * pins this constant against that registry, so a daemon that started writing
 * into a lane the dev command proxy refuses fails in the gate rather than in a
 * human's checkout.
 */
export const REDSKILLED_INTERACTIVE_WORKTREE_LANE = "manual";

/** Where every registered worktree lane lives, relative to the checkout root. */
export const REDSKILLED_WORKTREE_LANE_ROOT = ".red/tmp/worktrees";

/** The Worker workspace lanes, whose worktree is the leaf `worktree` directory. */
const WORKER_WORKTREE_LANES = ["workers", "go-workers", "scout-workers"] as const;

/** Repo-relative directory an interactive worktree for `slug` lands in. */
export function interactiveWorktreeDirectory(slug: string): string {
  return `${REDSKILLED_WORKTREE_LANE_ROOT}/${REDSKILLED_INTERACTIVE_WORKTREE_LANE}/${slug}`;
}

/**
 * The checkout a connection may create an interactive worktree in.
 *
 * Registration is the precondition rather than a nicety: the daemon learns a
 * Project's trunk remote and branch from its REGISTRATION, so a checkout it
 * holds no registration for is one it cannot name a fresh base in. Refusing it
 * by name beats forking off a guess.
 */
export interface RedskilledRegisteredCheckout {
  readonly project_label: string;
  /** The client checkout root, as the connection's own git evidence reports it. */
  readonly checkout_root: string;
  /** The Project's git coordinates; absent on a registration too old to state them. */
  readonly trunk?: RedskilledTrunk;
}

/** One Worker worktree the daemon coordinates, as host state reports it. */
export interface RedskilledWorkerWorktree {
  readonly worker_id: string;
  readonly path: string;
}

export interface AcpWorktreeDeps {
  /**
   * The registered checkout behind this connection, or `undefined` when the
   * daemon holds no registration for the Project the connection bound.
   */
  readonly registeredCheckout: () => RedskilledRegisteredCheckout | undefined;
  /** The Worker worktrees the daemon owns for that Project. */
  readonly workerWorktrees: () => readonly RedskilledWorkerWorktree[];
  /** Run git in a directory. Injected so the domain is testable without a repo. */
  readonly git?: (cwd: string, args: readonly string[]) => Promise<string>;
}

/** The registered checkout, or the typed refusal that names the repair. */
function requireRegisteredCheckout(deps: AcpWorktreeDeps): RedskilledRegisteredCheckout {
  const checkout = deps.registeredCheckout();
  if (checkout == null) {
    throw worktreeRefusal(
      WORKTREE_REFUSAL_REASONS.checkoutNotRegistered,
      "redskilled holds no registration for this checkout's Project, so it can name neither its " +
        "trunk nor its lanes; register the Project with the daemon before asking for a worktree",
    );
  }
  return checkout;
}

/**
 * Create the human's interactive worktree, forked from the FRESH trunk.
 *
 * Fetch first, always. The base is a remote ref by construction, and the whole
 * failure this method removes is the bare `git worktree add <dir> <branch>`
 * resolving the local ref instead — invisible until the push comes back
 * non-fast-forward.
 */
export function bindAcpWorktreeAdd(deps: AcpWorktreeDeps) {
  const git = deps.git ?? runGit;
  return async (context: RedskillsAcpMethodContext<WorktreeAddParams>): Promise<WorktreeAddAnswer> => {
    const checkout = requireRegisteredCheckout(deps);
    const remote = checkout.trunk?.remote ?? "origin";
    const branchOfBase = context.params.base ?? checkout.trunk?.branch;
    if (branchOfBase == null || branchOfBase === "") {
      throw worktreeRefusal(
        WORKTREE_REFUSAL_REASONS.trunkUnknown,
        "this Project's registration states no trunk branch, so worktree_add has nothing to fork " +
          "from; name a base, or re-register with explicit git coordinates",
      );
    }
    const directory = interactiveWorktreeDirectory(context.params.slug);
    const branch = context.params.branch ?? `afk/${context.params.slug}`;
    const base = `${remote}/${branchOfBase}`;

    await git(checkout.checkout_root, ["fetch", remote, branchOfBase]);
    await git(checkout.checkout_root, ["worktree", "add", directory, "-b", branch, base]);

    return {
      version: 1,
      kind: "interactive",
      path: directory,
      branch,
      base,
      lane: REDSKILLED_INTERACTIVE_WORKTREE_LANE,
      project_label: checkout.project_label,
    };
  };
}

/**
 * The ONE inventory: the registered checkout's own worktrees, and the Workers'.
 *
 * The two halves come from different authorities and neither can see the other.
 * Git knows what hangs off the client checkout; only the daemon knows the
 * Worker worktrees, because a Worker's workspace is a clone of its own in
 * temporary storage and is registered in THAT clone, not in the human's.
 */
export function bindAcpWorktreeList(deps: AcpWorktreeDeps) {
  const git = deps.git ?? runGit;
  return async (): Promise<WorktreeListAnswer> => {
    const checkout = requireRegisteredCheckout(deps);
    const porcelain = await git(checkout.checkout_root, ["worktree", "list", "--porcelain"]);
    const checkoutWorktrees = parseWorktreePorcelain(porcelain)
      .map((fact) => classify(checkout.checkout_root, fact));
    const workerWorktrees: WorktreeEntry[] = deps.workerWorktrees().map((worker) => ({
      kind: "worker" as const,
      path: worker.path,
      branch: null,
      worker_id: worker.worker_id,
    }));
    return {
      version: 1,
      project_label: checkout.project_label,
      worktrees: [...checkoutWorktrees, ...workerWorktrees],
    };
  };
}

/** One `git worktree list --porcelain` record, as git states it. */
interface WorktreeFact {
  readonly path: string;
  readonly branch: string | null;
}

/**
 * Read git's own inventory rather than sweeping the lane directories.
 *
 * A sweep is blind by construction to a worktree created anywhere else, and a
 * host CLI's `--worktree` flag creates exactly that. Git already keeps the
 * list, and it answers for hosts that do not exist yet.
 */
export function parseWorktreePorcelain(output: string): readonly WorktreeFact[] {
  const facts: WorktreeFact[] = [];
  let path: string | undefined;
  let branch: string | null = null;
  const flush = () => {
    if (path != null) facts.push({ path, branch });
    path = undefined;
    branch = null;
  };
  for (const line of output.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("worktree ")) {
      flush();
      path = trimmed.slice("worktree ".length);
    } else if (trimmed.startsWith("branch ")) {
      branch = trimmed.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return facts;
}

/** Judge one worktree against the lanes this repo registers. */
function classify(checkoutRoot: string, fact: WorktreeFact): WorktreeEntry {
  const relative = relativeTo(checkoutRoot, fact.path);
  const kind = relative === null ? "unregistered" : kindOf(relative);
  const lane = relative === null ? undefined : laneOf(relative);
  return {
    kind,
    path: fact.path,
    branch: fact.branch,
    ...(lane === undefined ? {} : { lane }),
  };
}

function kindOf(relative: string): WorktreeKind {
  if (relative === "") return "checkout";
  const parts = relative.split("/");
  if (parts[0] !== ".red" || parts[1] !== "tmp" || parts[2] === undefined) return "unregistered";
  if (parts[2] === "worktrees") return parts[3] === undefined ? "unregistered" : "interactive";
  // A Worker's own worktree, when one happens to hang off this checkout rather
  // than off the daemon's workspace clone.
  const workerLane = (WORKER_WORKTREE_LANES as readonly string[]).includes(parts[2]);
  return workerLane && parts.at(-1) === "worktree" ? "worker" : "unregistered";
}

function laneOf(relative: string): string | undefined {
  const parts = relative.split("/");
  if (parts[0] !== ".red" || parts[1] !== "tmp") return undefined;
  if (parts[2] === "worktrees") return parts[3];
  return (WORKER_WORKTREE_LANES as readonly string[]).includes(parts[2] ?? "") ? parts[2] : undefined;
}

/** The path under `root`, `""` for the root itself, or `null` when outside it. */
function relativeTo(root: string, path: string): string | null {
  const [r, p] = [normalise(root), normalise(path)];
  if (p === r) return "";
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true }, (
      error,
      stdout,
      stderr,
    ) => {
      if (error != null) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * The worktree domain: create an interactive worktree, and read the inventory.
 *
 * `worktree_list` takes STRICT empty params rather than the permissive
 * `acpNoParams` the older methods carry: the method is new, so no caller has
 * ever been allowed to name a checkout or a Project here, and letting one
 * through silently would read to its author as a field that worked.
 */
export function worktreeMethodDomain(deps: AcpWorktreeDeps): RedskillsAcpMethodDomain {
  return {
    domain: "worktree",
    bindings: [
      redskillsAcpMethod(REDSKILLS_ACP_METHODS.worktreeAdd, worktreeAddParams, bindAcpWorktreeAdd(deps)),
      redskillsAcpMethod(
        REDSKILLS_ACP_METHODS.worktreeList,
        emptyRedskillsParams("worktree_list names no checkout, Project or lane; the connection's registration decides"),
        bindAcpWorktreeList(deps),
      ),
    ],
    capability: {
      worktree: {
        version: WORKTREE_SCHEMA.version,
        methods: [REDSKILLS_ACP_METHODS.worktreeAdd, REDSKILLS_ACP_METHODS.worktreeList],
        lane: REDSKILLED_INTERACTIVE_WORKTREE_LANE,
      },
    },
  };
}
