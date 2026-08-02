/**
 * repository-activity — every registered project's counts, in one request.
 *
 * ADR 0130 Amendment 1: **the daemon holds one token and the repository identity
 * of each registered project, and fetches every project's activity counts in a
 * single aliased query per interval.** Rendering the statusline needs open pull
 * requests, open Issues and recently closed work, and those come from the issue
 * tracker rather than from any process the daemon owns.
 *
 * **The frontier moves by exactly two items.** The daemon learns a repository
 * identity per project and a token; it still does not know what an Issue, a pull
 * request, a label, a gate or a Landing *is*. A count is an integer it stores and
 * returns without interpreting, exactly as it carries a Worker's last logged line
 * without parsing it.
 *
 * **One request, not N.** GitHub quota is per token, not per process, so several
 * projects polling with the same credential already share one budget and splitting
 * the poller across processes saves nothing. What saves is issuing one aliased
 * query that spans every repository at once — the machinery the shared batch layer
 * already had, bound to a single repository, with the parameter widened. Cost is
 * then flat in the number of projects rather than linear in it.
 *
 * **The condition is checked in code, not assumed in prose.** Every repository on
 * the host must be reachable with the same token; a project that declares its own
 * credential invalidates the arrangement rather than bending it, so registering
 * one throws instead of quietly polling with the wrong identity.
 *
 * **Never a zero standing in for an absence.** An unreachable repository and a
 * rate-limited fetch each carry `null` counts and their own outcome, because "the
 * token cannot see this repository", "the quota is spent" and "there is genuinely
 * nothing open" are three different facts about a project and only the last of
 * them is a zero.
 *
 * **The surface is not this module's to pick.** Which GitHub API answers a call
 * is owned by `@reddb-io/github`, which the castle imports too (ADR 0132
 * decision 4): one table, because two implementations of one routing rule drift.
 * This poll is a multi-repository aggregate, and cardinality sends a
 * multi-repository aggregate to GraphQL — so the endpoint below is DERIVED from
 * the route rather than hardcoded next to it. Note the third budget: an aliased
 * query makes cost flat in the number of projects by REQUEST count and not by
 * node POINTS, and the aliased `search` fields draw the Search pool (30/min)
 * rather than either.
 *
 * PURE, apart from `fetchRepositoryActivity`, whose transport is injected.
 */

import { githubSurfaceFor, type GithubApiSurface } from "@reddb-io/github";

/**
 * The gh argv this poll is equivalent to. It exists so the surface below is a
 * lookup in the shared table rather than a second opinion about it.
 */
export const REDSKILLED_ACTIVITY_ARGV: readonly string[] = ["api", "graphql"];

/** Which API answers the activity poll, per the shared routing table. */
export const REDSKILLED_ACTIVITY_SURFACE: GithubApiSurface = githubSurfaceFor(REDSKILLED_ACTIVITY_ARGV);

/** The GitHub endpoint for a surface. A REST route would not address `/graphql`. */
export function githubEndpointFor(surface: GithubApiSurface, origin = "https://api.github.com"): string {
  return surface === "graphql" ? `${origin}/graphql` : origin;
}

/** How many repositories one aliased query may span. */
export const REDSKILLED_ACTIVITY_BATCH_SIZE = 100;

/** Default window between polls: activity moves at human speed, not at sampler speed. */
export const DEFAULT_REDSKILLED_ACTIVITY_MS = 60_000;

/**
 * How old counts may be before the payload calls them stale.
 *
 * Two poll windows, for the same reason the memory sampler uses two of its own:
 * one missed interval is the jitter of a busy host or a slow API, and two is a
 * poller that stopped.
 */
export const REDSKILLED_ACTIVITY_STALENESS_MS = 2 * DEFAULT_REDSKILLED_ACTIVITY_MS;

/** How far back "recently closed" reaches, when a caller states no window. */
export const DEFAULT_REDSKILLED_ACTIVITY_CLOSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One registered project and the repository its counts come from.
 *
 * `token_ref` exists only so a project that wants its own credential can be
 * refused by name: the amendment's condition is that every repository on the host
 * shares one token, and a poller that silently used the host's identity for a
 * repository the project meant to reach with another would be lying about whose
 * quota it spent.
 */
