import type { ExecOutput } from "../exec.js";
import {
  LABEL_HUMAN,
  LABEL_READY,
} from "../../core/triage-labels.js";
import type { IssueCandidate, SelectionFilter } from "../../core/session.js";
import type { HitlCandidate } from "../../core/hitl-selection.js";
import type {
  QueueVisibilityTransportFailure,
  QueueVisibilityTransportSurface,
} from "../../core/operational-probes.js";
import { githubReadClient, githubRepo, isRecord, runRsp, type GhContext } from "./common.js";
import { readSingleObject } from "./single-object.js";

interface RspIssueListItem {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
}

interface GithubIssueListItem {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string | null;
  readonly state?: string;
  readonly created_at?: string | null;
  readonly closed_at?: string | null;
  readonly labels?: ReadonlyArray<string | { readonly name?: string }>;
  readonly user?: { readonly login?: string } | null;
  readonly pull_request?: unknown;
}

async function listIssuesViaClient(
  ctx: GhContext,
  cacheKey: string,
  parameters: Readonly<Record<string, unknown>>,
  limit: number,
): Promise<readonly GithubIssueListItem[]> {
  const repo = githubRepo(ctx);
  if (!repo) throw new Error("GitHub candidate listing needs an owner/repository slug");
  const answer = await githubReadClient(ctx).conditionalPaginate<GithubIssueListItem>({
    cacheKey: `gh:candidates:${repo.owner}/${repo.repo}:${cacheKey}`,
    route: "GET /repos/{owner}/{repo}/issues",
    parameters: { ...repo, per_page: 100, ...parameters },
    operation: { key: "issue list", budget: "rest" },
    actor: "dev:candidates",
  });
  return answer.data.filter((issue) => issue.pull_request == null).slice(0, limit);
}

function labelNames(labels: GithubIssueListItem["labels"]): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => typeof label === "string" ? label : String(label.name ?? ""));
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

async function listIssuesViaRsp(ctx: GhContext, label: string, limit: string): Promise<RspIssueListItem[] | null> {
  const r = await runRsp(ctx, [
    "gh-api-json",
    "repos/{owner}/{repo}/issues",
    "-f",
    "state=open",
    "-f",
    `labels=${label}`,
    "-f",
    `per_page=${limit}`,
  ]);
  if (r.code !== 0) return null;
  try {
    const raw = JSON.parse(r.stdout || "[]") as unknown;
    if (!Array.isArray(raw)) return null;
    return raw.filter((row) => isRecord(row) && !isRecord(row.pull_request)).map((row) => ({
      number: Number(row.number ?? 0),
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      labels: Array.isArray(row.labels)
        ? row.labels.map((item: unknown) => isRecord(item) ? String(item.name ?? "") : "").filter(Boolean)
        : [],
      author: isRecord(row.user) ? String(row.user.login ?? "") : "",
    }));
  } catch {
    return null;
  }
}

export interface CandidateListDiagnostics {
  onTransportFailure?(failure: QueueVisibilityTransportFailure): void;
}

function emitTransportFailure(
  diagnostics: CandidateListDiagnostics | undefined,
  surface: QueueVisibilityTransportSurface,
  r: ExecOutput,
  message: string,
): void {
  diagnostics?.onTransportFailure?.({
    surface,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    message,
  });
}

export async function listCandidates(
  ctx: GhContext,
  label: string = LABEL_READY,
  diagnostics?: CandidateListDiagnostics,
): Promise<IssueCandidate[]> {
  const cached = await listIssuesViaRsp(ctx, label, "200");
  if (cached) return cached.map((item): IssueCandidate => ({
    number: item.number,
    title: item.title,
    body: item.body,
    labels: item.labels,
    author: item.author || undefined,
  }));
  let raw: readonly GithubIssueListItem[];
  try {
    raw = await listIssuesViaClient(ctx, `open:${label}:dispatch`, { state: "open", labels: label }, 200);
  } catch (error) {
    emitTransportFailure(diagnostics, "rest", githubFailure(error), "GitHub issue list failed");
    return [];
  }
  return raw.map((row): IssueCandidate => {
    const author = row.user?.login ? String(row.user.login) : undefined;
    return {
      number: Number(row.number ?? 0),
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      labels: labelNames(row.labels),
      author,
    };
  });
}

