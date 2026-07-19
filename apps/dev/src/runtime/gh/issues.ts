import {
  LABEL_TYPE_SPEC,
} from "../../core/triage-labels.js";
import type { SpecSubIssueCandidate } from "../../core/spec-subissue-reconciler.js";
import {
  MAIN_RED_REPAIR_TITLE,
  type MainRedRepairIssue,
} from "../../core/main-red-repair.js";
import { scrubOutbound } from "../outbound-redaction.js";
import { repoArgs, runGh, type GhContext } from "./common.js";

export async function viewLabels(ctx: GhContext, issue: number): Promise<string[]> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "labels"]);
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as { labels?: Array<{ name?: string }> };
    return Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l.name ?? "")) : [];
  } catch {
    return [];
  }
}

/** `gh issue edit --remove-label … --add-label …`; returns false on failure. */
export async function editLabels(
  ctx: GhContext,
  issue: number,
  remove: string[],
  add: string[],
): Promise<boolean> {
  const args = ["issue", "edit", String(issue), ...repoArgs(ctx)];
  for (const label of remove) args.push("--remove-label", label);
  for (const label of add) args.push("--add-label", label);
  const r = await runGh(ctx, args);
  return r.code === 0;
}

/** `gh issue comment --body …` (best-effort). */
export async function comment(ctx: GhContext, issue: number, body: string): Promise<void> {
  await runGh(ctx, ["issue", "comment", String(issue), ...repoArgs(ctx), "--body", scrubOutbound(body)]);
}

// ---------- atomic GitHub-native claim (ADR 0066) ----------
//
// The claim primitive needs the comment's server-assigned NUMERIC id (the
// cross-host total order), which `gh issue comment` / `gh issue view --json
// comments` do not expose. The REST API does, so these go through `gh api`.

function apiPath(ctx: GhContext, suffix: string): string {
  // ctx.repo is `owner/repo`; fall back to the cwd repo when unset (gh resolves).
  return ctx.repo ? `repos/${ctx.repo}/${suffix}` : suffix;
}

/** Post a claim/concede marker comment and resolve its server-assigned numeric
 * id (the total order). Throws on a non-zero gh exit so a failed POST never reads
 * as a won claim. */
