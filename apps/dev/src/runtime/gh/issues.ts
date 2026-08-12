import {
  LABEL_READY,
  LABEL_TYPE_SPEC,
} from "../../core/triage-labels.js";
import { laneIsolationRefusal } from "../../core/state-transition.js";
import type { SpecSubIssueCandidate } from "../../core/spec-subissue-reconciler.js";
import {
  boundedMap,
  buildAliasedRepositoryQuery,
  GITHUB_GRAPHQL_BATCH_SIZE,
  GITHUB_REST_CONCURRENCY,
  parseAliasedRepositoryResponse,
} from "@reddb-io/shared/github-batch.js";
import { planGithubWrite, type GithubClient } from "@reddb-io/github";
import { scrubOutbound } from "../outbound-redaction.js";
import { apiPath, githubReadClient, repoArgs, runGh, type GhContext } from "./common.js";
import { readSingleObject } from "./single-object.js";

async function runGithubWrite(ctx: GhContext, args: readonly string[]) {
  const planned = planGithubWrite(["gh", ...args]);
  return runGh(ctx, planned.args.slice(1));
}

function repoCoordinates(ctx: GhContext): { owner: string; repo: string } {
  const [owner, repo] = ctx.repo.split("/", 2);
  if (!owner || !repo) throw new Error("GitHub routed reads require an owner/repository slug");
  return { owner, repo };
}

async function conditionalPages<T>(
  ctx: GhContext,
  cacheKey: string,
  route: string,
  parameters: Readonly<Record<string, unknown>>,
  operationKey: string,
): Promise<readonly T[]> {
  const answer = await githubReadClient(ctx).conditionalPaginate<T>({
    cacheKey,
    route,
    parameters,
    operation: { key: operationKey, budget: "rest" },
    actor: "dev",
  });
  return answer.data;
}

function githubGraphqlClient(ctx: GhContext): Pick<GithubClient, "graphql"> {
  const client = (ctx.github ?? githubReadClient(ctx)) as Partial<GithubClient>;
  if (typeof client.graphql !== "function") {
    throw new Error("GitHub routed GraphQL reads require a full client");
  }
  return client as Pick<GithubClient, "graphql">;
}

async function readLabelsForEdit(
  ctx: GhContext,
  issue: number,
): Promise<{ ok: true; labels: string[] } | { ok: false }> {
  const read = await readSingleObject(ctx, "issue", issue, ["labels"]);
  if (read.out.code !== 0 || !read.row) return { ok: false };
  const parsed = (read.row ?? {}) as { labels?: Array<{ name?: string }> };
  return {
    ok: true,
    labels: Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l.name ?? "")) : [],
  };
}

export async function viewLabels(ctx: GhContext, issue: number): Promise<string[]> {
  const read = await readLabelsForEdit(ctx, issue);
  return read.ok ? read.labels : [];
}

/**
 * Every label name the tracker carries (`gh label list --json name`).
 *
 * Returns the failure rather than an empty list: "this repo has no labels" and
 * "the listing failed" are opposite answers, and a doctor that read a 403 as
 * "no labels installed" would report a repo clean precisely when it cannot see
 * it (#3013).
 */
