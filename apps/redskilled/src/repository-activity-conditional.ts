/** Presence-driven conditional REST polling for repository activity. */

import {
  githubRateLimitResetAt,
  isGithubRateLimitError,
  type GithubAttributedOperation,
  type GithubResponseHeaders,
} from "@reddb-io/github";
import type {
  FetchRepositoryActivityInput,
  RedskilledActivityCounts,
  RedskilledActivityOperation,
  RedskilledActivityQueueLabels,
  RedskilledActivityRateLimit,
  RedskilledProjectActivity,
  RedskilledRepositoryActivity,
} from "./repository-activity.js";

/** Panorama totals refresh on a human-glance cadence while queue depth stays attended-fast. */
export const REDSKILLED_PANORAMA_REFRESH_MS = 4 * 60 * 1_000;

const REDSKILLED_ACTIVITY_REST_OPERATION: GithubAttributedOperation = {
  key: "redskilled repository activity poll",
  budget: "rest",
};
const REDSKILLED_MERGED_TODAY_OPERATION: GithubAttributedOperation = {
  key: "redskilled merged-today poll",
  budget: "search",
};

export async function fetchConditionalRepositoryActivity(
  input: FetchRepositoryActivityInput,
  operation: RedskilledActivityOperation,
): Promise<RedskilledRepositoryActivity> {
  const nowMs = Date.parse(input.now);
  const list = input.transport.conditionalList!;
  const count = input.transport.conditionalCount!;
  const previous = new Map((input.previous?.projects ?? []).map((entry) => [entry.project_label, entry]));
  const panoramaRefreshMs = input.panoramaRefreshMs ?? REDSKILLED_PANORAMA_REFRESH_MS;
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
    const held = previous.get(project.project_label);
    const heldAt = Date.parse(held?.panorama_fetched_at ?? input.previous?.fetched_at ?? "");
    const refreshPanorama = held?.counts == null || !Number.isFinite(nowMs) || !Number.isFinite(heldAt) ||
      nowMs - heldAt >= panoramaRefreshMs;
    try {
      const issueParams = { owner: project.owner, repo: project.name, state: "open" };
      const issueAnswer = await list({
        cacheKey: `activity:${repository}:open-issues:${JSON.stringify(issueParams)}`,
        route: "GET /repos/{owner}/{repo}/issues",
        parameters: issueParams,
        operation: REDSKILLED_ACTIVITY_REST_OPERATION,
      });
      requestCount += issueAnswer.requestCount;
      rateLimit = mergeActivityRateLimit(rateLimit, activityRateLimitFromHeaders(issueAnswer.headers));
      const openIssues = issueAnswer.data.filter((item) => !isRecord(item.pull_request));
      const queue = project.queue_labels == null
        ? { ready_queue: null, human_queue: null }
        : countQueueLabels(openIssues, project.queue_labels);

      let panorama = held?.counts ?? null;
      if (refreshPanorama) {
        const prParams = { owner: project.owner, repo: project.name, state: "open" };
        const closedParams = { owner: project.owner, repo: project.name, state: "closed", since: operation.closed_since };
        const mergedParams = { q: `repo:${repository} is:pr is:merged merged:>=${operation.merged_since}`, per_page: 1 };
        const prAnswer = await list({
          cacheKey: `activity:${repository}:open-prs:${JSON.stringify(prParams)}`,
          route: "GET /repos/{owner}/{repo}/pulls",
          parameters: prParams,
          operation: REDSKILLED_ACTIVITY_REST_OPERATION,
        });
        const closedAnswer = await list({
          cacheKey: `activity:${repository}:recently-closed:${JSON.stringify(closedParams)}`,
          route: "GET /repos/{owner}/{repo}/issues",
          parameters: closedParams,
          operation: REDSKILLED_ACTIVITY_REST_OPERATION,
        });
        const mergedAnswer = await count({
          cacheKey: `activity:${repository}:merged-today:${operation.merged_since}`,
          route: "GET /search/issues",
          parameters: mergedParams,
          operation: REDSKILLED_MERGED_TODAY_OPERATION,
        });
        requestCount += prAnswer.requestCount + closedAnswer.requestCount + mergedAnswer.requestCount;
        for (const headers of [prAnswer.headers, closedAnswer.headers, mergedAnswer.headers]) {
          rateLimit = mergeActivityRateLimit(rateLimit, activityRateLimitFromHeaders(headers));
        }
        const recentlyClosed = closedAnswer.data
          .filter((item) => !isRecord(item.pull_request))
          .filter((item) => stringValue(item.closed_at) >= operation.closed_since).length;
        if (!Number.isSafeInteger(mergedAnswer.data.total_count) || mergedAnswer.data.total_count < 0) {
          throw new Error(`GitHub returned no merged-today count for ${repository}`);
        }
        panorama = {
          open_pull_requests: prAnswer.data.length,
          open_issues: openIssues.length,
          recently_closed: recentlyClosed,
          merged_today: mergedAnswer.data.total_count,
          ready_queue: queue.ready_queue,
          human_queue: queue.human_queue,
        };
      }
      if (panorama == null) throw new Error(`no panorama cache exists for ${repository}`);
      projects.push({
        project_label: project.project_label,
        repository,
        outcome: "counted",
        counts: {
          open_pull_requests: panorama.open_pull_requests,
          open_issues: panorama.open_issues,
          recently_closed: panorama.recently_closed,
          merged_today: panorama.merged_today,
          ...queue,
        },
        panorama_fetched_at: refreshPanorama ? input.now : held?.panorama_fetched_at ?? input.previous?.fetched_at ?? input.now,
        queue_fetched_at: input.now,
        detail: `counted ${repository} for project ${JSON.stringify(project.project_label)}`,
      });
    } catch (error) {
      const rateLimited = isGithubRateLimitError(error);
      rateLimit = mergeActivityRateLimit(rateLimit, {
        remaining: null,
        reset_at: rateLimited ? githubRateLimitResetAt(error) : null,
        exhausted: rateLimited,
        point_cost: null,
      });
      const failure = error instanceof Error ? error.message : String(error);
      projects.push(held?.counts == null
        ? {
            project_label: project.project_label,
            repository,
            outcome: rateLimited ? "rate-limited" : "unreachable",
            counts: null,
            detail: `the activity fetch failed before ${repository} answered: ${failure}`,
          }
        : {
            ...held,
            // Preserve both cache instants so consumers age last-known values honestly.
            detail: `serving last-known counters after the activity fetch failed: ${failure}`,
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

type RedskilledActivityQueueCounts = Pick<RedskilledActivityCounts, "ready_queue" | "human_queue">;

function countQueueLabels(
  items: readonly Record<string, unknown>[],
  labels: RedskilledActivityQueueLabels,
): RedskilledActivityQueueCounts {
  const carries = (item: Record<string, unknown>, label: string): boolean =>
    Array.isArray(item.labels) && item.labels.some((entry) => labelName(entry) === label);
  return {
    ready_queue: items.filter((item) => carries(item, labels.ready)).length,
    human_queue: items.filter((item) => carries(item, labels.human)).length,
  };
}

function labelName(entry: unknown): string {
  if (typeof entry === "string") return entry;
  return isRecord(entry) ? stringValue(entry.name) : "";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