export async function postClaimComment(ctx: GhContext, issue: number, body: string): Promise<number> {
  const r = await runGh(ctx, [
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
  const r = await runGh(ctx, [
    "api",
    "--paginate",
    apiPath(ctx, `issues/${issue}/comments`),
    "--jq",
    ".[] | {id: .id, body: .body, createdAt: .created_at}",
  ]);
  if (r.code !== 0) return [];
  const out: { id: number; body: string; createdAt?: string }[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { id?: number; body?: string; createdAt?: string };
      if (typeof o.id === "number" && typeof o.body === "string") {
        out.push({ id: o.id, body: o.body, createdAt: o.createdAt });
      }
    } catch {
      // tolerate a malformed jq line; the reconciler is garbage-tolerant anyway.
    }
  }
  return out;
}

/** `gh issue edit --body …`. */
export async function editBody(ctx: GhContext, issue: number, body: string): Promise<boolean> {
  const r = await runGh(ctx, ["issue", "edit", String(issue), ...repoArgs(ctx), "--body", scrubOutbound(body)]);
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
  const r = await runGh(ctx, [
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
  const r = await runGh(ctx, ["api", apiPath(ctx, `issues/${issue}`), "--jq", ".id"]);
  const id = Number((r.stdout ?? "").trim());
  if (r.code !== 0 || !Number.isInteger(id) || id <= 0) {
    throw new Error(`gh: failed to resolve issue database id for #${issue} (code ${r.code})`);
  }
  return id;
}

/** Create a native GitHub sub-issue relationship from parent Spec to child
 * Ticket. Idempotence is provided by callers/sweeps comparing existing edges;
 * a failed POST throws so the caller can leave the pair for the next sweep. */
export async function attachSubIssue(ctx: GhContext, parent: number, child: number): Promise<void> {
  const childId = await issueDatabaseId(ctx, child);
  const r = await runGh(ctx, [
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

function parseIssueRows(stdout: string): Array<{
  number?: number;
  state?: string;
  closedAt?: string | null;
  labels?: Array<{ name?: string }>;
}> {
  try {
    const rows = JSON.parse(stdout || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function parseNumberJsonLines(stdout: string): number[] {
  const out: number[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { number?: unknown };
      const n = Number(parsed.number ?? 0);
      if (Number.isInteger(n) && n > 0) out.push(n);
    } catch {
      // Ignore malformed jq lines; the sweep will retry on a later boot.
    }
  }
  return out;
}

function isRecentSpecRow(row: { state?: string; closedAt?: string | null }, nowS: number, recentDays: number): boolean {
  if (String(row.state ?? "").toUpperCase() !== "CLOSED") return true;
  if (!row.closedAt) return false;
  const closedS = Math.floor(Date.parse(row.closedAt) / 1000);
  if (!Number.isFinite(closedS)) return false;
  return nowS - closedS <= recentDays * 86400;
}

async function listSpecLabelChildren(ctx: GhContext, spec: number): Promise<number[]> {
  const r = await runGh(ctx, [
    "issue",
    "list",
    ...repoArgs(ctx),
    "--label",
    `spec:${spec}`,
    "--state",
    "all",
    "--limit",
    "500",
    "--json",
    "number,labels",
  ]);
  if (r.code !== 0) return [];
  return parseIssueRows(r.stdout).map((row) => Number(row.number ?? 0)).filter((n) => Number.isInteger(n) && n > 0);
}

async function listNativeSubIssues(ctx: GhContext, spec: number): Promise<number[]> {
  const r = await runGh(ctx, [
    "api",
    "--paginate",
    apiPath(ctx, `issues/${spec}/sub_issues`),
    "--jq",
    ".[] | {number}",
  ]);
  if (r.code !== 0) return [];
  return parseNumberJsonLines(r.stdout);
}

/** List Specs for the sub-issue reconciler: open Specs plus recently closed
 * Specs, with both surfaces injected into the pure reconciler. */
export async function listSpecSubIssueCandidates(
  ctx: GhContext,
  nowS = Math.floor(Date.now() / 1000),
  recentDays = 30,
): Promise<SpecSubIssueCandidate[]> {
  const r = await runGh(ctx, [
    "issue",
    "list",
    ...repoArgs(ctx),
    "--label",
    LABEL_TYPE_SPEC,
    "--state",
    "all",
    "--limit",
    "500",
    "--json",
    "number,state,closedAt,labels",
  ]);
  if (r.code !== 0) return [];

  const specs = parseIssueRows(r.stdout)
    .filter((row) => isRecentSpecRow(row, nowS, recentDays))
    .map((row) => ({
      number: Number(row.number ?? 0),
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")) : [],
    }))
    .filter((row) => Number.isInteger(row.number) && row.number > 0);

  const candidates: SpecSubIssueCandidate[] = [];
  for (const spec of specs) {
    const [labelChildren, nativeSubIssues] = await Promise.all([
      listSpecLabelChildren(ctx, spec.number),
      listNativeSubIssues(ctx, spec.number),
    ]);
    candidates.push({
      number: spec.number,
      labels: spec.labels,
      labelChildren,
      nativeSubIssues,
    });
  }
  return candidates;
}

/** Find the single open auto-filed main-red repair issue by its stable title. */
export async function findMainRedRepairIssue(ctx: GhContext): Promise<MainRedRepairIssue | null> {
  const r = await runGh(ctx, [
    "issue",
    "list",
    ...repoArgs(ctx),
    "--state",
    "open",
    "--limit",
    "50",
    "--search",
    `"${MAIN_RED_REPAIR_TITLE}" in:title`,
    "--json",
    "number,title,body,labels",
  ]);
  if (r.code !== 0) return null;
  try {
    const rows = JSON.parse(r.stdout || "[]") as Array<{
      number?: number;
      title?: string;
      body?: string;
      labels?: Array<{ name?: string }>;
    }>;
    if (!Array.isArray(rows)) return null;
    const row = rows
      .filter((item) => String(item.title ?? "") === MAIN_RED_REPAIR_TITLE)
      .sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0))[0];
    if (!row || !Number(row.number)) return null;
    return {
      number: Number(row.number),
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")) : [],
    };
  } catch {
    return null;
  }
}

/** Create the auto-filed main-red repair issue. */
export async function createMainRedRepairIssue(
  ctx: GhContext,
  spec: { title: string; body: string; labels: readonly string[] },
): Promise<number> {
  return createIssue(ctx, spec);
}

/** Refresh the auto-filed main-red repair issue. */
export async function updateMainRedRepairIssue(
  ctx: GhContext,
  issue: number,
  spec: { title: string; body: string; labels: readonly string[] },
): Promise<void> {
  const args = [
    "issue",
    "edit",
    String(issue),
    ...repoArgs(ctx),
    "--title",
    scrubOutbound(spec.title),
    "--body",
    scrubOutbound(spec.body),
  ];
  for (const label of spec.labels) args.push("--add-label", label);
  await runGh(ctx, args);
}

/** Close the auto-filed main-red repair issue once main is green again. */
export async function closeMainRedRepairIssue(ctx: GhContext, issue: number, closeComment: string): Promise<void> {
  await comment(ctx, issue, closeComment);
  await closeIssue(ctx, issue);
}

/** Idempotently create the `runner-error` label (best-effort). Mirrors
 * supervisor.sh ensure_runner_error_label — a label that already exists exits
 * non-zero and is swallowed. */
export async function ensureRunnerErrorLabel(ctx: GhContext): Promise<void> {
  await runGh(ctx, 
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
 * label that already exists exits non-zero and is swallowed by the caller. */
export async function ensureLabel(ctx: GhContext, name: string): Promise<void> {
  await runGh(ctx, 
    [
      "label",
      "create",
      name,
      ...repoArgs(ctx),
      "--color",
      "5319E7",
      "--description",
      "AFK terminal-failure reason (observability)",
    ],
  );
}

/** `gh issue close --reason completed`. */
export async function closeIssue(ctx: GhContext, issue: number): Promise<void> {
  await runGh(ctx, ["issue", "close", String(issue), ...repoArgs(ctx), "--reason", "completed"]);
}

/** Full metadata for a single issue (`gh issue view --json number,title,body,labels`).
 * Returns null on a 404 or transient gh failure. */
export async function viewIssueFull(
  ctx: GhContext,
  issue: number,
): Promise<{ number: number; title: string; body: string; labels: string[] } | null> {
  const r = await runGh(ctx, [
    "issue",
    "view",
    String(issue),
    ...repoArgs(ctx),
    "--json",
    "number,title,body,labels",
  ]);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
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
  } catch {
    return null;
  }
}

/** `gh issue view --json body` → raw body, or undefined when absent. */
export async function issueBody(ctx: GhContext, issue: number): Promise<string | undefined> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "body"]);
  if (r.code !== 0) return undefined;
  try {
    return String((JSON.parse(r.stdout) as { body?: string }).body ?? "");
  } catch {
    return undefined;
  }
}

/** `gh issue view --json url` → the resolved issue url. */
export async function issueUrl(ctx: GhContext, issue: number): Promise<string> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "url"]);
  if (r.code !== 0) return "";
  try {
    return String((JSON.parse(r.stdout) as { url?: string }).url ?? "");
  } catch {
    return "";
  }
}

/** `gh issue view --json number,title,url` for human-facing issue references. */
export async function issueReference(
  ctx: GhContext,
  issue: number,
): Promise<{ number: number; title?: string; url?: string } | undefined> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "number,title,url"]);
  if (r.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(r.stdout) as { number?: number; title?: string; url?: string };
    return {
      number: Number(parsed.number ?? issue),
      title: String(parsed.title ?? ""),
      url: String(parsed.url ?? ""),
    };
  } catch {
    return undefined;
  }
}
