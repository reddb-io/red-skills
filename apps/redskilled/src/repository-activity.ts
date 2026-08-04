/**
 * repository-activity — every registered project's conditionally revalidated counts.
 *
 * ADR 0130 Amendment 1: **the daemon holds one token and the repository identity
 * of each registered project, and fetches every project's activity counts with
 * one host-scoped poller.** Rendering the statusline needs open pull
 * requests, open Issues and recently closed work, and those come from the issue
 * tracker rather than from any process the daemon owns.
 *
 * **The frontier moves by exactly two items.** The daemon learns a repository
 * identity per project and a token; it still does not know what an Issue, a pull
 * request, a label, a gate or a Landing *is*. A count is an integer it stores and
 * returns without interpreting, exactly as it carries a Worker's last logged line
 * without parsing it.
 *
 * **N round trips, usually zero budget.** Each project has three stable REST
 * list representations. Their ETags make an unchanged collection answer 304,
 * which costs no API budget; GraphQL charged the full aggregate on every poll.
 * The latency trade is deliberate on a poller, where budget binds and wall-clock
 * slack exists. The aliased GraphQL path remains only for injected migration
 * adapters that do not expose conditional lists.
 *
 * **A 304 is the held answer, never an empty one.** The typed client keeps each
 * validator with the body it validates. Rate-limit and network failures remain
 * failures with null counts; only an actual unchanged response reuses data.
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
 * Stable-poll volatility selects conditional REST for production. The legacy
 * aliased-query constants below stay explicit for migration adapters; they are
 * not a second production surface decision.
 *
 * PURE, apart from `fetchRepositoryActivity`, whose transport is injected.
 */

import {
  createGithubClient,
  githubSurfaceFor,
  isGithubRateLimitError,
  type GithubApiSurface,
  type GithubAttributionLedger,
  type GithubAttributedOperation,
  type GithubRequestFetch,
  type GithubPaginatedRestAnswer,
  type GithubResponseHeaders,
} from "@reddb-io/github";

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
  /**
   * What this one query cost in node points, as GitHub itself reported it.
   *
   * **Flat in requests is not flat in points.** One aliased query spanning ten
   * repositories is one request and ten repositories' worth of nodes, and the
   * GraphQL pool is metered by the second number. This field exists so the claim
   * is never made in prose: the cost is ASKED for in the query (`rateLimit { cost }`)
   * and echoed here, never computed as a constant. `null` when the answer did not
   * say — an absence, not a free query.
   */
  readonly point_cost: number | null;
}

export interface RedskilledRepositoryActivity {
  readonly version: 1;
  readonly fetched_at: string;
  /** Network requests issued; a 304 is included even though its API-budget cost is zero. */
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
    "  rateLimit { cost remaining resetAt }",
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
    rate_limit: { remaining: null, reset_at: null, exhausted: false, point_cost: null },
    projects: [],
  };
}

export interface RedskilledConditionalListRequest {
  readonly cacheKey: string;
  readonly route: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly operation: GithubAttributedOperation;
}

/**
 * How a fetch reaches the tracker; injected so nothing here opens a socket.
 *
 * The callable GraphQL half remains for test adapters and migration fallback.
 * Production transports add `conditionalList`, which is the stable poll path.
 */
export interface RedskilledActivityTransport {
  (query: string): Promise<unknown>;
  conditionalList?(
    input: RedskilledConditionalListRequest,
  ): Promise<GithubPaginatedRestAnswer<Record<string, unknown>>>;
}

export interface FetchRepositoryActivityInput {
  readonly projects: readonly RedskilledProjectRepository[];
  readonly hostTokenRef: string;
  readonly transport: RedskilledActivityTransport;
  readonly now: string;
  readonly closedWindowMs?: number;
}

