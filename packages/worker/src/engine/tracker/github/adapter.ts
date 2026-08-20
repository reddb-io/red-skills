import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createGithubClient,
  planGithubRestRead,
  planGithubWrite,
  type GithubClient,
  type GithubWriteContext,
} from "@reddb-io/github";
import { resolveRepoSlugForDir } from "@reddb-io/shared/project-identity-resolve.js";
import type {
  TrackerIssue,
  TrackerPort,
  TrackerIssueCreateSpec,
  TrackerIssueReference,
} from "../port.js";
import {
  acquireIssueLease,
  createFsIssueLeaseStore,
  retireIssueLease as retireClaimLease,
  type RawClaimComment,
  type TrackerClaimStore,
} from "../claim.js";

const execFileAsync = promisify(execFile);

export type GhExec = (args: readonly string[]) => Promise<string>;

export interface GitHubTrackerAdapterOptions {
  readonly gh?: GhExec;
  readonly github?: Pick<GithubClient, "conditionalRest">;
  readonly repo?: string;
  readonly claimLockRoot?: string;
}

interface GhIssueViewRow {
  readonly state?: unknown;
  readonly number?: unknown;
  readonly title?: unknown;
  readonly url?: unknown;
  readonly labels?: unknown;
}

export function createGitHubTrackerAdapter(
  options: GitHubTrackerAdapterOptions = {},
): TrackerPort {
  const gh = options.gh ?? defaultGhExec;
  const configuredRepo = (options.repo ?? process.env.GH_REPO ?? "").trim();
  const repo = configuredRepo || resolveRepoSlugForDir(process.cwd());
  let github = options.github;
  const githubClient = (): Pick<GithubClient, "conditionalRest"> => {
    if (github) return github;
    const token = readTrackerToken();
    if (token === "")
      throw new Error(
        "GitHub tracker reads require an authenticated tracker credential",
      );
    github = createGithubClient({ token });
    return github;
  };
  const withRepo = (args: string[]): string[] =>
    repo ? [...args, "--repo", repo] : args;
  const localClaims = createFsIssueLeaseStore(
    options.claimLockRoot ?? join(process.cwd(), ".red", "tmp", "claims"),
  );
  const remoteClaims: TrackerClaimStore = {
    postClaim: (issue, body) =>
      postIssueComment(gh, githubClient(), repo, issue, body),
    listClaims: (issue) => listIssueComments(githubClient(), repo, issue),
    concede: async (issue, body) => {
      await postIssueComment(gh, githubClient(), repo, issue, body);
    },
  };

  return {
    async createIssue(spec: TrackerIssueCreateSpec) {
      const stdout = await runGithubWrite(
        gh,
        withRepo([
          "issue",
          "create",
          "--title",
          spec.title,
          "--body",
          spec.body,
          ...labelArgs(spec.labels ?? []),
        ]),
      );
      const issue = createdIssueNumber(stdout);
      if (!Number.isInteger(issue) || issue <= 0) {
        throw new Error(
          `tracker failed to create issue: unparseable gh output ${JSON.stringify(stdout.trim())}`,
        );
      }
      return issue;
    },
    async listOpenIssuesByLabel(label) {
      const rows = await listRepositoryIssues(
        githubClient(),
        repo,
        "open",
        label,
      );
      return parseIssueRows(rows);
    },
    async listClosedIssuesByAnyLabel(labelNames, limit) {
      if (labelNames.length === 0) return [];
      // ONE search request covers every role: repeated `--label` flags are ANDed
      // by gh, while a single `label:"a","b"` search qualifier is the OR this
      // read needs (#2749). Never a per-label loop — the sweep runs on a timer.
      const rows = await searchClosedIssues(
        githubClient(),
        repo,
        labelNames,
        limit,
      );
      return parseIssueRows(rows);
    },
    async isIssueClosed(issue) {
      // One issue by number is a single-object read, so it goes to REST — the
      // pool GraphQL's node-point budget was starving while sitting idle
      // (ADR 0132 decision 4). `packages/github` owns that decision for the
      // castle and the daemon alike; a second table here would drift.
      const row = await viewSingleIssue(githubClient(), repo, issue, ["state"]);
      return row.state === "CLOSED";
    },
    async editIssueLabels(issue, mutation) {
      const args = ["issue", "edit", String(issue)];
      appendLabelArgs(args, "--remove-label", mutation.remove);
      appendLabelArgs(args, "--add-label", mutation.add);
      let context: GithubWriteContext = {};
      if (repo) {
        const row = await viewSingleIssue(githubClient(), repo, issue, [
          "labels",
        ]);
        context = { currentIssueLabels: parseLabels(row.labels) };
      }
      await runGithubWrite(gh, withRepo(args), context);
    },
    async editIssueBody(issue, body) {
      await runGithubWrite(
        gh,
        withRepo(["issue", "edit", String(issue), "--body", body]),
      );
    },
    async commentOnIssue(issue, body) {
      await runGithubWrite(
        gh,
        withRepo(["issue", "comment", String(issue), "--body", body]),
      );
    },
    async closeIssue(issue) {
      await runGithubWrite(gh, withRepo(["issue", "close", String(issue)]));
    },
    async issueReference(issue) {
      const row = await viewSingleIssue(githubClient(), repo, issue, [
        "number",
        "title",
        "url",
      ]);
      const number = typeof row.number === "number" ? row.number : issue;
      return {
        number,
        title: typeof row.title === "string" ? row.title : undefined,
        url: typeof row.url === "string" ? row.url : undefined,
      } satisfies TrackerIssueReference;
    },
    async claimIssueLease(request) {
      return acquireIssueLease({
        issue: request.issue,
        identity: { worker: request.worker, runner: request.runner },
        local: localClaims,
        remote: remoteClaims,
        liveness: request.liveness,
      });
    },
    async retireIssueLease(request) {
      await retireClaimLease({
        issue: request.issue,
        identity: { worker: request.worker, runner: request.runner },
        local: localClaims,
        remote: remoteClaims,
      });
    },
  };
}

