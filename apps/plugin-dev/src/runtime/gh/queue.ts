import {
  LABEL_HUMAN,
  LABEL_QUARANTINE,
  LABEL_READY,
} from "../../core/triage-labels.js";
import type {
  QueueVisibilityProbeInput,
  QueueVisibilityTransportFailure,
  QueueVisibilityTransportSurface,
} from "../../core/operational-probes.js";
import type { ExecOutput } from "../exec.js";
import { listCandidates } from "./candidates.js";
import { githubReadClient, githubRepo, isRecord, repoArgs, runRsp, type GhContext } from "./common.js";
import { readGhGraphql, readGhJsonRows } from "./read.js";

interface RestIssue {
  readonly number?: number;
  readonly labels?: readonly unknown[];
  readonly pull_request?: unknown;
}

async function listIssuesViaClient(
  ctx: GhContext,
  cacheKey: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<readonly RestIssue[]> {
  const repo = githubRepo(ctx);
  if (!repo) throw new Error("GitHub issue listing needs an owner/repository slug");
  const answer = await githubReadClient(ctx).conditionalPaginate<RestIssue>({
    cacheKey: `gh:issues:${repo.owner}/${repo.repo}:${cacheKey}`,
    route: "GET /repos/{owner}/{repo}/issues",
    parameters: { ...repo, per_page: 100, ...parameters },
    operation: { key: "issue list", budget: "rest" },
    actor: "dev:queue",
  });
  return answer.data.filter((issue) => issue.pull_request == null).slice(0, 500);
}

async function countIssues(ctx: GhContext, label?: string): Promise<number> {
  try {
    return (await listIssuesViaClient(ctx, `open:${label ?? "all"}`, {
      state: "open",
      ...(label ? { labels: label } : {}),
    })).length;
  } catch {
    return 0;
  }
}

export interface StatuslineQueueCounts {
  queue: number;
  human: number;
  quarantine: number;
}

function statuslineSearchQuery(repo: string, label: string): string {
  return `repo:${repo} is:issue is:open label:"${label}"`;
}

function queueVisibilityError(
  surface: QueueVisibilityTransportSurface,
  r: ExecOutput,
  message: string,
): Error & QueueVisibilityTransportFailure {
  return Object.assign(new Error(message), {
    surface,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

function githubFailure(error: unknown): ExecOutput {
  const value = typeof error === "object" && error !== null
    ? error as { status?: unknown; message?: unknown }
    : {};
  return {
    code: Number(value.status ?? 1),
    stdout: "",
    stderr: String(value.message ?? error ?? "GitHub request failed"),
  };
}

async function listOpenIssuesByLabelViaRest(ctx: GhContext, label: string): Promise<number[]> {
  if (!ctx.repo) return [];
  let rows: readonly RestIssue[];
  try {
    rows = await listIssuesViaClient(ctx, `queue:${label}`, { state: "open", labels: label });
  } catch (error) {
    throw queueVisibilityError("rest", githubFailure(error), "GitHub REST issue listing failed");
  }
  const issues = rows.map((row) => Number(row.number ?? 0));
  if (issues.some((issue) => !Number.isInteger(issue) || issue <= 0)) {
    throw queueVisibilityError(
      "rest",
      { code: 1, stdout: JSON.stringify(rows), stderr: "" },
      "GitHub REST issue listing returned a non-numeric issue number",
    );
  }
  return issues;
}

export function queueVisibilityProbeInput(ctx: GhContext, label: string = LABEL_READY): QueueVisibilityProbeInput {
  return {
    label,
    listEngineCandidates: async () => {
      const failures: QueueVisibilityTransportFailure[] = [];
      const candidates = await listCandidates(ctx, label, {
        onTransportFailure: (failure) => failures.push(failure),
      });
      if (failures.length > 0 && candidates.length === 0) {
        const failure = failures[failures.length - 1];
        throw Object.assign(new Error(failure.message ?? "AFK engine candidate listing failed"), {
          surface: failure.surface,
          code: failure.code,
          stdout: failure.stdout,
          stderr: failure.stderr,
        });
      }
      return candidates.map((candidate) => candidate.number);
    },
    listRestQueue: () => listOpenIssuesByLabelViaRest(ctx, label),
  };
}

async function countSearchViaRsp(ctx: GhContext, query: string): Promise<number | null> {
  const r = await runRsp(ctx, [
    "gh-api-json",
    "search/issues",
    "-f",
    `q=${query}`,
    "-f",
    "per_page=1",
  ]);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout || "{}") as unknown;
    if (!isRecord(parsed)) return null;
    return typeof parsed.total_count === "number" ? parsed.total_count : null;
  } catch {
    return null;
  }
}

/** Count both statusline queue buckets with one GraphQL search request.
 *
 * RAISES {@link GhReadError} when the GraphQL read could not run — including the
 * exit-0 response whose `data` block is null-filled and whose `errors` carry
 * `RATE_LIMITED`. Zeroes here would read as "the queue is empty", the falsehood
 * this repo treats as a flow bug to diagnose. */
export async function countStatuslineQueueCounts(ctx: GhContext): Promise<StatuslineQueueCounts> {
  if (!ctx.repo) return { queue: 0, human: 0, quarantine: 0 };
  const [queue, human, quarantine] = await Promise.all([
    countSearchViaRsp(ctx, statuslineSearchQuery(ctx.repo, LABEL_READY)),
    countSearchViaRsp(ctx, statuslineSearchQuery(ctx.repo, LABEL_HUMAN)),
    countSearchViaRsp(ctx, statuslineSearchQuery(ctx.repo, LABEL_QUARANTINE)),
  ]);
  if (queue != null && human != null && quarantine != null) return { queue, human, quarantine };
  const query = `
    query($ready: String!, $human: String!, $quarantine: String!) {
      ready: search(type: ISSUE, query: $ready) { issueCount }
      human: search(type: ISSUE, query: $human) { issueCount }
      quarantine: search(type: ISSUE, query: $quarantine) { issueCount }
    }
  `;
  const data = await readGhGraphql(ctx, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `ready=${statuslineSearchQuery(ctx.repo, LABEL_READY)}`,
    "-F",
    `human=${statuslineSearchQuery(ctx.repo, LABEL_HUMAN)}`,
    "-F",
    `quarantine=${statuslineSearchQuery(ctx.repo, LABEL_QUARANTINE)}`,
  ]);
  const bucket = (key: string): number => {
    const node = data[key];
    return isRecord(node) ? Number(node.issueCount ?? 0) : 0;
  };
  return { queue: bucket("ready"), human: bucket("human"), quarantine: bucket("quarantine") };
}

/** Count issues that carry NO labels (the unlabeled straggler bucket). */
export async function countUnlabeled(ctx: GhContext): Promise<number> {
  try {
    const rows = await listIssuesViaClient(ctx, "open:unlabeled", { state: "open" });
    return rows.filter((row) => !Array.isArray(row.labels) || row.labels.length === 0).length;
  } catch {
    return 0;
  }
}

/** Count open `ready-for-agent` issues (the 📋 statusline queue count). */
export function countReadyForAgent(ctx: GhContext): Promise<number> {
  return countIssues(ctx, LABEL_READY);
}

/** Count open `ready-for-human` issues (the 🆘 statusline count). */
export function countReadyForHuman(ctx: GhContext): Promise<number> {
  return countIssues(ctx, LABEL_HUMAN);
}

/** Count `needs-triage` straggler issues. */
export function countNeedsTriage(ctx: GhContext): Promise<number> {
  return countIssues(ctx, "needs-triage");
}

/** Count ALL open issues — the repo-global `is` statusline count (no label
 * filter). Capped at 500 like {@link countIssues}; a busier repo undercounts,
 * which is acceptable for a glanceable badge. */
export function countOpenIssues(ctx: GhContext): Promise<number> {
  return countIssues(ctx);
}

/** Count open pull requests — the repo-global `pr` statusline count.
 *
 * RAISES {@link GhReadError} when the query could not run, because 0 here reads
 * as "nothing is open" and that is the exact falsehood of #2801. Callers that
 * must stay fail-open (the statusline refresh) catch the raise and keep their
 * last known value; a genuinely empty repo still counts 0. */
export async function countOpenPrs(ctx: GhContext): Promise<number> {
  const rows = await readGhJsonRows<unknown>(ctx, [
    "pr",
    "list",
    ...repoArgs(ctx),
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number",
  ]);
  return rows.length;
}

/** Count pull requests created on the given local calendar day (YYYY-MM-DD).
 * Uses `--search created:<day>` as a server-side filter then re-filters by
 * local date in JS to absorb UTC/local-timezone boundary drift. RAISES
 * {@link GhReadError} on a query that could not run, for the same reason as
 * {@link countOpenPrs}. The `localDay` parameter defaults to today's local date
 * and is exposed for testing. */
export async function countPrsCreatedToday(
  ctx: GhContext,
  localDay = new Date().toLocaleDateString("en-CA"),
): Promise<number> {
  const rows = await readGhJsonRows<{ createdAt?: unknown }>(ctx, [
    "pr",
    "list",
    ...repoArgs(ctx),
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "createdAt",
    "--search",
    `created:${localDay}`,
  ]);
  return rows.filter(
    (pr) =>
      typeof pr.createdAt === "string" &&
      new Date(pr.createdAt).toLocaleDateString("en-CA") === localDay,
  ).length;
}

/** Count `needs-info` straggler issues. */
export function countNeedsInfo(ctx: GhContext): Promise<number> {
  return countIssues(ctx, "needs-info");
}
