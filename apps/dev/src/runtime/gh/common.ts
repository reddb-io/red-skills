import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  createGithubAttributionLedger,
  createGithubClient,
  planGithubRestRead,
  type GithubClient,
  type GithubConditionalRestRequest,
} from "@reddb-io/github";
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
  const client = createGithubClient({
    token,
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