/**
 * One interval's fetch: conditional REST in production, aliased GraphQL for a
 * migration adapter that exposes no conditional list.
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
  if (input.transport.conditionalList) return await fetchConditionalRepositoryActivity(input);
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
      rate_limit: { remaining: null, reset_at: null, exhausted: rateLimited, point_cost: null },
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

const REDSKILLED_ACTIVITY_REST_OPERATION: GithubAttributedOperation = {
  key: "redskilled repository activity poll",
  budget: "rest",
};

async function fetchConditionalRepositoryActivity(
  input: FetchRepositoryActivityInput,
): Promise<RedskilledRepositoryActivity> {
  assertActivityProjects(input.projects);
  // A sliding timestamp would make the recently-closed URL different on every
  // poll and therefore impossible to revalidate. Bucket that human-speed count
  // by hour: its seven-day meaning changes by at most one hour, while 59 of 60
  // minute polls can reuse the same representation validator.
  const nowMs = Date.parse(input.now);
  const queryNow = Number.isFinite(nowMs)
    ? new Date(Math.floor(nowMs / (60 * 60 * 1000)) * 60 * 60 * 1000).toISOString()
    : input.now;
  const operation = buildRepositoryActivityQuery(input.projects, {
    now: queryNow,
    closedWindowMs: input.closedWindowMs,
  });
  const list = input.transport.conditionalList!;
  const projects: RedskilledProjectActivity[] = [];
  let requestCount = 0;
  let rateLimit: RedskilledActivityRateLimit = {
    remaining: null,
    reset_at: null,
    exhausted: false,
    point_cost: null,
  };

  for (const project of input.projects) {
    const repository = `${project.owner}/${project.name}`;
    const queries = [
      ["open-prs", "GET /repos/{owner}/{repo}/pulls", { owner: project.owner, repo: project.name, state: "open" }],
      ["open-issues", "GET /repos/{owner}/{repo}/issues", { owner: project.owner, repo: project.name, state: "open" }],
      [
        "recently-closed",
        "GET /repos/{owner}/{repo}/issues",
        { owner: project.owner, repo: project.name, state: "closed", since: operation.closed_since },
      ],
    ] as const;
    const counts: number[] = [];
    try {
      for (const [kind, route, parameters] of queries) {
        const answer = await list({
          cacheKey: `activity:${repository}:${kind}:${JSON.stringify(parameters)}`,
          route,
          parameters,
          operation: REDSKILLED_ACTIVITY_REST_OPERATION,
        });
        requestCount += answer.requestCount;
        const items = kind === "open-prs"
          ? answer.data
          : answer.data.filter((item) => !isRecord(item.pull_request));
        counts.push(kind === "recently-closed"
          ? items.filter((item) => stringValue(item.closed_at) >= operation.closed_since).length
          : items.length);
        rateLimit = mergeActivityRateLimit(rateLimit, activityRateLimitFromHeaders(answer.headers));
      }
      projects.push({
        project_label: project.project_label,
        repository,
        outcome: "counted",
        counts: {
          open_pull_requests: counts[0]!,
          open_issues: counts[1]!,
          recently_closed: counts[2]!,
        },
        detail: `counted ${repository} for project ${JSON.stringify(project.project_label)}`,
      });
    } catch (error) {
      const rateLimited = isGithubRateLimitError(error);
      rateLimit = mergeActivityRateLimit(rateLimit, {
        remaining: null,
        reset_at: null,
        exhausted: rateLimited,
        point_cost: null,
      });
      projects.push({
        project_label: project.project_label,
        repository,
        outcome: rateLimited ? "rate-limited" : "unreachable",
        counts: null,
        detail:
          `the activity fetch failed before ${repository} answered: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    version: 1,
    fetched_at: input.now,
    request_count: requestCount,
    project_count: projects.length,
    rate_limit: rateLimit,
    projects,
  };
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
      rate_limit: { remaining: null, reset_at: null, exhausted: false, point_cost: null },
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
  readonly fetchImpl?: GithubRequestFetch;
  readonly attribution?: GithubAttributionLedger;
  readonly retryCount?: number;
  readonly throttle?: boolean;
}): RedskilledActivityTransport {
  const baseUrl = options.endpoint == null ? undefined : restBaseUrl(options.endpoint);
  const client = createGithubClient({
    token: options.token,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(options.retryCount === undefined ? {} : { retryCount: options.retryCount }),
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
  });
  const transport = (async (query: string): Promise<unknown> => await client.graphql(query)) as RedskilledActivityTransport;
  transport.conditionalList = async (input) =>
    await client.conditionalPaginate<Record<string, unknown>>({
      cacheKey: input.cacheKey,
      route: input.route,
      parameters: input.parameters,
      operation: input.operation,
    });
  return transport;
}

function restBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (/\/api\/graphql\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/api\/graphql\/?$/, "/api/v3");
  else url.pathname = url.pathname.replace(/\/graphql\/?$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function activityRateLimitFromHeaders(headers: GithubResponseHeaders): RedskilledActivityRateLimit {
  const remaining = integerHeader(headers, "x-ratelimit-remaining");
  const resetSeconds = integerHeader(headers, "x-ratelimit-reset");
  return {
    remaining,
    reset_at: resetSeconds == null ? null : new Date(resetSeconds * 1000).toISOString(),
    exhausted: remaining === 0,
    point_cost: null,
  };
}

function mergeActivityRateLimit(
  held: RedskilledActivityRateLimit,
  next: RedskilledActivityRateLimit,
): RedskilledActivityRateLimit {
  const remaining = next.remaining == null
    ? held.remaining
    : held.remaining == null ? next.remaining : Math.min(held.remaining, next.remaining);
  return {
    remaining,
    reset_at: next.reset_at ?? held.reset_at,
    exhausted: held.exhausted || next.exhausted,
    point_cost: null,
  };
}

function integerHeader(headers: GithubResponseHeaders, name: string): number | null {
  const raw = headers[name];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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
  // Echoed, never computed: the query asks GitHub what it charged, because the
  // one number this module could plausibly invent is exactly the one that would
  // let "one request" pass for "one point".
  const cost = typeof node.cost === "number" && Number.isFinite(node.cost) ? node.cost : null;
  return { remaining, reset_at: resetAt, exhausted: flagged || remaining === 0, point_cost: cost };
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
