import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { execTool } from "../runtime/exec.js";
import {
  scanRedactTargets,
  type RedactPlan,
  type RedactSweepConfig,
  type RedactTarget,
  type SkippedRedactTarget,
} from "../core/redact-sweep.js";

export interface RedactSweepGitHub {
  viewerLogin(): Promise<string>;
  listTargets(repo: string): Promise<RedactTarget[]>;
  updateTarget(target: RedactTarget, body: string): Promise<void>;
}

interface RedactSweepOptions {
  repos: string[];
  apply: boolean;
  json: boolean;
  hostPatterns: string[];
}

interface RepoReport {
  repo: string;
  mode: "dry-run" | "apply";
  editable: RedactPlan[];
  skipped: SkippedRedactTarget[];
  edited: string[];
}

function parseOptions(args: readonly string[]): RedactSweepOptions {
  const repos: string[] = [];
  // Current hostname by default; historical/legacy host prefixes come in via
  // --host-pattern so no machine identity is ever hardcoded in public source.
  const hostPatterns: string[] = [hostname()].filter(Boolean);
  let apply = false;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const takeValue = (name: string): string => {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${name} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--repo" || arg === "-R") {
      repos.push(takeValue(arg));
    } else if (arg.startsWith("--repo=")) {
      repos.push(arg.slice("--repo=".length));
    } else if (arg === "--host-pattern" || arg === "--hostname-pattern") {
      hostPatterns.push(takeValue(arg));
    } else if (arg.startsWith("--host-pattern=")) {
      hostPatterns.push(arg.slice("--host-pattern=".length));
    } else if (arg.startsWith("--hostname-pattern=")) {
      hostPatterns.push(arg.slice("--hostname-pattern=".length));
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown redact-sweep argument: ${arg}`);
    }
  }

  if (repos.length === 0) throw new Error("redact-sweep requires at least one --repo <owner/name>");
  return { repos, apply, json, hostPatterns };
}

async function tokenFromEnvironmentOrGh(cwd: string): Promise<string> {
  const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken) return envToken;
  const out = await execTool("gh", ["auth", "token"], { cwd });
  if (out.code !== 0 || !out.stdout.trim()) {
    throw new Error(`GitHub token unavailable: ${out.stderr.trim() || out.stdout.trim() || "gh auth token failed"}`);
  }
  return out.stdout.trim();
}

function parseNextLink(link: string | null): boolean {
  return link?.split(",").some((part) => part.includes('rel="next"')) ?? false;
}

class RestRedactSweepGitHub implements RedactSweepGitHub {
  constructor(private readonly token: string) {}

  async viewerLogin(): Promise<string> {
    const user = await this.requestJson<{ login?: string }>("/user");
    if (!user.login) throw new Error("GitHub API did not return an authenticated login");
    return user.login;
  }

  async listTargets(repo: string): Promise<RedactTarget[]> {
    const [issues, comments, reviewComments] = await Promise.all([
      this.paginate<IssueRow>(`/repos/${repo}/issues?state=all&per_page=100`),
      this.paginate<CommentRow>(`/repos/${repo}/issues/comments?per_page=100`),
      this.paginate<CommentRow>(`/repos/${repo}/pulls/comments?per_page=100`),
    ]);

    return [
      ...issues.flatMap((issue) => this.issueBodyTarget(repo, issue)),
      ...comments.flatMap((comment) => this.commentTarget(repo, "issue-comment", comment)),
      ...reviewComments.flatMap((comment) => this.commentTarget(repo, "review-comment", comment)),
    ];
  }

  async updateTarget(target: RedactTarget, body: string): Promise<void> {
    if (target.kind === "issue-body") {
      await this.requestJson(`/repos/${target.repo}/issues/${target.id}`, { method: "PATCH", body: { body } });
      return;
    }
    const family = target.kind === "issue-comment" ? "issues/comments" : "pulls/comments";
    await this.requestJson(`/repos/${target.repo}/${family}/${target.id}`, { method: "PATCH", body: { body } });
  }

  private issueBodyTarget(repo: string, issue: IssueRow): RedactTarget[] {
    if (typeof issue.number !== "number" || typeof issue.body !== "string" || !issue.body) return [];
    const author = issue.user?.login;
    if (!author || !issue.html_url) return [];
    return [{ kind: "issue-body", repo, id: issue.number, url: issue.html_url, author, body: issue.body }];
  }

  private commentTarget(repo: string, kind: "issue-comment" | "review-comment", comment: CommentRow): RedactTarget[] {
    if (typeof comment.id !== "number" || typeof comment.body !== "string" || !comment.body) return [];
    const author = comment.user?.login;
    if (!author || !comment.html_url) return [];
    return [{ kind, repo, id: comment.id, url: comment.html_url, author, body: comment.body }];
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    let page = 1;
    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request(`${path}${separator}page=${page}`);
      const json = await response.json() as T[];
      rows.push(...json);
      if (!parseNextLink(response.headers.get("link"))) break;
      page += 1;
    }
    return rows;
  }

  private async requestJson<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.request(path, options);
    return await response.json() as T;
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (response.status !== 403 || attempt === 5) {
        if (!response.ok) throw new Error(`GitHub API ${options.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
        return response;
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      await delay(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path} failed after retries`);
  }
}

interface IssueRow {
  number?: number;
  html_url?: string;
  body?: string | null;
  user?: { login?: string };
}

interface CommentRow {
  id?: number;
  html_url?: string;
  body?: string | null;
  user?: { login?: string };
}

function renderHumanReport(report: RepoReport, stdout: NodeJS.WritableStream): void {
  stdout.write(`redact-sweep (${report.mode}) ${report.repo}: ${report.editable.length} editable hit(s), ${report.skipped.length} skipped\n`);
  for (const plan of report.editable) {
    stdout.write(`  ${plan.target.url}\n`);
    stdout.write(`    classes=[${plan.classes.join(", ")}]\n`);
    stdout.write(`    preview=${plan.preview}\n`);
  }
  for (const skipped of report.skipped) {
    stdout.write(`  skipped ${skipped.target.url}\n`);
    stdout.write(`    author=${skipped.target.author} reason=${skipped.reason} classes=[${skipped.classes.join(", ")}]\n`);
  }
  if (report.mode === "dry-run") stdout.write("redact-sweep (dry-run): no changes written.\n");
}

export async function redactSweepCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  ghOverride?: RedactSweepGitHub,
): Promise<number> {
  const options = parseOptions(args);
  const gh = ghOverride ?? new RestRedactSweepGitHub(await tokenFromEnvironmentOrGh(cwd));
  const authenticatedLogin = await gh.viewerLogin();
  const config: RedactSweepConfig = { hostPatterns: options.hostPatterns };
  const reports: RepoReport[] = [];

  for (const repo of options.repos) {
    const targets = await gh.listTargets(repo);
    const scan = scanRedactTargets(targets, authenticatedLogin, config);
    const edited: string[] = [];
    if (options.apply) {
      for (const plan of scan.editable) {
        await gh.updateTarget(plan.target, plan.redactedBody);
        edited.push(plan.target.url);
      }
    }
    reports.push({ repo, mode: options.apply ? "apply" : "dry-run", editable: scan.editable, skipped: scan.skipped, edited });
  }

  if (options.json) {
    stdout.write(`${JSON.stringify({ authenticatedLogin, reports }, null, 2)}\n`);
    return 0;
  }
  for (const report of reports) renderHumanReport(report, stdout);
  return 0;
}