/**
 * Read one issue through the shared conditional REST client, using the shared
 * plan to preserve the field projection exposed by the tracker port.
 */
async function viewSingleIssue(
  github: Pick<GithubClient, "conditionalRest">,
  repo: string | undefined,
  issue: number,
  fields: readonly string[],
): Promise<GhIssueViewRow> {
  const plan = planGithubRestRead({
    kind: "issue",
    number: issue,
    fields,
    ...(repo ? { repo } : {}),
  });
  if (plan.outcome !== "plan") {
    throw new Error(plan.reason);
  }
  const coordinates = repoCoordinates(repo);
  const answer = await github.conditionalRest<unknown>({
    cacheKey: `red-castle:issue:${repo}:${issue}:${fields.join(",")}`,
    route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
    parameters: { ...coordinates, issue_number: issue },
    operation: { key: "issue view", budget: "rest" },
    actor: "red-castle",
  });
  return plan.decode(JSON.stringify(answer.data)) as GhIssueViewRow;
}

function repoCoordinates(slug: string | undefined): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...extra] = slug?.split("/") ?? [];
  if (!owner || !repo || extra.length > 0) {
    throw new Error(
      `GitHub tracker reads require an owner/repo slug, received ${JSON.stringify(slug ?? "")}`,
    );
  }
  return { owner, repo };
}

function readTrackerToken(): string {
  const fromEnv = (
    process.env.REDSKILLED_HOST_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    ""
  ).trim();
  if (fromEnv !== "") return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function labelArgs(labels: readonly string[]): string[] {
  return labels.flatMap((label) => ["--label", label]);
}

async function runGithubWrite(
  gh: GhExec,
  args: readonly string[],
  context: GithubWriteContext = {},
): Promise<string> {
  const plan = planGithubWrite(["gh", ...args], context);
  return gh(plan.args[0] === "gh" ? plan.args.slice(1) : plan.args);
}

async function defaultGhExec(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args as string[], {
    encoding: "utf8",
  });
  return stdout;
}

function appendLabelArgs(
  args: string[],
  flag: string,
  labels: readonly string[],
): void {
  if (labels.length === 0) return;
  for (const label of labels) args.push(flag, label);
}

async function listRepositoryIssues(
  github: Pick<GithubClient, "conditionalRest">,
  slug: string | undefined,
  state: "open" | "closed",
  labels: string,
): Promise<unknown[]> {
  const coordinates = repoCoordinates(slug);
  const rows: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const answer = await github.conditionalRest<unknown[]>({
      cacheKey: `red-castle:issues:${slug}:${state}:${labels}:${page}`,
      route: "GET /repos/{owner}/{repo}/issues",
      parameters: { ...coordinates, state, labels, per_page: 100, page },
      operation: { key: "issue list", budget: "rest" },
      actor: "red-castle",
    });
    if (!Array.isArray(answer.data)) return rows;
    rows.push(
      ...answer.data.filter(
        (row) => !row || typeof row !== "object" || !("pull_request" in row),
      ),
    );
    if (answer.data.length < 100) break;
  }
  return rows;
}

