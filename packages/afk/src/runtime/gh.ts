// runtime/gh.ts — concrete `gh` closures backed by exec.ts.
//
// These build the side-effect and lookup surfaces the orchestrators inject:
// issue listing/viewing/editing/commenting/closing and the per-decider lookups
// (orphan state, branch issue state, blocker state, straggler counts). Every
// call routes through runtime/exec.ts's `gh` helper — the single process seam.
// Best-effort writes swallow failures (the bash orchestrator's `|| true`).

import { gh, type ExecOptions } from "./exec.js";
import type { IssueCandidate } from "../core/session.js";
import type { IssueMeta } from "../core/branch-cleanup.js";

export interface GhContext {
  /** owner/repo slug for `gh ... --repo`. */
  repo: string;
  /** Working dir gh runs from (the primary checkout). */
  cwd: string;
}

function opts(ctx: GhContext): ExecOptions {
  return { cwd: ctx.cwd };
}

function repoArgs(ctx: GhContext): string[] {
  return ctx.repo ? ["--repo", ctx.repo] : [];
}

/** Check `gh` is installed (any exit but 127 = present). */
export async function ghInstalled(ctx: GhContext): Promise<boolean> {
  const r = await gh(["--version"], opts(ctx));
  return r.code !== 127;
}

/** Check `gh auth status` succeeds. */
export async function ghAuthenticated(ctx: GhContext): Promise<boolean> {
  const r = await gh(["auth", "status"], opts(ctx));
  return r.code === 0;
}

/** List the ready-for-agent candidate pool projected to IssueCandidate[]. */
export async function listCandidates(ctx: GhContext): Promise<IssueCandidate[]> {
  const r = await gh(
    [
      "issue",
      "list",
      ...repoArgs(ctx),
      "--label",
      "ready-for-agent",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,labels,body",
    ],
    opts(ctx),
  );
  if (r.code !== 0) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((row): IssueCandidate => {
    const item = row as { number?: number; title?: string; body?: string; labels?: Array<{ name?: string }> };
    return {
      number: Number(item.number ?? 0),
      title: String(item.title ?? ""),
      body: String(item.body ?? ""),
      labels: Array.isArray(item.labels) ? item.labels.map((l) => String(l.name ?? "")) : [],
    };
  });
}

/** `gh issue view --json labels` → flat label-name list. */
export async function viewLabels(ctx: GhContext, issue: number): Promise<string[]> {
  const r = await gh(["issue", "view", String(issue), ...repoArgs(ctx), "--json", "labels"], opts(ctx));
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
  const r = await gh(args, opts(ctx));
  return r.code === 0;
}

/** `gh issue comment --body …` (best-effort). */
export async function comment(ctx: GhContext, issue: number, body: string): Promise<void> {
  await gh(["issue", "comment", String(issue), ...repoArgs(ctx), "--body", body], opts(ctx));
}

/** `gh issue close --reason completed`. */
export async function closeIssue(ctx: GhContext, issue: number): Promise<void> {
  await gh(["issue", "close", String(issue), ...repoArgs(ctx), "--reason", "completed"], opts(ctx));
}

/** `gh issue view --json body` → raw body, or undefined when absent. */
export async function issueBody(ctx: GhContext, issue: number): Promise<string | undefined> {
  const r = await gh(["issue", "view", String(issue), ...repoArgs(ctx), "--json", "body"], opts(ctx));
  if (r.code !== 0) return undefined;
  try {
    return String((JSON.parse(r.stdout) as { body?: string }).body ?? "");
  } catch {
    return undefined;
  }
}

/** `gh issue view --json url` → the resolved issue url. */
export async function issueUrl(ctx: GhContext, issue: number): Promise<string> {
  const r = await gh(["issue", "view", String(issue), ...repoArgs(ctx), "--json", "url"], opts(ctx));
  if (r.code !== 0) return "";
  try {
    return String((JSON.parse(r.stdout) as { url?: string }).url ?? "");
  } catch {
    return "";
  }
}

/** Branch-cleanup IssueLookup payload: gh issue view --json state,closedAt.
 * Returns null for a definitive 404, undefined for a transient failure. */
export async function issueMeta(ctx: GhContext, issue: number): Promise<IssueMeta | null | undefined> {
  const r = await gh(
    ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state,closedAt"],
    opts(ctx),
  );
  if (r.code !== 0) {
    // gh prints a 404 "Could not resolve" / "not found" on a real miss.
    if (/not found|could not resolve|no issues? match/i.test(r.stderr)) return null;
    return undefined;
  }
  try {
    const parsed = JSON.parse(r.stdout) as { state?: string; closedAt?: string | null };
    return { state: String(parsed.state ?? ""), closedAt: parsed.closedAt ?? null };
  } catch {
    return undefined;
  }
}
