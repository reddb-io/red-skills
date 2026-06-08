// runtime/gh.ts — concrete `gh` closures backed by exec.ts.
//
// These build the side-effect and lookup surfaces the orchestrators inject:
// issue listing/viewing/editing/commenting/closing and the per-decider lookups
// (orphan state, branch issue state, blocker state, straggler counts). Every
// call routes through runtime/exec.ts's `gh` helper — the single process seam.
// Best-effort writes swallow failures (the bash orchestrator's `|| true`).

import { execTool, type ExecOptions, type ExecFn, type ExecOutput } from "./exec.js";
import type { IssueCandidate } from "../core/session.js";
import type { HitlCandidate } from "../core/hitl-selection.js";
import type { IssueMeta } from "../core/branch-cleanup.js";
import type { HandoffComment } from "../core/handoff.js";
import type { IssueOpenState } from "../core/reclaim.js";
import type { UnblockCandidate, ReconcileSweepCandidate } from "../core/boot-sweep.js";

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
}

function opts(ctx: GhContext): ExecOptions {
  return { cwd: ctx.cwd };
}

/**
 * Dispatch a `gh <args>` invocation through the injected exec when present, else
 * the real `gh` helper. This is the single seam every gh closure in this module
 * routes through; the default path is byte-for-byte the prior static `gh` call.
 */
function runGh(ctx: GhContext, args: readonly string[]): Promise<ExecOutput> {
  return (ctx.exec ?? execTool)("gh", args, opts(ctx));
}

function repoArgs(ctx: GhContext): string[] {
  return ctx.repo ? ["--repo", ctx.repo] : [];
}

/** Check `gh` is installed (any exit but 127 = present). */
export async function ghInstalled(ctx: GhContext): Promise<boolean> {
  const r = await runGh(ctx, ["--version"]);
  return r.code !== 127;
}

/**
 * Definitive "no usable credential" signals in `gh auth status` output: the
 * token is absent or the host rejected it. ONLY these mean unauthenticated.
 */
const ghUnauthenticatedPattern =
  /not logged in|no GitHub hosts|no accounts? (are )?logged|authentication required|requires authentication|bad credentials|token .*(invalid|expired|revoked)|run.*gh auth login/i;

/**
 * Transient `gh auth status` failures that DON'T mean unauthenticated: gh
 * validates the configured token via a live API call, so a rate-limit / network
 * / 5xx blip makes `gh auth status` exit non-zero while the credential is still
 * present and valid. Treating these as "unauthenticated" is what bricked the
 * whole fleet's boot precheck during a GitHub rate-limit burst — every worker
 * respawn re-ran the precheck and died with a false "gh not authenticated".
 */
const ghAuthTransientPattern =
  /rate limit|api rate limit|abuse detection|secondary rate|timed? ?out|timeout|temporarily unavailable|service unavailable|could not connect|connection (reset|refused)|dial tcp|i\/o timeout|\b5\d\d\b|EOF|TLS handshake/i;

/**
 * True when `gh` holds a usable credential.
 *
 * `gh auth status` exits 0 when the token validates. A non-zero exit is NOT
 * automatically "unauthenticated": gh exits non-zero both on a real missing /
 * rejected token AND on a transient failure of the validation API call (rate
 * limit, network, 5xx) while a valid token is still configured. We discriminate
 * on the report text (gh writes it to stderr): a definitive unauthenticated
 * signal → false; a transient blip → true (token present, just couldn't
 * validate now — boot proceeds and the individual gh calls degrade on their own
 * `r.code !== 0` guards). An unrecognised non-zero stays conservative → false.
 */
export async function ghAuthenticated(ctx: GhContext): Promise<boolean> {
  const r = await runGh(ctx, ["auth", "status"]);
  if (r.code === 0) return true;
  const report = `${r.stdout}\n${r.stderr}`;
  if (ghUnauthenticatedPattern.test(report)) return false;
  if (ghAuthTransientPattern.test(report)) return true;
  return false;
}