export interface RedskilledProjectRepository {
  readonly project_label: string;
  readonly owner: string;
  readonly name: string;
  /** The credential this project insists on; anything but the host's is refused. */
  readonly token_ref?: string;
}

/** Raised when a registered project asks to be polled with its own credential. */
export class RedskilledSplitCredentialError extends Error {
  constructor(
    readonly projectLabel: string,
    readonly tokenRef: string,
    readonly hostTokenRef: string,
  ) {
    super(
      `redskilled polls every repository with one host token ${JSON.stringify(hostTokenRef)}, and project ` +
        `${JSON.stringify(projectLabel)} declares its own credential ${JSON.stringify(tokenRef)}: a project needing ` +
        `its own credential invalidates the host-scoped poller (ADR 0130 Amendment 1) rather than bending it, so the ` +
        `poller returns to the projects instead of reaching this repository under the wrong identity`,
    );
    this.name = "RedskilledSplitCredentialError";
  }
}

/** What this project's tracker holds, as three integers and nothing more. */
export interface RedskilledActivityCounts {
  readonly open_pull_requests: number;
  readonly open_issues: number;
  /** Issues and pull requests closed inside the window the fetch asked for. */
  readonly recently_closed: number;
}

/**
 * How one project's counts came out.
 *
 * `rate-limited` is its own outcome rather than an empty `counted`, because the
 * failure that drove this decision surfaced as an empty result rather than an
 * error: a spent quota that read as zero open pull requests is exactly the render
 * this vocabulary refuses.
 */
export type RedskilledActivityOutcome = "counted" | "unreachable" | "rate-limited";

export interface RedskilledProjectActivity {
  readonly project_label: string;
  /** `owner/name`, echoed back as registered. */
  readonly repository: string;
  readonly outcome: RedskilledActivityOutcome;
  /** The counts; `null` for every outcome but `counted`, never a zero. */
  readonly counts: RedskilledActivityCounts | null;
  readonly detail: string;
}

/** What the token had left when the query answered; `null` when it did not say. */
export interface RedskilledActivityRateLimit {
  readonly remaining: number | null;
  readonly reset_at: string | null;
  /** True when this fetch was refused for quota rather than answered. */
  readonly exhausted: boolean;
}

export interface RedskilledRepositoryActivity {
  readonly version: 1;
  readonly fetched_at: string;
  /** How many requests the whole fetch cost — one, for any number of projects. */
  readonly request_count: number;
  readonly project_count: number;
  readonly rate_limit: RedskilledActivityRateLimit;
  readonly projects: readonly RedskilledProjectActivity[];
}

export interface RedskilledActivityAlias {
  readonly alias: string;
  readonly search_alias: string;
  readonly project: RedskilledProjectRepository;
}

export interface RedskilledActivityOperation {
  readonly query: string;
  readonly aliases: readonly RedskilledActivityAlias[];
  /** The instant `recently_closed` counts back from, as the query states it. */
  readonly closed_since: string;
}

/**
 * Refuse a registration the arrangement cannot hold. PURE.
 *
 * Loud and early: the check runs before the query is built, so a host with a
 * split credential never issues a request at all rather than issuing one whose
 * answer would be wrong for exactly one project.
 */
export function assertOneHostToken(
  projects: readonly RedskilledProjectRepository[],
  hostTokenRef: string,
): void {
  for (const project of projects) {
    if (project.token_ref != null && project.token_ref !== hostTokenRef) {
      throw new RedskilledSplitCredentialError(project.project_label, project.token_ref, hostTokenRef);
    }
  }
}

/**
 * One aliased query spanning every registered repository. PURE.
 *
 * Two aliases per project and one request for all of them: `repository(...)`
 * carries the open counts, and an aliased `search` carries the recently closed
 * ones, which the repository connection cannot filter by date. Widening the
 * parameter from one repository to every repository is the whole change — the
 * alias machinery is the shared batch layer's, unchanged.
 */