export async function listLabelNames(
  ctx: GhContext,
): Promise<{ names: string[] } | { failure: string }> {
  try {
    const coordinates = repoCoordinates(ctx);
    const rows = await conditionalPages<{ name?: unknown }>(
      ctx,
      `dev:labels:${ctx.repo}`,
      "GET /repos/{owner}/{repo}/labels",
      coordinates,
      "label list",
    );
    return { names: rows.map((row) => String(row.name ?? "")).filter((name) => name !== "") };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `gh issue edit --remove-label … --add-label …`; returns false on failure.
 *
 * This is the LAST gate before the tracker, so it owns the lane-isolation
 * invariant for every write that never declared a lifecycle edge (#2894): a
 * promotion to `ready-for-agent` reads the issue's REAL labels and is refused
 * when the issue sits in an isolated lane. The pure-model guard in
 * Call sites commonly know only the labels they intend to shed, so this port
 * checks the tracker's real resulting labels before a promotion is written.
 *
 * The extra read costs one `gh` call and only on a promotion. A read that fails
 * returns no labels and the write proceeds: this is a backstop for the typed
 * edges, never their replacement.
 */
export async function editLabels(
  ctx: GhContext,
  issue: number,
  remove: string[],
  add: string[],
): Promise<boolean> {
  const current = await readLabelsForEdit(ctx, issue);
  if (add.includes(LABEL_READY)) {
    // Judge the RESULTING label set, so an edit that genuinely leaves the lane
    // (removing it in the same call) is not refused for a label it just shed.
    const next = [...(current.ok ? current.labels : []).filter((label) => !remove.includes(label)), ...add];
    const refusal = laneIsolationRefusal("direct label write", next);
    if (refusal !== null) {
      process.stderr.write(`refused: #${issue} ${refusal.message}\n`);
      return false;
    }
  }
  const args = ["issue", "edit", String(issue), ...repoArgs(ctx)];
  for (const label of remove) args.push("--remove-label", label);
  for (const label of add) args.push("--add-label", label);
  const plan = planGithubWrite(["gh", ...args], current.ok ? { currentIssueLabels: current.labels } : {});
  const r = await runGh(ctx, plan.args.slice(1));
  return r.code === 0;
}

/** `gh issue comment --body …` (best-effort). */
export async function comment(ctx: GhContext, issue: number, body: string): Promise<void> {
  await runGithubWrite(ctx, ["issue", "comment", String(issue), ...repoArgs(ctx), "--body", scrubOutbound(body)]);
}

/** Edit an existing issue comment by REST id. Returns false when gh refuses the
 * patch so callers can preserve idempotency instead of posting duplicates. */
export async function editComment(ctx: GhContext, commentId: number, body: string): Promise<boolean> {
  const r = await runGithubWrite(ctx, [
    "api",
    "-X",
    "PATCH",
    apiPath(ctx, `issues/comments/${commentId}`),
    "-f",
    `body=${scrubOutbound(body)}`,
  ]);
  return r.code === 0;
}

// ---------- atomic GitHub-native claim (ADR 0066) ----------
//
// The claim primitive needs the comment's server-assigned NUMERIC id (the
// cross-host total order), which `gh issue comment` / `gh issue view --json
// comments` do not expose. The REST API does, so these go through `gh api`.

/** Post a claim/concede marker comment and resolve its server-assigned numeric
 * id (the total order). Throws on a non-zero gh exit so a failed POST never reads
 * as a won claim. */
export async function postClaimComment(ctx: GhContext, issue: number, body: string): Promise<number> {
  const r = await runGithubWrite(ctx, [
    "api",
    "-X",
    "POST",
    apiPath(ctx, `issues/${issue}/comments`),
    "-f",
    `body=${scrubOutbound(body)}`,
    "--jq",
    ".id",
  ]);
  const id = Number((r.stdout ?? "").trim());
  if (r.code !== 0 || !Number.isFinite(id)) {
    throw new Error(`gh: failed to post claim comment on #${issue} (code ${r.code})`);
  }
  return id;
}

/** List an issue's comments as `{id, body, createdAt}` for the claim reconciler.
 * Paginated so a long-lived issue's full claim history is read. A non-zero exit
 * yields an empty list (the reconciler then sees only our just-posted claim). */
export async function listClaimComments(
  ctx: GhContext,
  issue: number,
): Promise<{ id: number; body: string; createdAt?: string }[]> {
  try {
    const coordinates = repoCoordinates(ctx);
    const rows = await conditionalPages<{ id?: number; body?: string; created_at?: string }>(
      ctx,
      `dev:issue-comments:${ctx.repo}:${issue}`,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { ...coordinates, issue_number: issue },
      "api rest",
    );
    return rows.flatMap((row) => typeof row.id === "number" && typeof row.body === "string"
      ? [{ id: row.id, body: row.body, ...(row.created_at ? { createdAt: row.created_at } : {}) }]
      : []);
  } catch {
    return [];
  }
}

/** `gh issue edit --body …`. */
export async function editBody(ctx: GhContext, issue: number, body: string): Promise<boolean> {
  const r = await runGithubWrite(ctx, ["issue", "edit", String(issue), ...repoArgs(ctx), "--body", scrubOutbound(body)]);
  return r.code === 0;
}

/** Create an issue and resolve its new number from the `…/issues/N` URL gh
 * prints on stdout. Throws on a non-zero gh exit or an unparseable URL so a
 * failed mint never reads as a created issue (`/go` would otherwise dispatch a
 * worker at issue 0). Each label is passed as its own `--label` so a value with
 * a comma is never split. */
export async function createIssue(
  ctx: GhContext,
  spec: { title: string; body: string; labels?: readonly string[] },
): Promise<number> {
  const labelArgs = (spec.labels ?? []).flatMap((l) => ["--label", l]);
  const r = await runGithubWrite(ctx, [
    "issue",
    "create",
    ...repoArgs(ctx),
    "--title",
    scrubOutbound(spec.title),
    "--body",
    scrubOutbound(spec.body),
    ...labelArgs,
  ]);
  const match = (r.stdout ?? "").match(/\/issues\/(\d+)\b/);
  const num = match ? Number(match[1]) : NaN;
  if (r.code !== 0 || !Number.isInteger(num) || num <= 0) {
    throw new Error(`gh: failed to create issue (code ${r.code}): ${(r.stdout || r.stderr || "").trim()}`);
  }
  return num;
}

/** Resolve a GitHub issue's REST database id. The sub-issues and dependency
 * endpoints require this numeric id, not the issue number. */
async function issueDatabaseId(ctx: GhContext, issue: number): Promise<number> {
  const read = await readSingleObject(ctx, "issue", issue, ["databaseId"]);
  const id = Number(read.row?.databaseId ?? 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`gh: failed to resolve issue database id for #${issue} (code ${read.out.code})`);
  }
  return id;
}

/** Create a native GitHub sub-issue relationship from parent Spec to child
 * Ticket. Idempotence is provided by callers/sweeps comparing existing edges;
 * a failed POST throws so the caller can leave the pair for the next sweep. */
export async function attachSubIssue(ctx: GhContext, parent: number, child: number): Promise<void> {
  const childId = await issueDatabaseId(ctx, child);
  const r = await runGithubWrite(ctx, [
    "api",
    "-X",
    "POST",
    apiPath(ctx, `issues/${parent}/sub_issues`),
    // `-F` (not `-f`): sub_issue_id is a JSON integer field, and `-f` would send
    // it as a string, which the sub-issues endpoint rejects with HTTP 422.
    "-F",
    `sub_issue_id=${childId}`,
  ]);
  if (r.code !== 0) {
    throw new Error(`gh: failed to attach #${child} as a sub-issue of #${parent} (code ${r.code})`);
  }
}

function parseIssueRows(value: unknown): Array<{
  number?: number;
  state?: string;
  closedAt?: string | null;
  labels?: Array<{ name?: string }>;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
    .filter((row) => !("pull_request" in row))
    .map((row) => ({
      number: Number(row.number ?? 0),
      state: String(row.state ?? ""),
      closedAt: typeof row.closedAt === "string" || row.closedAt === null
        ? row.closedAt
        : typeof row.closed_at === "string" || row.closed_at === null ? row.closed_at : undefined,
      labels: Array.isArray(row.labels) ? row.labels as Array<{ name?: string }> : [],
    }));
}

function isRecentSpecRow(row: { state?: string; closedAt?: string | null }, nowS: number, recentDays: number): boolean {
  if (String(row.state ?? "").toUpperCase() !== "CLOSED") return true;
  if (!row.closedAt) return false;
  const closedS = Math.floor(Date.parse(row.closedAt) / 1000);
  if (!Number.isFinite(closedS)) return false;
  return nowS - closedS <= recentDays * 86400;
}

async function listSpecLabelChildren(ctx: GhContext, spec: number): Promise<number[]> {
  try {
    const coordinates = repoCoordinates(ctx);
    const rows = await conditionalPages<Record<string, unknown>>(
      ctx,
      `dev:spec-label-children:${ctx.repo}:${spec}`,
      "GET /repos/{owner}/{repo}/issues",
      { ...coordinates, labels: `spec:${spec}`, state: "all" },
      "issue list",
    );
    return parseIssueRows(rows).map((row) => Number(row.number ?? 0)).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function listNativeSubIssues(ctx: GhContext, spec: number): Promise<number[]> {
  const coordinates = repoCoordinates(ctx);
  const rows = await conditionalPages<{ number?: unknown }>(
    ctx,
    `dev:native-sub-issues:${ctx.repo}:${spec}`,
    "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
    { ...coordinates, issue_number: spec },
    "api rest",
  );
  return rows.map((row) => Number(row.number ?? 0)).filter((number) => Number.isInteger(number) && number > 0);
}

async function listNativeSubIssuesBatch(ctx: GhContext, specs: readonly number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const [owner, repo] = ctx.repo.split("/", 2);
  if (!owner || !repo) {
    const rows = await boundedMap(specs, GITHUB_REST_CONCURRENCY, async (spec) => [spec, await listNativeSubIssues(ctx, spec)] as const);
    return new Map(rows);
  }
  for (let start = 0; start < specs.length; start += GITHUB_GRAPHQL_BATCH_SIZE) {
    const chunk = specs.slice(start, start + GITHUB_GRAPHQL_BATCH_SIZE);
    const operation = buildAliasedRepositoryQuery("issue", chunk, ["subIssues"]);
    let payload: unknown;
    try {
      const data = await githubGraphqlClient(ctx).graphql<unknown>(operation.query, { owner, repo }, {
        operation: { key: "api graphql", budget: "graphql" },
        actor: "dev",
      });
      payload = { data };
    } catch {
      const fallback = await boundedMap(chunk, GITHUB_REST_CONCURRENCY, async (spec) => [spec, await listNativeSubIssues(ctx, spec)] as const);
      for (const [spec, children] of fallback) out.set(spec, children);
      continue;
    }
    const fallbackSpecs: number[] = [];
    for (const row of parseAliasedRepositoryResponse(operation, payload)) {
      const nodes = (row.value?.subIssues as { nodes?: Array<{ number?: unknown }> } | undefined)?.nodes;
      if (row.error || !Array.isArray(nodes)) {
        fallbackSpecs.push(row.number);
        continue;
      }
      const children = nodes.map((node) => Number(node.number ?? 0)).filter((number) => Number.isInteger(number) && number > 0);
      out.set(row.number, children);
    }
    const fallback = await boundedMap(fallbackSpecs, GITHUB_REST_CONCURRENCY, async (spec) => [spec, await listNativeSubIssues(ctx, spec)] as const);
    for (const [spec, children] of fallback) {
      out.set(spec, children);
    }
  }
  return out;
}

/** One open Ticket's two dependency surfaces, as the pure ADR 0094 audit eats them. */
export interface DependencyEdgeTicketRow {
  readonly number: number;
  readonly labels: string[];
  readonly nativeBlockedBy: number[];
}

export interface DependencyEdgeTicketScan {
  readonly tickets: DependencyEdgeTicketRow[];
  /**
   * Tickets whose native blocked-by edges were NOT read, because the per-Ticket
   * REST budget ran out. Reported rather than dropped: a comparison that
   * silently skipped half the queue reads as a clean repo (no silent caps).
   */
  readonly unread: number[];
}

/**
 * The per-Ticket REST call budget for one dependency-edge scan. The blocked_by
 * endpoint has no list form, so the read is one GET per open Ticket; the budget
 * keeps a doctor run bounded on a large backlog and the overflow is REPORTED.
 */
export const DEPENDENCY_EDGE_REST_BUDGET = 150;

async function listNativeBlockedBy(ctx: GhContext, ticket: number): Promise<number[]> {
  const coordinates = repoCoordinates(ctx);
  const rows = await conditionalPages<{ number?: unknown }>(
    ctx,
    `dev:native-blocked-by:${ctx.repo}:${ticket}`,
    "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
    { ...coordinates, issue_number: ticket },
    "api rest",
  );
  return rows.map((row) => Number(row.number ?? 0)).filter((number) => Number.isInteger(number) && number > 0);
}

/**
 * Read both ADR 0094 dependency surfaces for every open non-Spec Ticket: the
 * `req:N` labels from one issue-list call, and the native blocked-by edges from
 * the per-Ticket dependencies endpoint. Read-only GETs only — this never
 * creates, deletes, or edits an edge or a label.
 *
 * Parent Specs are excluded here rather than in the pure audit so the expensive
 * per-Ticket read is never spent on an issue the audit would skip anyway.
 */
export async function listDependencyEdgeTickets(
  ctx: GhContext,
  restBudget = DEPENDENCY_EDGE_REST_BUDGET,
): Promise<DependencyEdgeTicketScan> {
  let rows: readonly Record<string, unknown>[];
  try {
    const coordinates = repoCoordinates(ctx);
    rows = await conditionalPages<Record<string, unknown>>(
      ctx,
      `dev:dependency-tickets:${ctx.repo}`,
      "GET /repos/{owner}/{repo}/issues",
      { ...coordinates, state: "open" },
      "issue list",
    );
  } catch {
    return { tickets: [], unread: [] };
  }

  const open = parseIssueRows(rows)
    .map((row) => ({
      number: Number(row.number ?? 0),
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")) : [],
    }))
    .filter((row) => Number.isInteger(row.number) && row.number > 0)
    .filter((row) => !row.labels.includes(LABEL_TYPE_SPEC))
    .sort((a, b) => a.number - b.number);

  const budgeted = open.slice(0, Math.max(0, restBudget));
  const unread = open.slice(budgeted.length).map((row) => row.number);
  const native = await boundedMap(budgeted, GITHUB_REST_CONCURRENCY, async (row) => {
    try {
      return await listNativeBlockedBy(ctx, row.number);
    } catch {
      // A single unreadable Ticket must not fail the whole scan; it is reported
      // as unread so the doctor never presents a partial compare as complete.
      return null;
    }
  });

  const tickets: DependencyEdgeTicketRow[] = [];
  budgeted.forEach((row, index) => {
    const blockedBy = native[index];
    if (blockedBy === null || blockedBy === undefined) {
      unread.push(row.number);
      return;
    }
    tickets.push({ number: row.number, labels: row.labels, nativeBlockedBy: blockedBy });
  });
  unread.sort((a, b) => a - b);
  return { tickets, unread };
}

/** List Specs for the sub-issue reconciler: open Specs plus recently closed
 * Specs, with both surfaces injected into the pure reconciler. */
export async function listSpecSubIssueCandidates(
  ctx: GhContext,
  nowS = Math.floor(Date.now() / 1000),
  recentDays = 30,
): Promise<SpecSubIssueCandidate[]> {
  let rows: readonly Record<string, unknown>[];
  try {
    const coordinates = repoCoordinates(ctx);
    rows = await conditionalPages<Record<string, unknown>>(
      ctx,
      `dev:spec-candidates:${ctx.repo}`,
      "GET /repos/{owner}/{repo}/issues",
      { ...coordinates, labels: LABEL_TYPE_SPEC, state: "all" },
      "issue list",
    );
  } catch {
    return [];
  }

  const specs = parseIssueRows(rows)
    .filter((row) => isRecentSpecRow(row, nowS, recentDays))
    .map((row) => ({
      number: Number(row.number ?? 0),
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")) : [],
    }))
    .filter((row) => Number.isInteger(row.number) && row.number > 0);

  const [labelChildren, nativeSubIssues] = await Promise.all([
    Promise.all(specs.map((spec) => listSpecLabelChildren(ctx, spec.number))),
    listNativeSubIssuesBatch(ctx, specs.map((spec) => spec.number)),
  ]);
  return specs.map((spec, index) => {
    return {
      number: spec.number,
      labels: spec.labels,
      labelChildren: labelChildren[index] ?? [],
      nativeSubIssues: nativeSubIssues.get(spec.number) ?? [],
    };
  });
}

/** Idempotently create the `runner-error` label (best-effort). Mirrors
 * supervisor.sh ensure_runner_error_label — a label that already exists exits
 * non-zero and is swallowed. */
export async function ensureRunnerErrorLabel(ctx: GhContext): Promise<void> {
  await runGithubWrite(ctx,
    [
      "label",
      "create",
      "runner-error",
      ...repoArgs(ctx),
      "--color",
      "B60205",
      "--description",
      "AFK supervisor circuit-tripped; runner was misconfigured",
    ],
  );
}

/** Idempotently create an arbitrary label (best-effort), generalising
 * ensureRunnerErrorLabel for the typed `blocked:<reason>` observability layer. A
 * label that already exists exits non-zero and is swallowed by the caller.
 * `presentation` overrides the blocked-reason colour/description for callers
 * installing a different family (e.g. ticket TYPE labels). */
export async function ensureLabel(
  ctx: GhContext,
  name: string,
  presentation: { color?: string; description?: string } = {},
): Promise<void> {
  await runGithubWrite(ctx,
    [
      "label",
      "create",
      name,
      ...repoArgs(ctx),
      "--color",
      presentation.color ?? "5319E7",
      "--description",
      presentation.description ?? "AFK terminal-failure reason (observability)",
    ],
  );
}

/** `gh issue close --reason completed`. */
export async function closeIssue(ctx: GhContext, issue: number): Promise<void> {
  await runGithubWrite(ctx, ["issue", "close", String(issue), ...repoArgs(ctx), "--reason", "completed"]);
}

/** Full metadata for a single issue (`gh issue view --json number,title,body,labels`).
 * Returns null on a 404 or transient gh failure. */
export async function viewIssueFull(
  ctx: GhContext,
  issue: number,
): Promise<{ number: number; title: string; body: string; labels: string[] } | null> {
  const read = await readSingleObject(ctx, "issue", issue, ["number", "title", "body", "labels"]);
  if (!read.row) return null;
  const parsed = read.row as {
    number?: number;
    title?: string;
    body?: string;
    labels?: Array<{ name?: string }>;
  };
  return {
    number: Number(parsed.number ?? issue),
    title: String(parsed.title ?? ""),
    body: String(parsed.body ?? ""),
    labels: Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l.name ?? "")) : [],
  };
}

export type IssueBodyReadResult =
  | { ok: true; body: string }
  | { ok: false; reason: string };

/** `gh issue view --json body` → raw body. Distinguishes an empty body from a
 * failed/unparseable read so readiness lint never mutates on unknown content. */
export async function readIssueBody(ctx: GhContext, issue: number): Promise<IssueBodyReadResult> {
  const read = await readSingleObject(ctx, "issue", issue, ["body"]);
  if (read.out.code !== 0) return { ok: false, reason: `failed to read issue body (gh exit ${read.out.code})` };
  if (!read.row) return { ok: false, reason: "failed to parse issue body JSON" };
  return { ok: true, body: String((read.row as { body?: string }).body ?? "") };
}

/** `gh issue view --json body` → raw body, or undefined when absent/unreadable.
 * Compatibility wrapper for callers that deliberately degrade to best effort. */
export async function issueBody(ctx: GhContext, issue: number): Promise<string | undefined> {
  const result = await readIssueBody(ctx, issue);
  return result.ok ? result.body : undefined;
}

/** `gh issue view --json url` → the resolved issue url. */
export async function issueUrl(ctx: GhContext, issue: number): Promise<string> {
  const read = await readSingleObject(ctx, "issue", issue, ["url"]);
  return String(((read.row ?? {}) as { url?: string }).url ?? "");
}

/** `gh issue view --json number,title,url` for human-facing issue references. */
export async function issueReference(
  ctx: GhContext,
  issue: number,
): Promise<{ number: number; title?: string; url?: string } | undefined> {
  const read = await readSingleObject(ctx, "issue", issue, ["number", "title", "url"]);
  if (!read.row) return undefined;
  const parsed = read.row as { number?: number; title?: string; url?: string };
  return {
    number: Number(parsed.number ?? issue),
    title: String(parsed.title ?? ""),
    url: String(parsed.url ?? ""),
  };
}