/** List the ready-for-agent candidate pool projected to IssueCandidate[]. */
export async function listCandidates(ctx: GhContext): Promise<IssueCandidate[]> {
  const r = await runGh(ctx, 
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

/** List the ready-for-human candidate pool projected to HitlCandidate[]. */
export async function listHitlCandidates(ctx: GhContext): Promise<HitlCandidate[]> {
  const r = await runGh(ctx, 
    [
      "issue",
      "list",
      ...repoArgs(ctx),
      "--label",
      "ready-for-human",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,labels,body,createdAt",
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
      body?: string;
      createdAt?: string | null;
      labels?: Array<{ name?: string }>;
    };
    return {
      number: Number(item.number ?? 0),
      title: String(item.title ?? ""),
      body: String(item.body ?? ""),
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

/** `gh issue view --json labels` → flat label-name list. */
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
  await runGh(ctx, ["issue", "comment", String(issue), ...repoArgs(ctx), "--body", body]);
}

/** `gh issue edit --body …`. */
export async function editBody(ctx: GhContext, issue: number, body: string): Promise<boolean> {
  const r = await runGh(ctx, ["issue", "edit", String(issue), ...repoArgs(ctx), "--body", body]);
  return r.code === 0;
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

/** `gh issue view --json comments` → handoff-projected comment list. Each
 * comment carries the author login + body + createdAt the handoff renders. */
export async function issueComments(ctx: GhContext, issue: number): Promise<HandoffComment[]> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "comments"]);
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
  const r = await runGh(ctx, 
    ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state,labels"],
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
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state"]);
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
  const r = await runGh(ctx, 
    ["issue", "list", ...repoArgs(ctx), "--state", "open", "--limit", "500", "--json", "number", ...args],
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
  const r = await runGh(ctx, 
    ["issue", "list", ...repoArgs(ctx), "--state", "open", "--limit", "500", "--json", "number,labels"],
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

/** List the unblock-sweep candidates (number + body + labels). The sweep only
 * consumes `blocked:dependency`; `ready-for-human` is a human gate and must not
 * be auto-promoted from dependency closure. */
export async function listUnblockCandidates(ctx: GhContext): Promise<UnblockCandidate[]> {
  const r = await runGh(ctx,
    [
      "issue",
      "list",
      ...repoArgs(ctx),
      "--label",
      "blocked:dependency",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,body,labels",
    ],
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
}

/** List open issues carrying `label` (number + label-name list). Backs the
 * close cascade's `req:<N>` dependent lookup. A failed probe returns []. */
export async function listByLabel(
  ctx: GhContext,
  label: string,
): Promise<{ number: number; labels: string[] }[]> {
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
      "number,labels",
    ],
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

/** List open issues labelled `blocked:stalled` OR `blocked:crashed` — the
 * parked-mechanical candidates the boot reconcile sweep processes. The two
 * `gh issue list` calls run concurrently and are de-duplicated by issue number.
 * A failed probe for either label returns [] for that label; the surviving set
 * is still processed. */
export async function listParkedMechanicalCandidates(
  ctx: GhContext,
): Promise<ReconcileSweepCandidate[]> {
  const [stalled, crashed] = await Promise.all([
    listIssuesByLabel(ctx, "blocked:stalled"),
    listIssuesByLabel(ctx, "blocked:crashed"),
  ]);
  const seen = new Set<number>();
  const result: ReconcileSweepCandidate[] = [];
  for (const c of [...stalled, ...crashed]) {
    if (seen.has(c.number)) continue;
    seen.add(c.number);
    result.push(c);
  }
  return result;
}

/** List open issues carrying `label` with number, title, body, and labels. */
async function listIssuesByLabel(ctx: GhContext, label: string): Promise<ReconcileSweepCandidate[]> {
  const r = await runGh(ctx, [
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
    "number,title,body,labels",
  ]);
  if (r.code !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout) as Array<{
      number?: number;
      title?: string;
      body?: string;
      labels?: Array<{ name?: string }>;
    }>;
    if (!Array.isArray(rows)) return [];
    return rows.map((row): ReconcileSweepCandidate => ({
      number: Number(row.number ?? 0),
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")) : [],
    }));
  } catch {
    return [];
  }
}

/** Branch-cleanup IssueLookup payload: gh issue view --json state,closedAt.
 * Returns null for a definitive 404, undefined for a transient failure. */
export async function issueMeta(ctx: GhContext, issue: number): Promise<IssueMeta | null | undefined> {
  const r = await runGh(ctx, 
    ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state,closedAt"],
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
