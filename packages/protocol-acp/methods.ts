// methods — the `_redskills/*` extension surface, named once (ADR 0145 §1).
//
// An extension method is a STRING on a socket, so a literal spelled at the
// server and re-spelled at the client is two independent chances to be wrong,
// and a rename touches whichever copies the renamer happened to grep. The
// registry below is the single spelling; every caller and every handler reads
// its name from here.
//
// What lives here is the WIRE: the method names, their direction, and the
// param shapes that are pure protocol. What a method DOES — admission, budget
// policy, the GitHub gateway, Project control state — stays with the authority
// that owns it, per ADR 0148's body-versus-control cut.
import { RequestError } from "@agentclientprotocol/sdk";

/** Every RedSkills extension method is namespaced; ACP core owns the rest. */
export const REDSKILLS_ACP_METHOD_NAMESPACE = "_redskills/";

/**
 * The `_redskills/*` methods, keyed by the name callers use in code.
 *
 * Adding a method is one entry here plus its handler; a literal spelled
 * anywhere else is the drift the grep-pinned ownership guard refuses.
 */
export const REDSKILLS_ACP_METHODS = {
  hostState: "_redskills/host_state",
  hostBudgets: "_redskills/host_budgets",
  projectDrain: "_redskills/project_drain",
  projectStop: "_redskills/project_stop",
  projectStatus: "_redskills/project_status",
  projectBudget: "_redskills/project_budget",
  githubRead: "_redskills/github_read",
  githubWrite: "_redskills/github_write",
  githubUpdate: "_redskills/github_update",
  githubCustodyHandoff: "_redskills/github_custody_handoff",
  workerBudgetGrace: "_redskills/worker_budget_grace",
  goDispatch: "_redskills/go_dispatch",
  worktreeAdd: "_redskills/worktree_add",
  worktreeList: "_redskills/worktree_list",
  metrics: "_redskills/metrics",
} as const;

/** Any name the registry declares. */
export type RedskillsAcpMethod = (typeof REDSKILLS_ACP_METHODS)[keyof typeof REDSKILLS_ACP_METHODS];

/** The declared names, for advertisement and for conformance sweeps. */
export const REDSKILLS_ACP_METHOD_NAMES: readonly RedskillsAcpMethod[] =
  Object.values(REDSKILLS_ACP_METHODS);

export function isRedskillsAcpMethod(method: string): method is RedskillsAcpMethod {
  return (REDSKILLS_ACP_METHOD_NAMES as readonly string[]).includes(method);
}

/** The params of a method that takes none. Authority is never caller-named. */
export type RedskillsAcpEmptyParams = Record<string, never>;

/**
 * Build the params validator for a method that accepts EXACTLY `{}`.
 *
 * An empty-params method is the shape most likely to be waved through with a
 * loose `value ?? {}`, and waving it through is how a caller smuggles a
 * Project, a credential profile or a host operation into a request whose whole
 * point is that it names none. `detail` states, per method, what the caller may
 * not name.
 */
export function emptyRedskillsParams(
  detail: string,
): (value: unknown) => RedskillsAcpEmptyParams {
  return (value: unknown): RedskillsAcpEmptyParams => {
    if (
      value == null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 0
    ) {
      throw RequestError.invalidParams({}, detail);
    }
    return {};
  };
}