async function searchClosedIssues(
  github: Pick<GithubClient, "conditionalRest">,
  slug: string | undefined,
  labelNames: readonly string[],
  limit: number,
): Promise<unknown[]> {
  repoCoordinates(slug);
  const rows: unknown[] = [];
  const q = `repo:${slug} is:issue is:closed label:${labelNames.map((name) => `"${name}"`).join(",")}`;
  for (let page = 1; rows.length < limit; page += 1) {
    const perPage = Math.min(100, limit - rows.length);
    const answer = await github.conditionalRest<{ items?: unknown[] }>({
      cacheKey: `red-castle:issues:${slug}:closed:any:${labelNames.join(",")}:${page}:${perPage}`,
      route: "GET /search/issues",
      parameters: { q, per_page: perPage, page },
      operation: { key: "issue list", budget: "rest" },
      actor: "red-castle",
    });
    const items = Array.isArray(answer.data?.items) ? answer.data.items : [];
    rows.push(...items);
    if (items.length < perPage) break;
  }
  return rows.slice(0, limit);
}

function createdIssueNumber(stdout: string): number {
  const match = stdout.match(/\/issues\/(\d+)\b/);
  if (match) return Number(match[1]);
  try {
    const row = JSON.parse(stdout) as { number?: unknown };
    return typeof row?.number === "number" ? row.number : NaN;
  } catch {
    return NaN;
  }
}

function parseIssueRows(rows: unknown): TrackerIssue[] {
  if (!Array.isArray(rows)) return [];
  const issues: TrackerIssue[] = [];
  for (const row of rows) {
    if (typeof row.number !== "number") continue;
    issues.push({
      number: row.number,
      body: typeof row.body === "string" ? row.body : "",
      labels: parseLabels(row.labels),
    });
  }
  return issues;
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      labels.push(item);
      continue;
    }
    if (
      item &&
      typeof item === "object" &&
      "name" in item &&
      typeof item.name === "string"
    ) {
      labels.push(item.name);
    }
  }
  return labels;
}

async function postIssueComment(
  gh: GhExec,
  github: Pick<GithubClient, "conditionalRest">,
  repo: string | undefined,
  issue: number,
  body: string,
): Promise<number> {
  const stdout = await runGithubWrite(
    gh,
    repo
      ? ["issue", "comment", String(issue), "--body", body, "--repo", repo]
      : ["issue", "comment", String(issue), "--body", body],
  );
  const id = postedCommentId(stdout);
  if (id !== undefined) return id;

  const comments = await listIssueComments(github, repo, issue);
  const match = comments
    .filter((comment) => comment.body === body)
    .sort((a, b) => b.id - a.id)[0];
  if (match) return match.id;
  throw new Error(
    `unable to resolve posted claim comment id for issue #${issue}`,
  );
}

async function listIssueComments(
  github: Pick<GithubClient, "conditionalRest">,
  repo: string | undefined,
  issue: number,
): Promise<RawClaimComment[]> {
  const coordinates = repoCoordinates(repo);
  const raw: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const answer = await github.conditionalRest<unknown[]>({
      cacheKey: `red-castle:issue:${repo}:${issue}:comments:${page}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      parameters: { ...coordinates, issue_number: issue, per_page: 100, page },
      operation: { key: "issue view", budget: "rest" },
      actor: "red-castle",
    });
    if (!Array.isArray(answer.data)) break;
    raw.push(...answer.data);
    if (answer.data.length < 100) break;
  }
  const comments: RawClaimComment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as {
      id?: unknown;
      databaseId?: unknown;
      body?: unknown;
      createdAt?: unknown;
      created_at?: unknown;
    };
    const id =
      typeof rec.id === "number"
        ? rec.id
        : typeof rec.databaseId === "number"
          ? rec.databaseId
          : NaN;
    if (!Number.isFinite(id) || typeof rec.body !== "string") continue;
    comments.push({
      id,
      body: rec.body,
      createdAt:
        typeof rec.createdAt === "string"
          ? rec.createdAt
          : typeof rec.created_at === "string"
            ? rec.created_at
            : undefined,
    });
  }
  return comments;
}

function postedCommentId(stdout: string): number | undefined {
  const direct = Number(stdout.trim());
  if (Number.isFinite(direct)) return direct;
  try {
    const row = JSON.parse(stdout) as { id?: unknown };
    return typeof row?.id === "number" && Number.isFinite(row.id)
      ? row.id
      : undefined;
  } catch {
    return undefined;
  }
}
