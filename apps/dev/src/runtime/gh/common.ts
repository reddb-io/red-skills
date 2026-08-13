import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  createGithubAttributionLedger,
  createGithubClient,
  createGithubInstallationLookup,
  githubCoveragePath,
  openGithubCoverageCache,
  planGithubRestRead,
  readGithubAppCredentialFromEnv,
  type GithubAppCredential,
  type GithubClient,
  type GithubConditionalRestRequest,
} from "@reddb-io/github";
import { homedir } from "node:os";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { stateDir } from "@reddb-io/shared/red-paths.js";
import { execTool, type ExecOptions, type ExecFn, type ExecOutput } from "../exec.js";
import { resolveGhQuotaBackoff, withGhQuotaBackoff, type GhQuotaBackoffOpts } from "./quota.js";

export type { GhQuotaBackoffOpts };

export interface GhContext {
  /** owner/repo slug for `gh ... --repo`. */
  repo: string;
  /** Working dir gh runs from (the primary checkout). */
  cwd: string;
  /**
   * Optional injected exec boundary. Unset in production (the real `execTool`
   * via the `gh` helper runs). Set in tests to a recording fake so the REAL gh
   * closure assembly can be driven without touching the OS. See exec.ts::ExecFn.
   */
  exec?: ExecFn;
  /** Shared routed GitHub reads; tests inject this instead of opening a socket. */
  github?: Pick<GithubClient, "conditionalRest" | "conditionalPaginate">;
  /**
   * Overrides the quota-backoff options this context's gh calls run with.
   * ABSENT MEANS DEFAULT, NOT DISABLED (issue #2800): rate-limit responses
   * (REST 403/429, GraphQL RATE_LIMITED) always trigger a bounded wait-and-retry
   * unless a call site opts out. onWait emits 'quota-wait' activity so the wait
   * is visible rather than reading as silence. After the cap, the failing
   * response is returned so the caller can park with an explicit quota reason.
   */
  quotaBackoff?: GhQuotaBackoffOpts;
}

export interface GithubRepoCoordinates {
  readonly owner: string;
  readonly repo: string;
}

const routedClients = new WeakMap<GhContext, Pick<GithubClient, "conditionalRest" | "conditionalPaginate">>();

