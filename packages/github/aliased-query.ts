// aliased-query — every registered repository's counts in ONE request.
//
// ADR 0130 decided this and nothing built it: the daemon still polls each
// project separately, and the herdr dashboard still reports "the daemon polls no
// repository". This is the module that closes it.
//
// **Flat in requests. NOT flat in points.** The GraphQL pool is metered by the
// nodes a query returns, so an aliased query spanning ten repositories is one
// request and ten repositories' worth of points. ADR 0130's "cost becomes flat
// in the number of projects" is true of request COUNT, and repeating it about
// points would oversell the saving to whoever sizes the next change.
//
// **Rule 3 survives.** A repository identity is carried and interpolated; not
// one branch here reads what a label, a selector or a state means. The caller
// hands over owner/name pairs and gets back a query string and the aliases to
// read the answer with.
//
// PURE.

/** One repository this query will span. */
export interface GithubRepoRef {
  readonly owner: string;
  readonly name: string;
}

/** The built request, and how to read what comes back. */
export interface GithubAliasedQuery {
  readonly query: string;
  /** Alias → the repo it stands for, in the order they were given. */
  readonly aliases: Readonly<Record<string, GithubRepoRef>>;
  /** How many repositories this one request covers. */
  readonly repoCount: number;
}

/**
 * GraphQL aliases must be identifiers; repository names are not.
 *
 * The index makes the alias unique without the caller having to care whether
 * two owners share a repository name — sanitizing alone would collide
 * `a/my-repo` with `b/my_repo`.
 */
function aliasFor(index: number): string {
  return `r${index}`;
}

/**
 * Build one query returning each repository's open issue and PR counts. PURE.
 *
 * The fields are counts and nothing else — `totalCount` on two connections —
 * because a count is an integer the daemon stores and returns without
 * interpreting, which is exactly the frontier ADR 0130 drew when it let the
 * daemon hold a repository identity at all.
 *
 * An empty repository list yields `null` rather than an empty query: asking
 * GitHub for nothing still costs a request.
 */
export function buildActivityCountsQuery(repos: readonly GithubRepoRef[]): GithubAliasedQuery | null {
  if (repos.length === 0) return null;

  const aliases: Record<string, GithubRepoRef> = {};
  const selections: string[] = [];

  repos.forEach((repo, index) => {
    const alias = aliasFor(index);
    aliases[alias] = repo;
    selections.push(
      `  ${alias}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) {\n` +
        `    issues(states: OPEN) { totalCount }\n` +
        `    pullRequests(states: OPEN) { totalCount }\n` +
        `  }`,
    );
  });

  return {
    query: `query RedskilledActivityCounts {\n${selections.join("\n")}\n}`,
    aliases,
    repoCount: repos.length,
  };
}

/** One repository's counts, as read back out of the aliased answer. */
export interface GithubActivityCounts {
  readonly owner: string;
  readonly name: string;
  readonly openIssues: number;
  readonly openPullRequests: number;
}

/**
 * Read the aliased answer back into per-repository counts. PURE.
 *
 * **A repository that did not answer is absent, never zero.** GitHub returns
 * `null` for an alias it could not resolve — a repository renamed, made private,
 * or a token that lost access — and rendering that as `0` would report a healthy
 * empty queue for a repository nobody can see. The same distinction the queue
 * discovery already draws between "drained" and "not counted".
 */
export function readActivityCounts(
  aliased: GithubAliasedQuery,
  data: unknown,
): readonly GithubActivityCounts[] {
  if (data === null || typeof data !== "object") return [];
  const root = (data as { data?: unknown }).data ?? data;
  if (root === null || typeof root !== "object") return [];

  const out: GithubActivityCounts[] = [];
  for (const [alias, repo] of Object.entries(aliased.aliases)) {
    const node = (root as Record<string, unknown>)[alias];
    if (node === null || node === undefined || typeof node !== "object") continue;
    const openIssues = totalCount((node as Record<string, unknown>).issues);
    const openPullRequests = totalCount((node as Record<string, unknown>).pullRequests);
    if (openIssues === null || openPullRequests === null) continue;
    out.push({ owner: repo.owner, name: repo.name, openIssues, openPullRequests });
  }
  return out;
}

function totalCount(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const count = (value as { totalCount?: unknown }).totalCount;
  return Number.isFinite(count) ? (count as number) : null;
}