export function buildRepositoryActivityQuery(
  projects: readonly RedskilledProjectRepository[],
  options: { readonly now: string; readonly closedWindowMs?: number } = { now: new Date(0).toISOString() },
): RedskilledActivityOperation {
  assertActivityProjects(projects);
  const windowMs = options.closedWindowMs ?? DEFAULT_REDSKILLED_ACTIVITY_CLOSED_WINDOW_MS;
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new Error(`redskilled activity fetch needs an instant, not ${JSON.stringify(options.now)}`);
  const closedSince = new Date(nowMs - Math.max(0, windowMs)).toISOString();

  const aliases: RedskilledActivityAlias[] = projects.map((project, index) => ({
    alias: `r${index}`,
    search_alias: `c${index}`,
    project,
  }));
  const fields = aliases.flatMap(({ alias, search_alias, project }) => {
    const owner = JSON.stringify(project.owner);
    const name = JSON.stringify(project.name);
    const search = JSON.stringify(`repo:${project.owner}/${project.name} is:closed closed:>=${closedSince}`);
    return [
      `  ${alias}: repository(owner: ${owner}, name: ${name}) {`,
      "    nameWithOwner",
      "    open_pull_requests: pullRequests(states: OPEN) { totalCount }",
      "    open_issues: issues(states: OPEN) { totalCount }",
      "  }",
      `  ${search_alias}: search(query: ${search}, type: ISSUE, first: 1) { issueCount }`,
    ];
  });
  const query = [
    "query RedskilledRepositoryActivity {",
    "  rateLimit { remaining resetAt }",
    ...fields,
    "}",
  ].join("\n");
  return { query, aliases, closed_since: closedSince };
}

/**
 * Turn one answer into one document. PURE.
 *
 * Each project is judged on its own alias: a repository the token cannot see
 * fails loudly while its neighbours still count, because one unreachable
 * repository is a fact about that project and not about the host. A spent quota
 * is read from the errors and from `rateLimit` alike, so the empty result that
 * the exhaustion produced can never pass for a legitimately empty tracker.
 */
export function parseRepositoryActivityResponse(
  operation: RedskilledActivityOperation,
  payload: unknown,
  options: { readonly fetchedAt: string },
): RedskilledRepositoryActivity {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const errors = Array.isArray(root.errors) ? root.errors.map(asRecord) : [];
  const rateLimit = readRateLimit(data.rateLimit, errors);

  const projects = operation.aliases.map(({ alias, search_alias, project }): RedskilledProjectActivity => {
    const repository = project.owner + "/" + project.name;
    const node = data[alias];
    const aliasError = errors.find((candidate) => pathIncludes(candidate.path, alias) || pathIncludes(candidate.path, search_alias));
    if (isRecord(node)) {
      const openPullRequests = totalCount(node.open_pull_requests);
      const openIssues = totalCount(node.open_issues);
      const recentlyClosed = issueCount(data[search_alias]);
      if (openPullRequests != null && openIssues != null && recentlyClosed != null) {
        return {
          project_label: project.project_label,
          repository,
          outcome: "counted",
          counts: {
            open_pull_requests: openPullRequests,
            open_issues: openIssues,
            recently_closed: recentlyClosed,
          },
          detail: `counted ${repository} for project ${JSON.stringify(project.project_label)}`,
        };
      }
    }
    if (rateLimit.exhausted || isRateLimitError(aliasError)) {
      return {
        project_label: project.project_label,
        repository,
        outcome: "rate-limited",
        counts: null,
        detail:
          `the host token's quota was spent before ${repository} answered, so this project has no counts rather than ` +
          `zero counts${rateLimit.reset_at == null ? "" : `; the quota resets at ${rateLimit.reset_at}`}`,
      };
    }
    return {
      project_label: project.project_label,
      repository,
      outcome: "unreachable",
      counts: null,
      detail:
        `${repository} is not reachable with the host token: ` +
        `${stringValue(aliasError?.message) || "the query returned no such repository"}`,
    };
  });

  return {
    version: 1,
    fetched_at: options.fetchedAt,
    request_count: 1,
    project_count: projects.length,
    rate_limit: rateLimit,
    projects,
  };
}