function injectedReadClient(ctx: GhContext): Pick<GithubClient, "conditionalRest" | "conditionalPaginate"> {
  const issueArgs = (number: unknown) => [
    "issue", "view", String(number ?? ""), ...repoArgs(ctx), "--json", "number,state,labels",
  ];
  const request = async (route: string, parameters: Readonly<Record<string, unknown>> = {}) => {
    let args: string[];
    if (route === "GET /search/issues") {
      args = [
        "issue", "list", ...repoArgs(ctx), "--search", String(parameters.q ?? ""),
        "--state", "all", "--limit", "10", "--json", "number,title,body,labels",
      ];
    } else if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      const accept = (parameters.headers as { accept?: string } | undefined)?.accept ?? "";
      args = accept.includes("diff")
        ? ["pr", "diff", String(parameters.pull_number ?? ""), ...repoArgs(ctx)]
        : ["pr", "view", String(parameters.pull_number ?? ""), ...repoArgs(ctx), "--json", "title,body,author,authorAssociation"];
    } else if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
      // The REST argv, so a fixture answering `readsIssue` serves the whole
      // body — user/author_association included, which the flattened
      // `--json number,state,labels` spelling silently dropped (#3729).
      args = ["api", `repos/${String(parameters.owner)}/${String(parameters.repo)}/issues/${String(parameters.issue_number ?? "")}`];
    } else if (route === "GET /repos/{owner}/{repo}") {
      // The repo-visibility read (#1101 rides REST too): a bare `gh api
      // repos/{owner}/{repo}` — the repo object already carries `visibility`
      // at the top level, so no projection is needed.
      args = ["api", `repos/${String(parameters.owner)}/${String(parameters.repo)}`];
    } else {
      args = issueArgs(parameters.issue_number);
    }
    const out = await ctx.exec!("gh", args, { cwd: ctx.cwd });
    if (out.code !== 0) throw new Error(out.stderr || out.stdout);
    if ((parameters.headers as { accept?: string } | undefined)?.accept?.includes("diff")) return out.stdout;
    const parsed = JSON.parse(out.stdout || (route === "GET /search/issues" ? "[]" : "{}")) as Record<string, unknown> | unknown[];
    if (route === "GET /search/issues") return { items: parsed };
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}" && !Array.isArray(parsed)) {
      const author = parsed.author as { login?: string; is_bot?: boolean } | undefined;
      return {
        ...parsed,
        user: author ? { login: author.login, type: author.is_bot ? "Bot" : "User" } : undefined,
        author_association: parsed.authorAssociation,
      };
    }
    return parsed;
  };
  return {
    async conditionalRest<T>(input: GithubConditionalRestRequest) {
      return { data: await request(input.route, input.parameters) as T, headers: {}, quotaFree: false };
    },
    async conditionalPaginate<T>(input: GithubConditionalRestRequest) {
      if (input.route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        // The routed comments read (#3730): a plain `gh api --paginate`, raw
        // REST comment rows (`user.login`, not the `author` projection) —
        // consumers of THIS route (externalApprovalActors) read the REST
        // shape directly, unlike `issueComments`' hand-projected jq pipeline.
        const owner = String(input.parameters?.owner ?? "");
        const repo = String(input.parameters?.repo ?? "");
        const issue = String(input.parameters?.issue_number ?? "");
        const args = ["api", "--paginate", `repos/${owner}/${repo}/issues/${issue}/comments`];
        const out = await ctx.exec!("gh", args, { cwd: ctx.cwd });
        if (out.code !== 0) throw new Error(out.stderr || out.stdout);
        const parsed = JSON.parse(out.stdout || "[]") as unknown;
        const data = Array.isArray(parsed) ? (parsed as T[]) : [];
        return { data, headers: {}, quotaFree: false, requestCount: 1 };
      }
      if (input.route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline") {
        // The routed timeline read (#3730), backing the lane-aware promoter
        // resolution: raw REST timeline events (`labeled`, `actor.login`,
        // `label.name`) — the caller walks them for the most recent applier.
        const owner = String(input.parameters?.owner ?? "");
        const repo = String(input.parameters?.repo ?? "");
        const issue = String(input.parameters?.issue_number ?? "");
        const args = ["api", "--paginate", `repos/${owner}/${repo}/issues/${issue}/timeline`];
        const out = await ctx.exec!("gh", args, { cwd: ctx.cwd });
        if (out.code !== 0) throw new Error(out.stderr || out.stdout);
        const parsed = JSON.parse(out.stdout || "[]") as unknown;
        const data = Array.isArray(parsed) ? (parsed as T[]) : [];
        return { data, headers: {}, quotaFree: false, requestCount: 1 };
      }
      if (input.route === "GET /repos/{owner}/{repo}/issues") {
        // The routed issue-list read (#3730): a plain `gh api --paginate` over
        // the issues collection, carrying whatever query the caller asked for
        // (state/labels/per_page) — the full REST row objects come back so
        // every consumer (candidates, queue counts, boot-sweep state) projects
        // the fields it needs, same as the single-object routes above.
        const owner = String(input.parameters?.owner ?? "");
        const repo = String(input.parameters?.repo ?? "");
        const query: string[] = [];
        if (input.parameters?.state !== undefined) query.push("-f", `state=${String(input.parameters.state)}`);
        if (input.parameters?.labels !== undefined) query.push("-f", `labels=${String(input.parameters.labels)}`);
        query.push("-f", `per_page=${String(input.parameters?.per_page ?? 100)}`);
        const args = ["api", "--paginate", `repos/${owner}/${repo}/issues`, ...query];
        const out = await ctx.exec!("gh", args, { cwd: ctx.cwd });
        if (out.code !== 0) throw new Error(out.stderr || out.stdout);
        const parsed = JSON.parse(out.stdout || "[]") as unknown;
        const data = Array.isArray(parsed) ? (parsed as T[]) : [];
        return { data, headers: {}, quotaFree: false, requestCount: 1 };
      }
      const issue = String(input.parameters?.issue_number ?? "");
      const args = ["api", "--paginate", apiPath(ctx, `issues/${issue}/sub_issues`), "--jq", ".[] | {number}"];
      const out = await ctx.exec!("gh", args, { cwd: ctx.cwd });
      if (out.code !== 0) throw new Error(out.stderr || out.stdout);
      const data = out.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
      return { data, headers: {}, quotaFree: false, requestCount: 1 };
    },
  };
}

