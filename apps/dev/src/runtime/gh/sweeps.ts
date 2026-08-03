import {
  LABEL_CRASHED,
  LABEL_DEPENDENCY,
  LABEL_HUMAN,
  LABEL_MERGE_CONFLICT,
  LABEL_RUNNING,
  LABEL_STALLED,
} from "../../core/triage-labels.js";
import type { IssueOpenState } from "../../core/reclaim.js";
import type { ReconcileSweepCandidate, UnblockCandidate } from "../../core/boot-sweep.js";
import { repoArgs, runGh, type GhContext } from "./common.js";
import { readSingleObject } from "./single-object.js";

export async function orphanState(
  ctx: GhContext,
  issue: number,
): Promise<{ ghOk: boolean; state: IssueOpenState; label: string | null; envelopePosted: boolean }> {
  // One issue by number: the router sends it to REST (ADR 0132 decision 4). This
  // is the poll the drain runs per Worker per iteration.
  const read = await readSingleObject(ctx, "issue", issue, ["state", "labels"]);
  if (!read.row) return { ghOk: false, state: "OPEN", label: null, envelopePosted: false };
  const parsed = read.row as { state?: string; labels?: Array<{ name?: string }> };
  const labels = Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l.name ?? "")) : [];
  // afk.sh checks ready-for-human first, then running.
  const label = labels.includes(LABEL_HUMAN)
    ? LABEL_HUMAN
    : labels.includes(LABEL_RUNNING)
      ? LABEL_RUNNING
      : null;
  return { ghOk: true, state: String(parsed.state ?? "OPEN"), label, envelopePosted: false };
}

/** Running-supervisor crash-reconcile lookup (#815): whether a dead worker's
 * last-claimed issue is still stranded in `running` with no terminal envelope.
 * One `gh issue view` round-trip resolving all three signals
 * reconcileDeadWorkerClaim needs:
 *   - `ghOk`           — the read succeeded (false → leave it for the boot sweep).
 *   - `stillRunning`   — the issue is OPEN and still carries the `running` label
 *                        (a worker that completed normally already dropped it).
 *   - `envelopePosted` — some comment already carries a terminal
 *                        `<details data-attempt-status>` envelope, so the
 *                        reconcile skips re-commenting. */
export async function crashedClaimState(
  ctx: GhContext,
  issue: number,
): Promise<{ ghOk: boolean; stillRunning: boolean; envelopePosted: boolean; labels?: string[] }> {
  // `comments` is a COUNT in REST and a LIST here, so this one read keeps gh's
  // GraphQL command by declared field gap rather than by default.
  const read = await readSingleObject(ctx, "issue", issue, ["state", "labels", "comments"]);
  if (!read.row) return { ghOk: false, stillRunning: false, envelopePosted: false };
  {
    const parsed = read.row as {
      state?: string;
      labels?: Array<{ name?: string }>;
      comments?: Array<{ body?: string }>;
    };
    const labels = Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l.name ?? "")) : [];
    const stillRunning = String(parsed.state ?? "OPEN") !== "CLOSED" && labels.includes(LABEL_RUNNING);
    const envelopePosted = Array.isArray(parsed.comments)
      ? parsed.comments.some((c) => String(c.body ?? "").includes("data-attempt-status"))
      : false;
    return { ghOk: true, stillRunning, envelopePosted, labels };
  }
}

/** Branch-cleanup/boot blocker-state lookup: gh issue view --json state → the
 * raw state string ("OPEN" | "CLOSED"), or undefined on a 404/transient miss. */
export async function blockerState(ctx: GhContext, issue: number): Promise<string | undefined> {
  const read = await readSingleObject(ctx, "issue", issue, ["state"]);
  if (!read.row) return undefined;
  return String((read.row as { state?: string }).state ?? "") || undefined;
}

export async function listUnblockCandidates(ctx: GhContext): Promise<UnblockCandidate[]> {
  const r = await runGh(ctx,
    [
      "issue",
      "list",
      ...repoArgs(ctx),
      "--label",
      LABEL_DEPENDENCY,
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

/** List open issues labelled `blocked:stalled`, `blocked:crashed`,
 * `blocked:merge-conflict`, OR `running` — the mechanical candidates the boot reconcile
 * sweep processes (merge-conflict added in #1095: a land-time trunk conflict is
 * mechanical, not a human decision; running is filtered by the stale-claim sweep
 * result before reconcile can run). The `gh issue list` calls run concurrently
 * and are de-duplicated by issue number. A failed probe for any label returns []
 * for that label; the surviving set is still processed. */
export async function listParkedMechanicalCandidates(
  ctx: GhContext,
): Promise<ReconcileSweepCandidate[]> {
  const [stalled, crashed, mergeConflict, running] = await Promise.all([
    listIssuesByLabel(ctx, LABEL_STALLED),
    listIssuesByLabel(ctx, LABEL_CRASHED),
    listIssuesByLabel(ctx, LABEL_MERGE_CONFLICT),
    listIssuesByLabel(ctx, LABEL_RUNNING),
  ]);
  const seen = new Set<number>();
  const result: ReconcileSweepCandidate[] = [];
  for (const c of [...stalled, ...crashed, ...mergeConflict, ...running]) {
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

/**
 * The repo's open pull requests, projected to what adoption and the
 * orphaned-work census need: the number, the head ref, and the body a closing
 * reference may live in (#2893).
 *
 * A failed or unparseable read yields an EMPTY list, which is the conservative
 * answer for a census: nothing is claimed to be covered by a PR nobody could
 * see, so a branch is reported rather than silently excused.
 */
export async function listOpenPullRequests(
  ctx: GhContext,
): Promise<Array<{ number: number; headRefName: string; body?: string }>> {
  const r = await runGh(ctx, [
    "pr",
    "list",
    ...repoArgs(ctx),
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefName,body",
  ]);
  if (r.code !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout || "[]") as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => row as { number?: unknown; headRefName?: unknown; body?: unknown })
      .map((row) => ({
        number: Number(row.number ?? 0),
        headRefName: String(row.headRefName ?? ""),
        ...(typeof row.body === "string" ? { body: row.body } : {}),
      }))
      .filter((row) => row.number > 0 && row.headRefName.length > 0);
  } catch {
    return [];
  }
}
