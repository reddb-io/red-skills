// surface.ts — the single owner of the GitHub API-surface decision (ADR 0132
// decision 4).
//
// **The principle is cardinality, not frequency.** A single-object read goes to
// REST; a multi-node listing or a multi-repository aggregate goes to GraphQL.
// Cardinality is decidable statically and never changes for an operation, so the
// table below is a fact about each call rather than a policy that has to be
// re-tuned. A frequency or budget-symmetry policy would need per-operation
// telemetry that does not exist, and would answer differently each release.
//
// **There are THREE budgets, not two.** REST is metered by request (5000/hr),
// GraphQL by node points (5000/hr), Search by minute (30/min). ADR 0130's claim
// that one aliased query makes cost "flat in the number of projects" is true of
// request count and false of points, which is why an operation declares the pool
// it draws from separately from the API that answers it.
//
// **An unclassified operation is named, never assumed.** The predecessor of this
// module (`ghReadSurface`) defaulted everything that was not `gh api <path>` to
// GraphQL, so every `--json` view and listing was labelled GraphQL and the hot
// single-object polls were issued against the pool metered by node points. The
// measured consequence: GraphQL at `0/5000` while REST sat at `4891/5000`, twice
// within one hour. {@link routeGithubArgs} raises instead of guessing.

/** Which GitHub API answers a call. */
export type GithubApiSurface = "rest" | "graphql";

/**
 * Which rate-limit pool the call draws from. Distinct from the surface because
 * GraphQL's `search` connection is metered by the Search budget (30/min), not by
 * the 5000/hr node-point pool the rest of GraphQL draws.
 */
export type GithubRateBudget = "rest" | "graphql" | "search";

/**
 * How many objects an operation names. This — and nothing else — decides the
 * surface of a READ.
 *
 * - `single-object`   — one issue, one pull request, one repository, by number.
 * - `multi-node`      — a listing inside one repository.
 * - `multi-repository`— an aggregate spanning repositories in one query.
 */
export type GithubCardinality = "single-object" | "multi-node" | "multi-repository";

/** Whether the operation observes state or changes it. */
export type GithubOperationKind = "read" | "write";

/** One classified GitHub operation. */
export interface GithubOperation {
  /** Canonical key: the gh command path, or `api rest` / `api graphql`. */
  readonly key: string;
  readonly kind: GithubOperationKind;
  readonly cardinality: GithubCardinality;
  /**
   * The API that answers this operation.
   *
   * For a READ this is DERIVED from `cardinality` — {@link surfaceForCardinality}
   * is the whole routing rule, and {@link assertGithubRoutingTable} refuses a read
   * entry that states anything else.
   *
   * For a WRITE it is OBSERVED, not chosen: `gh issue create` issues a GraphQL
   * mutation and `gh issue comment` a REST POST, and no cardinality argument
   * changes that. The classifier used to label every write GraphQL wholesale,
   * which is how a REST-metered write reported a GraphQL quota failure.
   */
  readonly surface: GithubApiSurface;
  readonly budget: GithubRateBudget;
  /**
   * Set when only ONE API exposes the resource at all, so there is no routing
   * choice to make: GitHub's Actions and Releases resources have no GraphQL
   * connection gh reads, and a multi-node listing of them is REST no matter what
   * cardinality would prefer. Naming the constraint keeps the exception legible
   * as a fact about GitHub rather than as a hole in the rule.
   */
  readonly only?: GithubApiSurface;
  /** One line on why this operation carries this classification. */
  readonly why: string;
}

/**
 * The routing rule, in one function: one object → REST, more than one → GraphQL.
 * PURE.
 */
export function surfaceForCardinality(cardinality: GithubCardinality): GithubApiSurface {
  return cardinality === "single-object" ? "rest" : "graphql";
}

function read(
  key: string,
  cardinality: GithubCardinality,
  budget: GithubRateBudget,
  why: string,
  only?: GithubApiSurface,
): GithubOperation {
  return {
    key,
    kind: "read",
    cardinality,
    surface: only ?? surfaceForCardinality(cardinality),
    budget,
    ...(only ? { only } : {}),
    why,
  };
}

function write(
  key: string,
  surface: GithubApiSurface,
  budget: GithubRateBudget,
  why: string,
): GithubOperation {
  return { key, kind: "write", cardinality: "single-object", surface, budget, why };
}