/** The document a host with nothing registered has: total, and honestly empty. */
export function emptyRepositoryActivity(fetchedAt: string): RedskilledRepositoryActivity {
  return {
    version: 1,
    fetched_at: fetchedAt,
    request_count: 0,
    project_count: 0,
    rate_limit: { remaining: null, reset_at: null, exhausted: false },
    projects: [],
  };
}

/** How a fetch reaches the tracker; injected so nothing here opens a socket. */
export type RedskilledActivityTransport = (query: string) => Promise<unknown>;

export interface FetchRepositoryActivityInput {
  readonly projects: readonly RedskilledProjectRepository[];
  readonly hostTokenRef: string;
  readonly transport: RedskilledActivityTransport;
  readonly now: string;
  readonly closedWindowMs?: number;
}

/**
 * One interval's fetch: one request, however many projects are registered.
 *
 * A transport that throws is not swallowed into zeros — the whole document comes
 * back with every project unreachable and the thrown sentence as its detail, so a
 * consumer sees a failure where a failure happened.
 */
export async function fetchRepositoryActivity(
  input: FetchRepositoryActivityInput,
): Promise<RedskilledRepositoryActivity> {
  if (input.projects.length === 0) return emptyRepositoryActivity(input.now);
  assertOneHostToken(input.projects, input.hostTokenRef);
  const operation = buildRepositoryActivityQuery(input.projects, {
    now: input.now,
    closedWindowMs: input.closedWindowMs,
  });
  try {
    const payload = await input.transport(operation.query);
    return parseRepositoryActivityResponse(operation, payload, { fetchedAt: input.now });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const rateLimited = /rate limit|secondary rate|429/i.test(reason);
    return {
      version: 1,
      fetched_at: input.now,
      request_count: 1,
      project_count: input.projects.length,
      rate_limit: { remaining: null, reset_at: null, exhausted: rateLimited },
      projects: input.projects.map((project) => ({
        project_label: project.project_label,
        repository: `${project.owner}/${project.name}`,
        outcome: rateLimited ? "rate-limited" : "unreachable",
        counts: null,
        detail: `the activity fetch failed before ${project.owner}/${project.name} answered: ${reason}`,
      })),
    };
  }
}

/** One project's counts, dated — the shape a consumer renders. */
export interface RedskilledActivityView extends RedskilledProjectActivity {
  readonly fetched_at: string;
  readonly age_ms: number | null;
  readonly stale: boolean;
}

export interface RedskilledActivityReport {
  readonly version: 1;
  readonly fetched_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly stale: boolean;
  readonly request_count: number;
  readonly rate_limit: RedskilledActivityRateLimit;
  readonly projects: readonly RedskilledActivityView[];
  readonly reason: string;
}

/**
 * Date the counts so the consumer renders the age instead of inventing it. PURE.
 *
 * Staleness travels inside the payload for the same reason it does everywhere
 * else here: a surface that had to date the answer itself would need the poll
 * interval, the daemon's clock and its own read latency, and would get it subtly
 * wrong in a different way per surface.
 */
export function buildActivityReport(input: {
  readonly activity: RedskilledRepositoryActivity | null;
  readonly now: string;
  readonly stalenessMs?: number;
}): RedskilledActivityReport {
  const threshold = input.stalenessMs ?? REDSKILLED_ACTIVITY_STALENESS_MS;
  const activity = input.activity;
  if (activity == null) {
    return {
      version: 1,
      fetched_at: null,
      age_ms: null,
      threshold_ms: threshold,
      stale: false,
      request_count: 0,
      rate_limit: { remaining: null, reset_at: null, exhausted: false },
      projects: [],
      reason: "the daemon polls no repository, so there are no counts to age",
    };
  }
  const nowMs = Date.parse(input.now);
  const fetchedMs = Date.parse(activity.fetched_at);
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(fetchedMs) ? Math.max(0, nowMs - fetchedMs) : null;
  const stale = ageMs == null || ageMs > threshold;
  return {
    version: 1,
    fetched_at: activity.fetched_at,
    age_ms: ageMs,
    threshold_ms: threshold,
    stale: activity.projects.length > 0 && stale,
    request_count: activity.request_count,
    rate_limit: activity.rate_limit,
    projects: activity.projects.map((project) => ({
      ...project,
      fetched_at: activity.fetched_at,
      age_ms: ageMs,
      stale: stale,
    })),
    reason: activity.projects.length === 0
      ? "the daemon polls no repository, so there are no counts to age"
      : ageMs == null
        ? "these counts carry no readable instant, so they cannot be presented as current"
        : stale
          ? `these counts are ${ageMs}ms old, past the ${threshold}ms window`
          : `fetched ${ageMs}ms ago, within the ${threshold}ms window`,
  };
}

