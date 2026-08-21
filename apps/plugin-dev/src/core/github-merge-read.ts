// github-merge-read — the one routed read shape used by every merge poll.
//
// A merge observation is composite on REST: the pull request carries merge and
// head/base facts, while check runs and commit statuses are separate resources.
// Keeping that composition here lets the tolerant merge parsers retain their
// historical JSON boundary without sending either hot loop back through `gh`'s
// GraphQL-backed `pr view` / `pr checks` commands.

import {
  planGithubRestRead,
  routeGithubArgs,
  type GithubApiSurface,
  type GithubClient,
} from "@reddb-io/github";

export interface GithubMergeRead {
  /** `gh pr checks --json name,state` compatible JSON. */
  reviewChecks(repo: string, prNumber: number): Promise<string>;
  /** `gh pr view --json ...statusCheckRollup` compatible JSON. */
  mergeState(repo: string, prNumber: number): Promise<string>;
  /** Merge-driver `gh pr view` compatible JSON. */
  driverPr(repo: string, prNumber: number): Promise<string>;
  /** Required status contexts on one protected branch. */
  requiredCheckContexts(repo: string, branch: string): Promise<string>;
}

export interface GithubShipRead extends GithubMergeRead {
  /** Retired ship reader's `gh pr view` compatible review and rollup facts. */
  shipPr(repo: string, prNumber: number): Promise<string>;
}

type JsonObject = Record<string, unknown>;

interface PullObservation {
  readonly projected: JsonObject;
  readonly headRefOid: string;
}

interface CheckRunList {
  readonly check_runs?: unknown;
}

interface CommitStatusList {
  readonly statuses?: unknown;
}

interface PullReview {
  readonly state?: string | null;
  readonly user?: { readonly login?: string | null } | null;
}

interface RequiredPullRequestReviews {
  readonly required_approving_review_count?: number | null;
}

interface ReviewThreadNode {
  readonly isResolved?: boolean | null;
}

