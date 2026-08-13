import type { GithubAttributedOperation, GithubClient } from "@reddb-io/github";

export const RELEASE_WAIT_MARKER = "<!-- red-release-wait:v1 -->";

export interface ReleaseWaitPullRequest {
  readonly number: number;
  readonly base: string;
  readonly head: string;
  readonly headCommit: string;
  readonly mergeState: string;
}

export interface ReleaseWaitRun {
  readonly id: number;
  readonly name: string;
  readonly headCommit: string;
  readonly createdAt: string;
}

export interface ReleaseWaitCheck {
  readonly name: string;
  readonly status: "pending" | "success" | "failure";
}

export interface ReleaseWaitAlert {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface ReleaseWaitGithub {
  findOpenVersionPullRequest(): Promise<ReleaseWaitPullRequest | null>;
  listActionRequiredRuns(pullRequest: ReleaseWaitPullRequest): Promise<readonly ReleaseWaitRun[]>;
  listRequiredContexts(pullRequest: ReleaseWaitPullRequest): Promise<readonly string[]>;
  listChecks(pullRequest: ReleaseWaitPullRequest): Promise<readonly ReleaseWaitCheck[]>;
  findOpenAlert(): Promise<ReleaseWaitAlert | null>;
  openAlert(input: { readonly title: string; readonly body: string }): Promise<{ readonly number: number }>;
  updateAlert(
    number: number,
    input: { readonly title: string; readonly body: string },
  ): Promise<void>;
  closeAlert(number: number): Promise<void>;
}

export interface WatchVersionPullRequestInput {
  readonly github: ReleaseWaitGithub;
}

export interface CreateGithubReleaseWaitAdapterOptions {
  readonly client: GithubClient;
  readonly owner: string;
  readonly repository: string;
  readonly actor?: string;
}

const READ_OPERATION: GithubAttributedOperation = {
  key: "release wait read",
  budget: "rest",
};
const WRITE_OPERATION: GithubAttributedOperation = {
  key: "release wait write",
  budget: "rest",
};
const SEARCH_OPERATION: GithubAttributedOperation = {
  key: "release wait alert search",
  budget: "search",
};

/** Bind release-wait observations and alert writes to the shared GitHub client. */
export function createGithubReleaseWaitAdapter(
  options: CreateGithubReleaseWaitAdapterOptions,
): ReleaseWaitGithub {
  const owner = required(options.owner, "GitHub owner");
  const repository = required(options.repository, "GitHub repository");
  const actor = options.actor ?? "release-wait";
  const repositoryKey = `${owner}/${repository}`;
  const rest = <T>(
    cacheKey: string,
    route: string,
    parameters: Readonly<Record<string, unknown>>,
    operation: GithubAttributedOperation = READ_OPERATION,
  ) => options.client.conditionalRest<T>({ cacheKey, route, parameters, operation, actor });

  return {
    async findOpenVersionPullRequest() {
      const answer = await rest<unknown[]>(
        `release-wait-pr:${repositoryKey}`,
        "GET /repos/{owner}/{repo}/pulls",
        { owner, repo: repository, state: "open", base: "main", head: `${owner}:red-release/version-pr`, per_page: 2 },
      );
      if (!Array.isArray(answer.data) || answer.data.length === 0) return null;
      if (answer.data.length > 1) throw new Error("repository has multiple open Version PRs");
      const number = positiveIntegerField(answer.data[0], "number");
      const detail = await rest<unknown>(
        `release-wait-pr:${repositoryKey}:${number}`,
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo: repository, pull_number: number },
      );
      return waitPullRequestFrom(detail.data);
    },

    async listActionRequiredRuns(pullRequest) {
      const answer = await options.client.conditionalPaginate<unknown>({
        cacheKey: `release-wait-runs:${repositoryKey}:${pullRequest.headCommit}`,
        route: "GET /repos/{owner}/{repo}/actions/runs",
        parameters: {
          owner,
          repo: repository,
          branch: pullRequest.head,
          head_sha: pullRequest.headCommit,
          status: "action_required",
        },
        operation: READ_OPERATION,
        actor,
      });
      return answer.data.map(waitRunFrom);
    },

    async listRequiredContexts(pullRequest) {
      try {
        const answer = await rest<unknown>(
          `release-wait-required:${repositoryKey}:${pullRequest.base}`,
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
          { owner, repo: repository, branch: pullRequest.base },
        );
        if (!isRecord(answer.data)) throw new Error("GitHub returned invalid required checks");
        const contexts = stringArray(answer.data.contexts);
        const checks = Array.isArray(answer.data.checks)
          ? answer.data.checks.map((check) => stringField(record(check, "required check"), "context"))
          : [];
        return [...new Set([...contexts, ...checks])];
      } catch (error) {
        if (httpStatus(error) === 404) return [];
        throw error;
      }
    },

    async listChecks(pullRequest) {
      const [checkRuns, statuses] = await Promise.all([
        rest<unknown>(
          `release-wait-check-runs:${repositoryKey}:${pullRequest.headCommit}`,
          "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          { owner, repo: repository, ref: pullRequest.headCommit, per_page: 100 },
        ),
        rest<unknown>(
          `release-wait-statuses:${repositoryKey}:${pullRequest.headCommit}`,
          "GET /repos/{owner}/{repo}/commits/{ref}/status",
          { owner, repo: repository, ref: pullRequest.headCommit, per_page: 100 },
        ),
      ]);
      const runPayload = record(checkRuns.data, "check-runs response");
      const statusPayload = record(statuses.data, "status response");
      const runs = Array.isArray(runPayload.check_runs) ? runPayload.check_runs : [];
      const commitStatuses = Array.isArray(statusPayload.statuses) ? statusPayload.statuses : [];
      return [
        ...runs.map(checkRunFrom),
        ...commitStatuses.map(commitStatusFrom),
      ];
    },

    async findOpenAlert() {
      const answer = await rest<unknown>(
        `release-wait-alert:${repositoryKey}`,
        "GET /search/issues",
        { q: `repo:${repositoryKey} is:issue is:open in:title \"Release wait:\"`, per_page: 2 },
        SEARCH_OPERATION,
      );
      const payload = record(answer.data, "release alert search");
      const items = Array.isArray(payload.items) ? payload.items : [];
      const matching = items.filter((item) => {
        const candidate = record(item, "release alert");
        return typeof candidate.body === "string" && candidate.body.includes(RELEASE_WAIT_MARKER);
      });
      if (matching.length > 1) throw new Error("repository has multiple open release-wait alerts");
      return matching.length === 0 ? null : alertFrom(matching[0]);
    },

    async openAlert(input) {
      const answer = await rest<unknown>(
        `release-wait-alert-create:${repositoryKey}`,
        "POST /repos/{owner}/{repo}/issues",
        { owner, repo: repository, title: input.title, body: input.body },
        WRITE_OPERATION,
      );
      return { number: positiveIntegerField(answer.data, "number") };
    },

    async updateAlert(number, input) {
      await rest(
        `release-wait-alert-update:${repositoryKey}:${number}`,
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo: repository, issue_number: number, title: input.title, body: input.body },
        WRITE_OPERATION,
      );
    },