function trackerToken(): string {
  const env = (
    process.env.REDSKILLED_HOST_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    ""
  ).trim();
  if (env !== "") return env;
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

/** Resolve the owner/repository pair required by Octokit's typed REST routes. */
export function githubRepo(ctx: GhContext): GithubRepoCoordinates | null {
  const [owner, repo, ...extra] = ctx.repo.trim().split("/");
  return owner && repo && extra.length === 0 ? { owner, repo } : null;
}

/** One context-lifetime routed client, preserving conditional validators across polls. */
export function githubReadClient(
  ctx: GhContext,
): Pick<GithubClient, "conditionalRest" | "conditionalPaginate"> {
  if (ctx.github) return ctx.github;
  if (ctx.exec) return injectedReadClient(ctx);
  const held = routedClients.get(ctx);
  if (held) return held;
  const token = trackerToken();
  if (token === "") throw new Error("GitHub reads require an authenticated tracker credential");
  const app = coveringApp(ctx);
  const client = createGithubClient({
    token,
    ...(app === null ? {} : { app }),
    attribution: createGithubAttributionLedger({
      path: join(stateDir(ctx.cwd), "github", "spend.toonl"),
    }),
  });
  routedClients.set(ctx, client);
  return client;
}

/** Per-call quota policy. Omitted → the context default (backoff ON). */
export interface RunGhOpts {
  /**
   * `"off"` runs the invocation with NO wait-and-retry. Reserved for read-only
   * probes that classify a rate limit as transient themselves and proceed —
   * blocking those for up to the cap turns a survivable blip into a stall.
   */
  quota?: "default" | "off";
}

function opts(ctx: GhContext): ExecOptions {
  return { cwd: ctx.cwd };
}

/**
 * Dispatch a `gh <args>` invocation through the injected exec when present, else
 * the real `gh` helper. Rate-limit responses are retried with a bounded wait by
 * DEFAULT — `ctx.quotaBackoff` only tunes the options, and only an explicit
 * `{ quota: "off" }` disables the retry.
 */
export function runGh(
  ctx: GhContext,
  args: readonly string[],
  runOpts: RunGhOpts = {},
): Promise<ExecOutput> {
  const fn = () => (ctx.exec ?? execTool)("gh", args, opts(ctx));
  if (runOpts.quota === "off") return fn();
  return withGhQuotaBackoff(fn, resolveGhQuotaBackoff(ctx.quotaBackoff));
}

/** Issue one explicit read-only REST endpoint through the package-owned planner. */
export function runGithubRestRead(
  ctx: GhContext,
  path: string,
  args: readonly string[] = [],
  runOpts: RunGhOpts = {},
): Promise<ExecOutput> {
  const plan = planGithubRestRead({ kind: "rest", path, args });
  if (plan.outcome !== "plan") throw new Error(plan.reason);
  return runGh(ctx, plan.args, runOpts);
}

export function runRsp(ctx: GhContext, args: readonly string[]): Promise<ExecOutput> {
  return (ctx.exec ?? execTool)("rsp", args, opts(ctx));
}

export function repoArgs(ctx: GhContext): string[] {
  return ctx.repo ? ["--repo", ctx.repo] : [];
}

export function apiPath(ctx: GhContext, suffix: string): string {
  // ctx.repo is `owner/repo`; fall back to the cwd repo when unset (gh resolves).
  return ctx.repo ? `repos/${ctx.repo}/${suffix}` : suffix;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The App credential when it stands in THIS repository, else `null`.
 *
 * The daemon is host-global but an installation covers an account, so the
 * operator is routinely in a repository the App was never installed on. That
 * request must still go out, on the personal token — this is a router, not a
 * switch, and the person remains the floor.
 *
 * The decision is synchronous because the transport is built synchronously: a
 * remembered answer decides now, and an unknown repository is paid for by the
 * person while the answer is learned in the background for every process after
 * this one. Learning costs one request and is never allowed to fail a read.
 */
function coveringApp(ctx: GhContext): GithubAppCredential | null {
  let app: GithubAppCredential | null;
  try {
    app = readGithubAppCredentialFromEnv();
  } catch {
    return null; // a misdeclared App must not take the personal token down with it
  }
  if (app === null) return null;
  const repo = githubRepo(ctx);
  if (!repo) return null;

  const cachePath = githubCoveragePath(
    join(redskilledHomeDir(homedir()), "state"),
    app.installationId,
  );
  const cache = openGithubCoverageCache(cachePath);
  const remembered = cache.covered(repo.owner, repo.repo);
  if (remembered !== undefined) return remembered ? app : null;

  void createGithubInstallationLookup(app)(repo.owner, repo.repo)
    .then((covered) => { if (covered !== null) cache.remember(repo.owner, repo.repo, covered); })
    .catch(() => undefined);
  return null;
}
