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

import type { GithubSingleObjectKind } from "./rest-plan.js";

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

/** One cold single-object read eligible to share an aliased request. */
export interface GithubAliasedSingleObjectRead {
  readonly kind: GithubSingleObjectKind;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** A trusted GraphQL field selection owned by the caller. */
  readonly selection: string;
}

/** One query spanning single-object reads of the same kind. */
export interface GithubAliasedSingleObjectQuery {
  readonly query: string;
  readonly aliases: Readonly<Record<string, GithubAliasedSingleObjectRead>>;
}

/** One alias read back from a coalesced single-object response. */
export interface GithubAliasedSingleObjectRow {
  readonly read: GithubAliasedSingleObjectRead;
  readonly value: Record<string, unknown> | null;
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
 * Build one request for cold single-object reads that arrived in the same turn.
 *
 * The coalescer groups by kind before calling this builder. Repository aliases
 * remain at the query root, so reads may span repositories without inventing a
 * second request. The result also asks GitHub what the query cost: one request
 * is still each returned object's worth of GraphQL points.
 */
export function buildSingleObjectReadsQuery(
  reads: readonly GithubAliasedSingleObjectRead[],
): GithubAliasedSingleObjectQuery {
  if (reads.length === 0) throw new Error("an aliased single-object query needs at least one read");
  const kind = reads[0]!.kind;
  if (reads.some((read) => read.kind !== kind)) {
    throw new Error("an aliased single-object query may contain only one object kind");
  }

  const aliases: Record<string, GithubAliasedSingleObjectRead> = {};
  const graphqlField = kind === "pr" ? "pullRequest" : "issue";
  const selections = reads.map((read, index) => {
    if (!Number.isSafeInteger(read.number) || read.number <= 0) {
      throw new Error(`an aliased single-object read needs a positive number, got ${read.number}`);
    }
    const selection = read.selection.trim();
    if (selection === "") throw new Error("an aliased single-object read needs a field selection");
    const alias = aliasFor(index);
    aliases[alias] = read;
    return [
      `  ${alias}: repository(owner: ${JSON.stringify(read.owner)}, name: ${JSON.stringify(read.repo)}) {`,
      `    object: ${graphqlField}(number: ${read.number}) { ${selection} }`,
      "  }",
    ].join("\n");
  });

  return {
    query: [
      "query CoalescedSingleObjectReads {",
      ...selections,
      "  rateLimit { cost }",
      "}",
    ].join("\n"),
    aliases,
  };
}

/** Read each aliased object in request order; an unanswered alias stays null. */
export function readSingleObjectRows(
  aliased: GithubAliasedSingleObjectQuery,
  data: unknown,
): readonly GithubAliasedSingleObjectRow[] {
  const envelope = data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
  const rootValue = envelope.data ?? envelope;
  const root = rootValue !== null && typeof rootValue === "object"
    ? rootValue as Record<string, unknown>
    : {};
  return Object.entries(aliased.aliases).map(([alias, read]) => {
    const repository = root[alias];
    if (repository === null || typeof repository !== "object") return { read, value: null };
    const value = (repository as Record<string, unknown>).object;
    return {
      read,
      value: value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null,
    };
  });
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