    async closeAlert(number) {
      await rest(
        `release-wait-alert-close:${repositoryKey}:${number}`,
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo: repository, issue_number: number, state: "closed" },
        WRITE_OPERATION,
      );
    },
  };
}

export type ReleaseWaitResult =
  | {
      readonly state: "no-version-pr";
      readonly signal: "none" | "resolved";
    }
  | {
      readonly state: "awaiting-approval";
      readonly signal: "opened" | "updated";
      readonly pullRequest: number;
      readonly runCount: number;
    }
  | {
      readonly state: "required-contexts-missing";
      readonly signal: "opened" | "updated";
      readonly pullRequest: number;
      readonly missingContexts: readonly string[];
    }
  | {
      readonly state: "behind-base";
      readonly signal: "none" | "resolved";
      readonly pullRequest: number;
    }
  | {
      readonly state: "checks-failed";
      readonly signal: "none" | "resolved";
      readonly pullRequest: number;
      readonly failedContexts: readonly string[];
    }
  | {
      readonly state: "checks-pending";
      readonly signal: "none" | "resolved";
      readonly pullRequest: number;
      readonly pendingContexts: readonly string[];
    }
  | {
      readonly state: "clear";
      readonly signal: "none" | "resolved";
      readonly pullRequest: number;
    };