interface ReviewThreadsAnswer {
  readonly repository?: {
    readonly pullRequest?: {
      readonly reviewThreads?: {
        readonly nodes?: ReadonlyArray<ReviewThreadNode | null> | null;
        readonly pageInfo?: {
          readonly hasNextPage?: boolean | null;
          readonly endCursor?: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

const PR_VIEW_OPERATION = routeGithubArgs(["pr", "view"]);
const PR_CHECKS_OPERATION = routeGithubArgs(["pr", "checks"]);
const API_REST_OPERATION = routeGithubArgs(["api", "rest"]);

const UNRESOLVED_REVIEW_THREADS_QUERY = `
  query RedSkillsMergeDriverReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            isResolved
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function repoParts(slug: string): { owner: string; repo: string } {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) {
    throw new Error(`GitHub merge polling needs an owner/repo slug, received ${JSON.stringify(slug)}`);
  }
  return { owner: slug.slice(0, slash), repo: slug.slice(slash + 1) };
}

function projectPull(
  value: unknown,
  surface: GithubApiSurface,
  repo: string,
  prNumber: number,
  fields: readonly string[],
): JsonObject {
  if (surface === "graphql") return object(value) ?? {};
  const plan = planGithubRestRead({ kind: "pr", number: prNumber, fields, repo });
  if (plan.outcome !== "plan") throw new Error(plan.reason);
  return plan.decode(JSON.stringify(value));
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is JsonObject => row !== null) : [];
}

function httpStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status) || null
    : null;
}

function checkRunState(run: JsonObject): string {
  const status = text(run.status).toUpperCase();
  const conclusion = text(run.conclusion).toUpperCase();
  if (status !== "" && status !== "COMPLETED") return "PENDING";
  return conclusion || status;
}

function rollup(checkRuns: unknown, statuses: unknown): JsonObject[] {
  return [
    ...rows(checkRuns).map((run) => ({
      name: text(run.name),
      status: text(run.status),
      conclusion: run.conclusion ?? null,
    })),
    ...rows(statuses).map((status) => ({
      context: text(status.context),
      state: text(status.state),
    })),
  ];
}

/** Build the merge reader over one resident/Worker-lifetime conditional client. */
export function createGithubMergeRead(client: GithubClient, actor: string): GithubShipRead {
  if (actor.trim() === "") throw new Error("GitHub merge reads require a non-empty attribution actor");

  const readPull = async (
    slug: string,
    prNumber: number,
    fields: readonly string[],
  ): Promise<PullObservation> => {
    const repo = repoParts(slug);
    const answer = await client.singleObject<JsonObject>({
      cacheKey: `merge:pr:${slug}:${prNumber}:${fields.join(",")}`,
      kind: "pr",
      owner: repo.owner,
      repo: repo.repo,
      number: prNumber,
      selection: fields.join(" "),
      operation: PR_VIEW_OPERATION,
      actor,
      project: (value, surface) => projectPull(value, surface, slug, prNumber, fields),
    });
    const projected = object(answer.data) ?? {};
    return { projected, headRefOid: text(projected.headRefOid) };
  };

  const readRollup = async (slug: string, headRefOid: string): Promise<JsonObject[]> => {
    if (headRefOid === "") return [];
    const repo = repoParts(slug);
    const [checks, statuses] = await Promise.all([
      client.conditionalRest<CheckRunList>({
        cacheKey: `merge:checks:${slug}:${headRefOid}`,
        route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        parameters: { ...repo, ref: headRefOid, per_page: 100 },
        operation: PR_CHECKS_OPERATION,
        actor,
      }),
      client.conditionalRest<CommitStatusList>({
        cacheKey: `merge:statuses:${slug}:${headRefOid}`,
        route: "GET /repos/{owner}/{repo}/commits/{ref}/status",
        parameters: { ...repo, ref: headRefOid, per_page: 100 },
        operation: PR_CHECKS_OPERATION,
        actor,
      }),
    ]);
    return rollup(object(checks.data)?.check_runs, object(statuses.data)?.statuses);
  };

  const composite = async (
    slug: string,
    prNumber: number,
    fields: readonly string[],
  ): Promise<JsonObject> => {
    const pull = await readPull(slug, prNumber, fields);
    return { ...pull.projected, statusCheckRollup: await readRollup(slug, pull.headRefOid) };
  };

  const readReviews = async (slug: string, prNumber: number): Promise<PullReview[]> => {
    const repo = repoParts(slug);
    const answer = await client.conditionalRest<PullReview[]>({
      cacheKey: `merge:reviews:${slug}:${prNumber}`,
      route: "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      parameters: { ...repo, pull_number: prNumber, per_page: 100 },
      operation: PR_VIEW_OPERATION,
      actor,
    });
    return Array.isArray(answer.data) ? answer.data : [];
  };

  const requiredApprovalCount = async (slug: string, branch: string): Promise<number> => {
    if (branch === "") return 0;
    const repo = repoParts(slug);
    try {
      const answer = await client.conditionalRest<RequiredPullRequestReviews>({
        cacheKey: `merge:required-reviews:${slug}:${branch}`,
        route: "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews",
        parameters: { ...repo, branch },
        operation: API_REST_OPERATION,
        actor,
      });
      const count = Number(answer.data?.required_approving_review_count ?? 0);
      return Number.isSafeInteger(count) && count > 0 ? count : 0;
    } catch (error) {
      if (httpStatus(error) === 404) return 0;
      throw error;
    }
  };

  return {
    async reviewChecks(slug, prNumber) {
      const pull = await readPull(slug, prNumber, ["headRefOid"]);
      const checks = await readRollup(slug, pull.headRefOid);
      return JSON.stringify(checks.map((row) => ({
        name: text(row.name) || text(row.context),
        state: row.context === undefined ? checkRunState(row) : text(row.state).toUpperCase(),
      })));
    },

    async mergeState(slug, prNumber) {
      return JSON.stringify(await composite(slug, prNumber, [
        "mergeStateStatus",
        "mergeable",
        "baseRefOid",
        "headRefOid",
      ]));
    },

    async driverPr(slug, prNumber) {
      const pull = await composite(slug, prNumber, [
        "state",
        "mergeStateStatus",
        "mergeable",
        "headRefOid",
        "isDraft",
        "reviewDecision",
      ]);
      const repo = repoParts(slug);
      let unresolvedReviewThreads = 0;
      try {
        let after: string | null = null;
        for (;;) {
          const answer: ReviewThreadsAnswer = await client.graphql<ReviewThreadsAnswer>(UNRESOLVED_REVIEW_THREADS_QUERY, {
            owner: repo.owner,
            repo: repo.repo,
            number: prNumber,
            after,
          }, {
            operation: PR_VIEW_OPERATION,
            actor,
          });
          const threads = answer.repository?.pullRequest?.reviewThreads;
          unresolvedReviewThreads += (threads?.nodes ?? [])
            .filter((node) => node != null && node.isResolved === false)
            .length;
          if (threads?.pageInfo?.hasNextPage !== true || !threads.pageInfo.endCursor) break;
          after = threads.pageInfo.endCursor;
        }
      } catch {
        unresolvedReviewThreads = 0;
      }
      return JSON.stringify({ ...pull, unresolvedReviewThreads });
    },

    async shipPr(slug, prNumber) {
      const pull = await readPull(slug, prNumber, ["headRefOid", "baseRefName"]);
      const baseRefName = text(pull.projected.baseRefName);
      const [statusCheckRollup, reviews, requiredApprovals] = await Promise.all([
        readRollup(slug, pull.headRefOid),
        readReviews(slug, prNumber),
        requiredApprovalCount(slug, baseRefName),
      ]);
      const latestReviewByActor = new Map<string, string>();
      for (const review of reviews) {
        const login = text(review.user?.login);
        if (login !== "") latestReviewByActor.set(login, text(review.state).toUpperCase());
      }
      const approvals = [...latestReviewByActor.values()].filter((state) => state === "APPROVED").length;
      const changesRequested = reviews.some((review) => text(review.state).toUpperCase() === "CHANGES_REQUESTED");
      const reviewDecision = changesRequested
        ? "CHANGES_REQUESTED"
        : approvals < requiredApprovals ? "REVIEW_REQUIRED" : approvals > 0 ? "APPROVED" : "";
      return JSON.stringify({ reviewDecision, reviews, statusCheckRollup });
    },

    async requiredCheckContexts(slug, branch) {
      const repo = repoParts(slug);
      const answer = await client.conditionalRest<unknown>({
        cacheKey: `merge:required-contexts:${slug}:${branch}`,
        route: "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
        parameters: { ...repo, branch },
        operation: API_REST_OPERATION,
        actor,
      });
      return JSON.stringify(answer.data);
    },
  };
}
