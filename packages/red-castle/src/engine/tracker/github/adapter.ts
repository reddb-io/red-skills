import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { planGithubRestRead } from "@reddb-io/github";
import type {
  TrackerIssue,
  TrackerPort,
  TrackerIssueCreateSpec,
  TrackerLabelMutation,
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
  readonly repo?: string;
  readonly claimLockRoot?: string;
}

interface GhIssueListRow {
  readonly number?: unknown;
  readonly body?: unknown;
  readonly labels?: unknown;
}

interface GhIssueViewRow {
  readonly state?: unknown;
  readonly number?: unknown;
  readonly title?: unknown;
  readonly url?: unknown;
  readonly comments?: unknown;
}

export function createGitHubTrackerAdapter(
  options: GitHubTrackerAdapterOptions = {},
): TrackerPort {
  const gh = options.gh ?? defaultGhExec;
  const withRepo = (args: string[]): string[] =>
    options.repo ? [...args, "--repo", options.repo] : args;
  const localClaims = createFsIssueLeaseStore(
    options.claimLockRoot ?? join(process.cwd(), ".red", "tmp", "claims"),
  );
  const remoteClaims: TrackerClaimStore = {
    postClaim: (issue, body) => postIssueComment(gh, options.repo, issue, body),
    listClaims: (issue) => listIssueComments(gh, withRepo, issue),
    concede: async (issue, body) => {
      await postIssueComment(gh, options.repo, issue, body);
    },
  };

  return {
    async createIssue(spec: TrackerIssueCreateSpec) {
      const stdout = await gh(
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
      const match = stdout.match(/\/issues\/(\d+)\b/);
      const issue = match ? Number(match[1]) : NaN;
      if (!Number.isInteger(issue) || issue <= 0) {
        throw new Error(
          `tracker failed to create issue: unparseable gh output ${JSON.stringify(stdout.trim())}`,
        );
      }
      return issue;
    },
    async listOpenIssuesByLabel(label) {
      const stdout = await gh(
        withRepo([
          "issue",
          "list",
          "--state",
          "open",
          "--label",
          label,
          "--json",
          "number,body,labels",
          "--limit",
          "1000",
        ]),
      );
      return parseIssueList(stdout);
    },
    async listClosedIssuesByAnyLabel(labelNames, limit) {
      if (labelNames.length === 0) return [];
      // ONE search request covers every role: repeated `--label` flags are ANDed
      // by gh, while a single `label:"a","b"` search qualifier is the OR this
      // read needs (#2749). Never a per-label loop — the sweep runs on a timer.
      const stdout = await gh(
        withRepo([
          "issue",
          "list",
          "--state",
          "closed",
          "--search",
          `label:${labelNames.map((name) => `"${name}"`).join(",")}`,
          "--json",
          "number,body,labels",
          "--limit",
          String(limit),
        ]),
      );
      return parseIssueList(stdout);
    },
    async isIssueClosed(issue) {
      // One issue by number is a single-object read, so it goes to REST — the
      // pool GraphQL's node-point budget was starving while sitting idle
      // (ADR 0132 decision 4). `packages/github` owns that decision for the
      // castle and the daemon alike; a second table here would drift.
      const row = await viewSingleIssue(gh, withRepo, options.repo, issue, ["state"]);
      return row.state === "CLOSED";
    },
    async editIssueLabels(issue, mutation) {
      const args = ["issue", "edit", String(issue)];
      appendLabelArgs(args, "--remove-label", mutation.remove);
      appendLabelArgs(args, "--add-label", mutation.add);
      await gh(withRepo(args));
    },
    async editIssueBody(issue, body) {
      await gh(withRepo(["issue", "edit", String(issue), "--body", body]));
    },
    async commentOnIssue(issue, body) {
      await gh(withRepo(["issue", "comment", String(issue), "--body", body]));
    },
    async closeIssue(issue) {
      await gh(withRepo(["issue", "close", String(issue)]));
    },
    async issueReference(issue) {
      const row = await viewSingleIssue(gh, withRepo, options.repo, issue, [
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
 * Read one issue on the surface `@reddb-io/github` routes it to. A field with no
 * single-request REST projection keeps gh's own `issue view` command — a named
 * field gap, never the old "everything unclassified is GraphQL" default.
 */
async function viewSingleIssue(
  gh: GhExec,
  withRepo: (args: string[]) => string[],
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
    const stdout = await gh(withRepo(["issue", "view", String(issue), "--json", fields.join(",")]));
    return parseJson<GhIssueViewRow>(stdout);
  }
  const stdout = await gh([...plan.args]);
  return plan.decode(stdout) as GhIssueViewRow;
}

function labelArgs(labels: readonly string[]): string[] {
  return labels.flatMap((label) => ["--label", label]);
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
  args.push(flag, labels.join(","));
}

function parseIssueList(stdout: string): TrackerIssue[] {
  const rows = parseJson<GhIssueListRow[]>(stdout);
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
  repo: string | undefined,
  issue: number,
  body: string,
): Promise<number> {
  if (repo) {
    const stdout = await gh([
      "api",
      `repos/${repo}/issues/${issue}/comments`,
      "-f",
      `body=${body}`,
      "--jq",
      ".id",
    ]);
    const id = Number(stdout.trim());
    if (Number.isFinite(id)) return id;
  } else {
    await gh(["issue", "comment", String(issue), "--body", body]);
  }

  const comments = await listIssueComments(gh, (args) => args, issue);
  const match = comments
    .filter((comment) => comment.body === body)
    .sort((a, b) => b.id - a.id)[0];
  if (match) return match.id;
  throw new Error(
    `unable to resolve posted claim comment id for issue #${issue}`,
  );
}

async function listIssueComments(
  gh: GhExec,
  withRepo: (args: string[]) => string[],
  issue: number,
): Promise<RawClaimComment[]> {
  const stdout = await gh(
    withRepo(["issue", "view", String(issue), "--json", "comments"]),
  );
  const row = parseJson<GhIssueViewRow>(stdout);
  if (!Array.isArray(row.comments)) return [];
  const comments: RawClaimComment[] = [];
  for (const item of row.comments) {
    if (!item || typeof item !== "object") continue;
    const rec = item as {
      id?: unknown;
      databaseId?: unknown;
      body?: unknown;
      createdAt?: unknown;
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
      createdAt: typeof rec.createdAt === "string" ? rec.createdAt : undefined,
    });
  }
  return comments;
}

function parseJson<T>(stdout: string): T {
  const text = stdout.trim();
  if (text === "") return undefined as T;
  return JSON.parse(text) as T;
}