/**
 * The declared routing table. Adding a gh call to this repo means adding a line
 * here — an operation absent from the table raises rather than defaulting, so a
 * new call cannot silently inherit the pool that was already exhausted.
 *
 * Every entry is keyed by {@link githubOperationKey}'s output.
 */
export const GITHUB_OPERATIONS: readonly GithubOperation[] = [
  // ── single-object reads: the hot path, and the whole reason this module exists
  read("issue view", "single-object", "rest", "one issue by number; REST answers it in one request against the idle pool"),
  read("pr view", "single-object", "rest", "one pull request by number, polled per Worker per iteration"),
  read("repo view", "single-object", "rest", "one repository's own metadata"),
  read("run view", "single-object", "rest", "one Actions run; the Actions API has no GraphQL surface either way"),
  read("release view", "single-object", "rest", "one release by tag"),
  read("pr diff", "single-object", "rest", "one pull request's diff, served by a REST media type"),

  // ── multi-node listings: a connection inside one repository
  read("issue list", "multi-node", "graphql", "a connection of issues; one GraphQL query beats N REST pages"),
  read("pr list", "multi-node", "graphql", "a connection of pull requests; one GraphQL query beats N REST pages"),
  read("pr checks", "multi-node", "graphql", "every check context on one commit, which is a connection, not an object"),
  read("release list", "multi-node", "rest", "Releases have no GraphQL connection gh reads; REST pages them", "rest"),
  read("run list", "multi-node", "rest", "the Actions API has no GraphQL surface, so a listing draws the request pool", "rest"),
  read("label list", "multi-node", "graphql", "a connection of labels inside one repository"),

  // ── search: a third pool, metered by the minute
  read("issue list (search)", "multi-node", "search", "`--search` routes the listing through the search connection, metered 30/min"),
  read("pr list (search)", "multi-node", "search", "`--search` routes the listing through the search connection, metered 30/min"),
  read("search issues", "multi-repository", "search", "gh's `search` drives the REST search endpoints, metered 30/min", "rest"),
  read("search prs", "multi-repository", "search", "gh's `search` drives the REST search endpoints, metered 30/min", "rest"),
  read("search repos", "multi-repository", "search", "gh's `search` drives the REST search endpoints, metered 30/min", "rest"),

  // ── the raw API escape hatches: the caller has already chosen
  read("api graphql", "multi-node", "graphql", "the caller wrote the query; `gh api graphql` is GraphQL by construction"),
  read("api rest", "single-object", "rest", "any `gh api <path>` that is not `graphql` is a REST request"),

  // ── writes: the surface is gh's, observed rather than chosen
  write("issue create", "graphql", "graphql", "gh files an issue with the createIssue mutation — an exhausted GraphQL pool blocks filing"),
  write("issue edit", "graphql", "graphql", "gh edits labels, body and assignees with GraphQL mutations"),
  write("issue close", "graphql", "graphql", "gh closes with the closeIssue mutation"),
  write("issue reopen", "graphql", "graphql", "gh reopens with the reopenIssue mutation"),
  write("issue comment", "rest", "rest", "gh POSTs to `repos/{o}/{r}/issues/{n}/comments`, a REST request"),
  write("issue develop", "graphql", "graphql", "linked-branch creation is a GraphQL mutation"),
  write("pr create", "rest", "rest", "gh POSTs to `repos/{o}/{r}/pulls`, a REST request"),
  write("pr comment", "rest", "rest", "a pull request comment is an issue comment: the same REST POST"),
  write("pr merge", "graphql", "graphql", "gh merges with the mergePullRequest mutation"),
  write("pr close", "graphql", "graphql", "gh closes with a GraphQL mutation"),
  write("pr edit", "graphql", "graphql", "gh edits with GraphQL mutations"),
  write("pr ready", "graphql", "graphql", "marking ready-for-review is a GraphQL mutation"),
  write("pr update-branch", "rest", "rest", "gh PUTs `repos/{o}/{r}/pulls/{n}/update-branch`, a REST request"),
  write("label create", "rest", "rest", "gh POSTs `repos/{o}/{r}/labels`, a REST request"),
];

const BY_KEY: ReadonlyMap<string, GithubOperation> = new Map(
  GITHUB_OPERATIONS.map((operation) => [operation.key, operation]),
);

/** The declared operations, keyed. PURE. */
export function githubOperations(): ReadonlyMap<string, GithubOperation> {
  return BY_KEY;
}