/** Classify the open Version PR and keep its durable human-facing alert current. */
export async function watchVersionPullRequest(
  input: WatchVersionPullRequestInput,
): Promise<ReleaseWaitResult> {
  const pullRequest = await input.github.findOpenVersionPullRequest();
  if (pullRequest === null) {
    return { state: "no-version-pr", signal: await clearAlert(input.github) };
  }
  const runs = (await input.github.listActionRequiredRuns(pullRequest))
    .filter((run) => run.headCommit === pullRequest.headCommit);
  if (runs.length > 0) {
    const oldest = runs.reduce((answer, run) =>
      Date.parse(run.createdAt) < Date.parse(answer.createdAt) ? run : answer
    );
    const title = `Release wait: workflow approval needed for Version PR #${pullRequest.number}`;
    const body = [
      RELEASE_WAIT_MARKER,
      "## Human action required",
      "",
      `${runs.length} workflow runs are waiting for approval on Version PR #${pullRequest.number}.`,
      `The oldest has waited since ${new Date(oldest.createdAt).toISOString()}.`,
      "",
      "Approve the pending workflow runs from the Actions page. The approval gate remains enabled.",
      "",
    ].join("\n");
    const signal = await writeAlert(input.github, { title, body });
    return {
      state: "awaiting-approval",
      signal,
      pullRequest: pullRequest.number,
      runCount: runs.length,
    };
  }

  const requiredContexts = await input.github.listRequiredContexts(pullRequest);
  const checks = await input.github.listChecks(pullRequest);
  const observed = new Set(checks.map((check) => check.name));
  const missingContexts = requiredContexts.filter((context) => !observed.has(context));
  const required = new Set(requiredContexts);
  const failedContexts = checks
    .filter((check) => required.has(check.name) && check.status === "failure")
    .map((check) => check.name);
  const pendingContexts = checks
    .filter((check) => required.has(check.name) && check.status === "pending")
    .map((check) => check.name);
  if (missingContexts.length === 0 && failedContexts.length > 0) {
    return {
      state: "checks-failed",
      signal: await clearAlert(input.github),
      pullRequest: pullRequest.number,
      failedContexts,
    };
  }
  if (missingContexts.length === 0 && pendingContexts.length > 0) {
    return {
      state: "checks-pending",
      signal: await clearAlert(input.github),
      pullRequest: pullRequest.number,
      pendingContexts,
    };
  }
  if (missingContexts.length === 0 && pullRequest.mergeState.toLowerCase() === "behind") {
    return {
      state: "behind-base",
      signal: await clearAlert(input.github),
      pullRequest: pullRequest.number,
    };
  }
  if (missingContexts.length === 0) {
    return {
      state: "clear",
      signal: await clearAlert(input.github),
      pullRequest: pullRequest.number,
    };
  }
  const title = `Release wait: checks never started for Version PR #${pullRequest.number}`;
  const body = [
    RELEASE_WAIT_MARKER,
    "## Release checks never started",
    "",
    `Version PR #${pullRequest.number} has no result for required contexts: ${missingContexts.join(", ")}.`,
    "No workflow run is awaiting approval, so this is distinct from an approval-held release.",
    "",
  ].join("\n");
  const signal = await writeAlert(input.github, { title, body });
  return {
    state: "required-contexts-missing",
    signal,
    pullRequest: pullRequest.number,
    missingContexts,
  };
}

async function writeAlert(
  github: ReleaseWaitGithub,
  input: { readonly title: string; readonly body: string },
): Promise<"opened" | "updated"> {
  const existing = await github.findOpenAlert();
  if (existing === null) {
    await github.openAlert(input);
    return "opened";
  }
  await github.updateAlert(existing.number, input);
  return "updated";
}

async function clearAlert(github: ReleaseWaitGithub): Promise<"none" | "resolved"> {
  const existing = await github.findOpenAlert();
  if (existing === null) return "none";
  await github.closeAlert(existing.number);
  return "resolved";
}

function waitPullRequestFrom(value: unknown): ReleaseWaitPullRequest {
  const pullRequest = record(value, "Version PR");
  const base = record(pullRequest.base, "Version PR base");
  const head = record(pullRequest.head, "Version PR head");
  return {
    number: positiveIntegerField(pullRequest, "number"),
    base: stringField(base, "ref"),
    head: stringField(head, "ref"),
    headCommit: stringField(head, "sha"),
    mergeState: stringField(pullRequest, "mergeable_state"),
  };
}

function waitRunFrom(value: unknown): ReleaseWaitRun {
  const run = record(value, "workflow run");
  return {
    id: positiveIntegerField(run, "id"),
    name: stringField(run, "name"),
    headCommit: stringField(run, "head_sha"),
    createdAt: stringField(run, "created_at"),
  };
}

function checkRunFrom(value: unknown): ReleaseWaitCheck {
  const check = record(value, "check run");
  const status = stringField(check, "status");
  const conclusion = typeof check.conclusion === "string" ? check.conclusion : null;
  return {
    name: stringField(check, "name"),
    status: status !== "completed"
      ? "pending"
      : conclusion === "success" || conclusion === "neutral" || conclusion === "skipped"
        ? "success"
        : "failure",
  };
}

function commitStatusFrom(value: unknown): ReleaseWaitCheck {
  const status = record(value, "commit status");
  const state = stringField(status, "state");
  return {
    name: stringField(status, "context"),
    status: state === "success" ? "success" : state === "pending" ? "pending" : "failure",
  };
}

function alertFrom(value: unknown): ReleaseWaitAlert {
  const alert = record(value, "release alert");
  return {
    number: positiveIntegerField(alert, "number"),
    title: stringField(alert, "title"),
    body: stringField(alert, "body"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`GitHub returned an invalid ${label}`);
  return value;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`GitHub payload has no ${key}`);
  return field;
}

function positiveIntegerField(value: unknown, key: string): number {
  const payload = record(value, "payload");
  const field = payload[key];
  if (!Number.isSafeInteger(field) || (field as number) <= 0) {
    throw new Error(`GitHub payload has no ${key}`);
  }
  return field as number;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("GitHub returned invalid required check contexts");
  }
  return value as string[];
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} must not be empty`);
  return normalized;
}

function httpStatus(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number" ? error.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
