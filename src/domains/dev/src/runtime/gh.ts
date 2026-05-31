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
import type { HandoffComment } from "../core/handoff.js";
import type { IssueOpenState } from "../core/reclaim.js";
import type { UnblockCandidate } from "../core/boot-sweep.js";

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

/** Idempotently create the `runner-error` label (best-effort). Mirrors
 * supervisor.sh ensure_runner_error_label — a label that already exists exits
 * non-zero and is swallowed. */
export async function ensureRunnerErrorLabel(ctx: GhContext): Promise<void> {
  await gh(
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
    opts(ctx),
  );
}

/** Idempotently create an arbitrary label (best-effort), generalising
 * ensureRunnerErrorLabel for the typed `blocked:<reason>` observability layer. A
 * label that already exists exits non-zero and is swallowed by the caller. */
export async function ensureLabel(ctx: GhContext, name: string): Promise<void> {
  await gh(
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
    opts(ctx),
  );
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

/** `gh issue view --json comments` → handoff-projected comment list. Each
 * comment carries the author login + body + createdAt the handoff renders. */
export async function issueComments(ctx: GhContext, issue: number): Promise<HandoffComment[]> {
  const r = await gh(["issue", "view", String(issue), ...repoArgs(ctx), "--json", "comments"], opts(ctx));
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as {
      comments?: Array<{ body?: string; author?: { login?: string }; createdAt?: string }>;
    };
    if (!Array.isArray(parsed.comments)) return [];
    return parsed.comments.map((c): HandoffComment => ({
      body: String(c.body ?? ""),
      author: c.author?.login ? String(c.author.login) : undefined,
      createdAt: c.createdAt ? String(c.createdAt) : undefined,
    }));
  } catch {
    return [];
  }
}

/** Orphan-cleanup per-dir lookup (prune_orphans): the issue's open/closed state
 * + its single decision-bearing label (ready-for-human / running). A failed gh
 * read returns ghOk=false so the decider falls back to the conservative TTL.
 * The envelope.posted flag is read from the attempt state, not gh, so it is
 * resolved by the caller — here it defaults to false. */
export async function orphanState(
  ctx: GhContext,
  issue: number,
): Promise<{ ghOk: boolean; state: IssueOpenState; label: string | null; envelopePosted: boolean }> {
  const r = await gh(
    ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state,labels"],
    opts(ctx),
  );
  if (r.code !== 0) return { ghOk: false, state: "OPEN", label: null, envelopePosted: false };
  try {
    const parsed = JSON.parse(r.stdout) as { state?: string; labels?: Array<{ name?: string }> };
    const labels = Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l.name ?? "")) : [];
    // afk.sh checks ready-for-human first, then running.
    const label = labels.includes("ready-for-human")
      ? "ready-for-human"
      : labels.includes("running")
        ? "running"
        : null;
    return { ghOk: true, state: String(parsed.state ?? "OPEN"), label, envelopePosted: false };
  } catch {
    return { ghOk: false, state: "OPEN", label: null, envelopePosted: false };
  }
}

/** Branch-cleanup/boot blocker-state lookup: gh issue view --json state → the
 * raw state string ("OPEN" | "CLOSED"), or undefined on a 404/transient miss. */
export async function blockerState(ctx: GhContext, issue: number): Promise<string | undefined> {
  const r = await gh(["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state"], opts(ctx));
  if (r.code !== 0) return undefined;
  try {
    return String((JSON.parse(r.stdout) as { state?: string }).state ?? "") || undefined;
  } catch {
    return undefined;
  }
}

/** Count open issues matching a label expression (`--label`/`--search`). A
 * failed probe returns 0, mirroring the bash `|| echo 0`. */
async function countIssues(ctx: GhContext, args: string[]): Promise<number> {
  const r = await gh(
    ["issue", "list", ...repoArgs(ctx), "--state", "open", "--limit", "500", "--json", "number", ...args],
    opts(ctx),
  );
  if (r.code !== 0) return 0;
  try {
    const parsed = JSON.parse(r.stdout) as unknown[];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Count issues that carry NO labels (the unlabeled straggler bucket). */
export async function countUnlabeled(ctx: GhContext): Promise<number> {
  const r = await gh(
    ["issue", "list", ...repoArgs(ctx), "--state", "open", "--limit", "500", "--json", "number,labels"],
    opts(ctx),
  );
  if (r.code !== 0) return 0;
  try {
    const rows = JSON.parse(r.stdout) as Array<{ labels?: unknown[] }>;
    if (!Array.isArray(rows)) return 0;
    return rows.filter((row) => !Array.isArray(row.labels) || row.labels.length === 0).length;
  } catch {
    return 0;
  }
}

/** Count open `ready-for-agent` issues (the 📋 statusline queue count). */
export function countReadyForAgent(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", "ready-for-agent"]);
}

/** Count open `ready-for-human` issues (the 🆘 statusline count). */
export function countReadyForHuman(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", "ready-for-human"]);
}

/** Count `needs-triage` straggler issues. */
export function countNeedsTriage(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", "needs-triage"]);
}

/** Count `needs-info` straggler issues. */
export function countNeedsInfo(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", "needs-info"]);
}

/** List the unblock-sweep candidates (number + body + labels). The sweep keys
 * off `blocked:dependency` issues via their `req:*` labels (preferred) and
 * keeps the legacy `ready-for-human` + `## Blocked by` body parse as fallback,
 * so both holding states are gathered and de-duplicated by issue number. */
export async function listUnblockCandidates(ctx: GhContext): Promise<UnblockCandidate[]> {
  const fetch = async (label: string): Promise<UnblockCandidate[]> => {
    const r = await gh(
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
        "number,body,labels",
      ],
      opts(ctx),
    );
    if (r.code !== 0) return [];
    try {
      const rows = JSON.parse(r.stdout) as Array<{
        number?: number;
        body?: string;
        labels?: Array<{ name?: string }>;
      }>;
      if (!Array.isArray(rows)) return [];
      return rows.map((row): UnblockCandidate => ({
        number: Number(row.number ?? 0),
        body: String(row.body ?? ""),
        labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")) : [],
      }));
    } catch {
      return [];
    }
  };
  const [byDependency, byHuman] = await Promise.all([
    fetch("blocked:dependency"),
    fetch("ready-for-human"),
  ]);
  const merged = new Map<number, UnblockCandidate>();
  for (const c of [...byDependency, ...byHuman]) {
    if (!merged.has(c.number)) merged.set(c.number, c);
  }
  return [...merged.values()];
}

/** List open issues carrying `label` (number + label-name list). Backs the
 * close cascade's `req:<N>` dependent lookup. A failed probe returns []. */
export async function listByLabel(
  ctx: GhContext,
  label: string,
): Promise<{ number: number; labels: string[] }[]> {
  const r = await gh(
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
      "number,labels",
    ],
    opts(ctx),
  );
  if (r.code !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout) as Array<{ number?: number; labels?: Array<{ name?: string }> }>;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      number: Number(row.number ?? 0),
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")) : [],
    }));
  } catch {
    return [];
  }
}

/** Resolve whether issue `n` is CLOSED (gh issue view --json state). A 404 /
 * transient gh failure resolves to false (not-closed), matching the
 * conservative `blockerState !== "CLOSED"` treatment in the sweep. */
export async function issueClosed(ctx: GhContext, n: number): Promise<boolean> {
  return (await blockerState(ctx, n)) === "CLOSED";
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