/**
 * The gh command path of an argv — the leading tokens that name the command,
 * with gh's global `-R/--repo` pair skipped and flag values never mistaken for
 * command tokens. `["-R","o/r","issue","view","42","--json","state"]` → `["issue","view"]`.
 * PURE.
 */
export function githubCommandPath(args: readonly string[]): string[] {
  const path: string[] = [];
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    i += args[i] === "-R" || args[i] === "--repo" ? 2 : 1;
  }
  while (i < args.length && !args[i]!.startsWith("-") && path.length < 2) {
    path.push(args[i]!);
    i += 1;
  }
  return path;
}

/**
 * The canonical operation key for a gh argv. `gh api graphql` and `gh api <path>`
 * collapse to `api graphql` / `api rest` because the path itself is the caller's
 * business; a listing carrying `--search` gets its own key because that flag
 * moves it to a different pool, not to a different API. PURE.
 */
export function githubOperationKey(args: readonly string[]): string {
  const path = githubCommandPath(args);
  if (path.length === 0) return "";
  if (path[0] === "api") return path[1] === "graphql" ? "api graphql" : "api rest";
  const key = path.length === 1 ? path[0]! : `${path[0]} ${path[1]}`;
  if (path[1] === "list" && args.includes("--search")) return `${key} (search)`;
  return key;
}

/**
 * The failure a call raises when its argv matches no declared operation. It
 * carries the key it derived so the fix is one table line, not an investigation.
 */
export class UnclassifiedGithubOperationError extends Error {
  readonly name = "UnclassifiedGithubOperationError";
  readonly operation: string;
  readonly args: readonly string[];

  constructor(args: readonly string[]) {
    const key = githubOperationKey(args);
    super(
      `unclassified GitHub operation ${JSON.stringify(key || "(empty argv)")}: ` +
        `add an entry to GITHUB_OPERATIONS in packages/github/surface.ts stating its cardinality. ` +
        `Defaulting to GraphQL is what sent every single-object poll to the node-point pool (ADR 0132 decision 4).`,
    );
    this.operation = key;
    this.args = [...args];
  }
}

/** The declared operation for a gh argv, or `null` when none is declared. PURE. */
export function tryRouteGithubArgs(args: readonly string[]): GithubOperation | null {
  return BY_KEY.get(githubOperationKey(args)) ?? null;
}

/**
 * The declared operation for a gh argv, RAISING
 * {@link UnclassifiedGithubOperationError} when the argv matches none. This is
 * the router: an operation nobody classified must be named, not silently
 * assigned to whichever pool the old default happened to pick. PURE.
 */
export function routeGithubArgs(args: readonly string[]): GithubOperation {
  const operation = tryRouteGithubArgs(args);
  if (!operation) throw new UnclassifiedGithubOperationError(args);
  return operation;
}

/** The surface a gh argv must run on. RAISES on an unclassified argv. PURE. */
export function githubSurfaceFor(args: readonly string[]): GithubApiSurface {
  return routeGithubArgs(args).surface;
}

/**
 * Refuse a table that contradicts itself: a duplicate key, an empty key, or a
 * READ whose declared surface is not the one its cardinality implies. Returns
 * the problems it found rather than throwing, so the pinning test can report all
 * of them at once. PURE.
 */
export function assertGithubRoutingTable(
  operations: readonly GithubOperation[] = GITHUB_OPERATIONS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const operation of operations) {
    if (operation.key.trim() === "") problems.push("an operation carries an empty key");
    if (seen.has(operation.key)) problems.push(`duplicate operation key ${JSON.stringify(operation.key)}`);
    seen.add(operation.key);
    if (operation.why.trim() === "") problems.push(`${operation.key} states no reason`);
    if (operation.kind !== "read") continue;
    const implied = operation.only ?? surfaceForCardinality(operation.cardinality);
    if (operation.surface !== implied) {
      problems.push(
        `${operation.key} is a ${operation.cardinality} read declared on ${operation.surface}, ` +
          `but ${operation.only ? "the resource is exposed only by" : "cardinality implies"} ${implied}`,
      );
    }
    if (operation.only && operation.only === surfaceForCardinality(operation.cardinality)) {
      problems.push(
        `${operation.key} names a one-API constraint that cardinality already implies; drop the constraint`,
      );
    }
  }
  return problems;
}