/**
 * Resolve the candidate pool for one Worker dispatch.
 *
 * Explicit issue targets are point reads, not queue searches: `/go` has just
 * minted its target and GitHub's label-search index may not contain it yet.
 * The point read still enforces the queue contract the label listing supplied
 * implicitly — the Ticket must be open and carry the consulted lane label — so
 * a targeted fleet Worker cannot reach into `lane:go`, and a stale/absent
 * target remains missing for the existing selection refusal to explain.
 */
export async function resolveDispatchCandidates(
  ctx: GhContext,
  filter: SelectionFilter,
  consultedQueue: string = LABEL_READY,
): Promise<IssueCandidate[]> {
  if (filter.kind !== "issues") return listCandidates(ctx, consultedQueue);

  const rows = await Promise.all(
    filter.numbers.map(async (issue): Promise<IssueCandidate | null> => {
      const read = await readSingleObject(ctx, "issue", issue, [
        "number",
        "title",
        "body",
        "state",
        "labels",
      ]);
      if (read.row === null) return null;
      const number = Number(read.row.number ?? 0);
      const state = String(read.row.state ?? "").toUpperCase();
      const labels = Array.isArray(read.row.labels)
        ? read.row.labels
            .map((label) => (isRecord(label) ? String(label.name ?? "") : ""))
            .filter(Boolean)
        : [];
      if (number !== issue || state !== "OPEN" || !labels.includes(consultedQueue)) {
        return null;
      }
      return {
        number,
        title: String(read.row.title ?? ""),
        body: String(read.row.body ?? ""),
        labels,
      };
    }),
  );
  return rows.filter((row): row is IssueCandidate => row !== null);
}

/** List the ready-for-human candidate pool projected to HitlCandidate[].
 * Routing (selectHitlQueue) uses only labels/number/createdAt — body is not
 * fetched here; callers that need it use viewIssueFull for the selected issue. */
export async function listHitlCandidates(ctx: GhContext): Promise<HitlCandidate[]> {
  try {
    const rows = await listIssuesViaClient(
      ctx,
      `open:${LABEL_HUMAN}:hitl`,
      { state: "open", labels: LABEL_HUMAN },
      200,
    );
    return rows.map((row): HitlCandidate => ({
      number: Number(row.number ?? 0),
      title: String(row.title ?? ""),
      createdAt: row.created_at ?? null,
      labels: labelNames(row.labels),
    }));
  } catch {
    return [];
  }
}

/** A single issue's batched state slice: open/closed state, its label-name
 * list, and the ISO-8601 closedAt (null/"" when open). Backs every per-issue
 * boot lookup (orphan state, blocker state, branch issue-meta) from ONE list. */
export interface IssueStateRow {
  state: string;
  labels: string[];
  closedAt: string | null;
}

/**
 * Batched issue-state fetch: ONE `gh issue list --state all --json
 * number,state,labels,closedAt --limit 500` projected to a `number → row` map.
 *
 * This collapses the boot sweeps' per-issue `gh issue view` storms into a
 * single call. gh's default `--limit` is 30, so we pass an explicit 500 (covers
 * the repo with margin; an issue beyond 500 simply misses the map and the
 * caller falls back to a live lookup). Mirrors {@link listCandidates}'s shape
 * and error handling: a failed probe / unparseable body yields an empty map and
 * every lookup degrades to its live fallback.
 */
export async function listIssueStates(ctx: GhContext): Promise<Map<number, IssueStateRow>> {
  const map = new Map<number, IssueStateRow>();
  try {
    const rows = await listIssuesViaClient(ctx, "all:states", { state: "all" }, 500);
    for (const row of rows) {
      const n = Number(row.number ?? 0);
      if (!n) continue;
      map.set(n, {
        state: String(row.state ?? "open").toUpperCase(),
        labels: labelNames(row.labels),
        closedAt: row.closed_at ?? null,
      });
    }
  } catch {
    return map;
  }
  return map;
}