/** True when `value` is a complete activity report — a client's fail-closed check. */
export function isRedskilledActivityReport(value: unknown): value is RedskilledActivityReport {
  if (!isRecord(value)) return false;
  const report = value as Record<string, unknown>;
  return report.version === 1 &&
    (report.fetched_at === null || typeof report.fetched_at === "string") &&
    (report.age_ms === null || typeof report.age_ms === "number") &&
    typeof report.threshold_ms === "number" &&
    typeof report.stale === "boolean" &&
    Number.isInteger(report.request_count) &&
    isRecord(report.rate_limit) &&
    Array.isArray(report.projects) &&
    typeof report.reason === "string";
}

/**
 * The GitHub transport, built around one token.
 *
 * `fetch` is injected so a test never opens a socket, and an HTTP refusal that
 * carries a spent quota is thrown with the word the parser looks for rather than
 * collapsing into an empty body — an empty body is the failure mode the whole
 * amendment was written about.
 */
export function createGitHubActivityTransport(options: {
  readonly token: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}): RedskilledActivityTransport {
  const endpoint = options.endpoint ?? githubEndpointFor(REDSKILLED_ACTIVITY_SURFACE);
  const call = options.fetchImpl ?? fetch;
  return async (query: string): Promise<unknown> => {
    const response = await call(endpoint, {
      method: "POST",
      headers: {
        authorization: `bearer ${options.token}`,
        "content-type": "application/json",
        accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const quotaSpent = response.status === 429 || remaining === "0";
      throw new Error(
        `the activity query was refused with HTTP ${response.status}` +
          (quotaSpent ? ": the host token's rate limit is spent" : ""),
      );
    }
    return await response.json();
  };
}

function assertActivityProjects(projects: readonly RedskilledProjectRepository[]): void {
  if (projects.length === 0) throw new Error("redskilled activity fetch needs at least one registered project");
  if (projects.length > REDSKILLED_ACTIVITY_BATCH_SIZE) {
    throw new Error(`redskilled activity fetch spans at most ${REDSKILLED_ACTIVITY_BATCH_SIZE} repositories in one query`);
  }
  const seen = new Set<string>();
  for (const project of projects) {
    if (project.project_label === "" || project.owner === "" || project.name === "") {
      throw new Error("redskilled activity fetch needs a project label and an owner/name for every registered project");
    }
    if (seen.has(project.project_label)) {
      throw new Error(`redskilled holds one repository per project, and ${JSON.stringify(project.project_label)} is registered twice`);
    }
    seen.add(project.project_label);
  }
}

function readRateLimit(value: unknown, errors: readonly Record<string, unknown>[]): RedskilledActivityRateLimit {
  const node = asRecord(value);
  const remaining = typeof node.remaining === "number" && Number.isFinite(node.remaining) ? node.remaining : null;
  const resetAt = typeof node.resetAt === "string" ? node.resetAt : null;
  const flagged = errors.some(isRateLimitError);
  return { remaining, reset_at: resetAt, exhausted: flagged || remaining === 0 };
}

function isRateLimitError(error: Record<string, unknown> | undefined): boolean {
  if (error == null) return false;
  const type = stringValue(error.type);
  const message = stringValue(error.message);
  return type === "RATE_LIMITED" || /rate limit/i.test(message);
}

function pathIncludes(path: unknown, alias: string): boolean {
  return Array.isArray(path) && path.includes(alias);
}

function totalCount(value: unknown): number | null {
  const node = asRecord(value);
  return Number.isInteger(node.totalCount) ? (node.totalCount as number) : null;
}

function issueCount(value: unknown): number | null {
  const node = asRecord(value);
  return Number.isInteger(node.issueCount) ? (node.issueCount as number) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
