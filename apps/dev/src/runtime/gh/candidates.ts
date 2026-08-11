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
import { isRecord, repoArgs, runGh, runRsp, type GhContext } from "./common.js";
import { readSingleObject } from "./single-object.js";

const TARGET_POINT_READ_BACKOFF_MS = [250, 750, 1_500] as const;

async function readTargetIssue(
  ctx: GhContext,
  issue: number,
): Promise<Awaited<ReturnType<typeof readSingleObject>>> {
  for (const delayMs of TARGET_POINT_READ_BACKOFF_MS) {
    const read = await readSingleObject(ctx, "issue", issue, [
      "number",
      "title",
      "body",
      "state",
      "labels",
    ]);
    if (read.row !== null || !/\bHTTP 404\b/i.test(`${read.out.stdout}\n${read.out.stderr}`)) {
      return read;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  return readSingleObject(ctx, "issue", issue, [
    "number",
    "title",
    "body",
    "state",
    "labels",
  ]);
}

interface RspIssueListItem {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
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
  const r = await runGh(ctx,
    [
      "issue",
      "list",
      ...repoArgs(ctx),
      "--label",
      label,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,labels,body,author",
    ],
  );
  if (r.code !== 0) {
    emitTransportFailure(diagnostics, "graphql", r, "gh issue list failed");
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout || "[]");
  } catch {
    emitTransportFailure(diagnostics, "graphql", r, "gh issue list returned malformed JSON");
    return [];
  }
  if (!Array.isArray(raw)) {
    emitTransportFailure(diagnostics, "graphql", r, "gh issue list returned a non-array payload");
    return [];
  }
  return raw.map((row): IssueCandidate => {
    const item = row as {
      number?: number;
      title?: string;
      body?: string;
      labels?: Array<{ name?: string }>;
      author?: { login?: string } | null;
    };
    const author = item.author?.login ? String(item.author.login) : undefined;
    return {
      number: Number(item.number ?? 0),
      title: String(item.title ?? ""),
      body: String(item.body ?? ""),
      labels: Array.isArray(item.labels) ? item.labels.map((l) => String(l.name ?? "")) : [],
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
      const read = await readTargetIssue(ctx, issue);
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
  const r = await runGh(ctx,
    [
      "issue",
      "list",
      ...repoArgs(ctx),
      "--label",
      LABEL_HUMAN,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,labels,createdAt",
    ],
  );
  if (r.code !== 0) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((row): HitlCandidate => {
    const item = row as {
      number?: number;
      title?: string;
      createdAt?: string | null;
      labels?: Array<{ name?: string }>;
    };
    return {
      number: Number(item.number ?? 0),
      title: String(item.title ?? ""),
      createdAt: item.createdAt ?? null,
      labels: Array.isArray(item.labels) ? item.labels.map((l) => String(l.name ?? "")) : [],
    };
  });
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
  const r = await runGh(ctx,
    [
      "issue",
      "list",
      ...repoArgs(ctx),
      "--state",
      "all",
      "--limit",
      "500",
      "--json",
      "number,state,labels,closedAt",
    ],
  );
  if (r.code !== 0) return map;
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout || "[]");
  } catch {
    return map;
  }
  if (!Array.isArray(raw)) return map;
  for (const row of raw) {
    const item = row as {
      number?: number;
      state?: string;
      labels?: Array<{ name?: string }>;
      closedAt?: string | null;
    };
    const n = Number(item.number ?? 0);
    if (!n) continue;
    map.set(n, {
      state: String(item.state ?? "OPEN"),
      labels: Array.isArray(item.labels) ? item.labels.map((l) => String(l.name ?? "")) : [],
      closedAt: item.closedAt ?? null,
    });
  }
  return map;
}
