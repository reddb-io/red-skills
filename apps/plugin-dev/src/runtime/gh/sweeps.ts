import {
  isGithubRateLimitError,
} from "@reddb-io/github";
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
import { githubReadClient, githubRepo, type GhContext } from "./common.js";
import type { GhReadFailure, GhReadResult } from "./read.js";
import { readSingleObject } from "./single-object.js";

/**
 * One issue-collection read, paginated by the shared client.
 *
 * These listings used to be `gh api` invocations carrying `--paginate --slurp
 * … --jq …`, a flag combination the `gh` binary REFUSES (`the --slurp option is
 * not supported with --jq or --template`). The planner that shaped that argv
 * could not have caught it: it validates the REQUEST — no mutation, an explicit
 * `--method GET` so `-f` params stay in the query string — while the
 * incompatibility lives in the CLI. The caller then read the non-zero exit as an
 * empty collection, so the Unblock Sweep, the close cascade's dependent lookup
 * and the parked-mechanical sweep all reported "nothing to do" while the
 * tracker was full (#3734 introduced it; the sweep answered `promoted: []`
 * against two promotable issues).
 *
 * Paginating through the typed client removes the whole category: there is no
 * argv to get wrong, `per_page` and page walking are the client's concern, and
 * the read inherits conditional caching, spend attribution and the retry policy
 * the CLI path forfeited.
 */
interface GithubIssueListItem {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string | null;
  readonly labels?: ReadonlyArray<string | { readonly name?: string }>;
  readonly pull_request?: unknown;
}

/** Label names as plain strings, whichever shape the REST payload used. */
function labelNames(labels: GithubIssueListItem["labels"]): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => (typeof label === "string" ? label : String(label.name ?? "")));
}

/**
 * Name a failed sweep read on stderr before answering with the conservative
 * empty collection.
 *
 * The empty answer itself is deliberate — a sweep that cannot see the tracker
 * must not promote, reconcile or excuse anything. What was NOT deliberate is
 * doing it in silence: an unreachable read and a genuinely quiet repository
 * produced byte-identical output, which is how a broken listing survived a day
 * of sweeps reporting success.
 */
function reportSweepReadFailure(surface: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`🤖 /afk sweep read failed (${surface}); treating as empty: ${detail}\n`);
}

/** Preserve the shared typed read distinction at the paginated client seam. */
function sweepReadFailure(error: unknown): GhReadFailure {
  const quota = isGithubRateLimitError(error);
  return {
    surface: "rest",
    classification: quota ? "quota" : "transport",
    transient: quota,
    code: -1,
    stdout: "",
    stderr: "",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function listIssuesViaClient(
  ctx: GhContext,
  cacheKey: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<readonly GithubIssueListItem[]> {
  const repo = githubRepo(ctx);
  if (!repo) throw new Error("GitHub sweep listing needs an owner/repository slug");
  const answer = await githubReadClient(ctx).conditionalPaginate<GithubIssueListItem>({
    cacheKey: `gh:sweeps:${repo.owner}/${repo.repo}:${cacheKey}`,
    route: "GET /repos/{owner}/{repo}/issues",
    parameters: { ...repo, per_page: 100, state: "open", ...parameters },
    operation: { key: "issue list", budget: "rest" },
    actor: "dev:sweeps",
  });
  return answer.data.filter((issue) => issue.pull_request == null);
}

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

export async function listUnblockCandidates(
  ctx: GhContext,
): Promise<GhReadResult<UnblockCandidate>> {
  try {
    const rows = await listIssuesViaClient(ctx, `unblock:${LABEL_DEPENDENCY}`, {
      labels: LABEL_DEPENDENCY,
    });
    return {
      outcome: "rows",
      rows: rows.map((row): UnblockCandidate => ({
        number: Number(row.number ?? 0),
        body: String(row.body ?? ""),
        labels: labelNames(row.labels),
      })),
    };
  } catch (error) {
    reportSweepReadFailure("unblock candidates", error);
    return { outcome: "failed", failure: sweepReadFailure(error) };
  }
}

/** List open issues carrying `label` (number + label-name list). Backs the
 * close cascade's `req:<N>` dependent lookup. A failed probe returns []. */
export async function listByLabel(
  ctx: GhContext,
  label: string,
): Promise<{ number: number; labels: string[] }[]> {
  try {
    const rows = await listIssuesViaClient(ctx, `by-label:${label}`, { labels: label });
    return rows.map((row) => ({
      number: Number(row.number ?? 0),
      labels: labelNames(row.labels),
    }));
  } catch (error) {
    reportSweepReadFailure(`issues labelled ${label}`, error);
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
  try {
    const rows = await listIssuesViaClient(ctx, `mechanical:${label}`, { labels: label });
    return rows.map((row): ReconcileSweepCandidate => ({
      number: Number(row.number ?? 0),
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      labels: labelNames(row.labels),
    }));
  } catch (error) {
    reportSweepReadFailure(`parked candidates labelled ${label}`, error);
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
  const repo = githubRepo(ctx);
  if (!repo) return [];
  try {
    const answer = await githubReadClient(ctx).conditionalPaginate<{
      number?: number;
      head?: { ref?: string };
      body?: string | null;
    }>({
      cacheKey: `gh:sweeps:${repo.owner}/${repo.repo}:open-pulls`,
      route: "GET /repos/{owner}/{repo}/pulls",
      parameters: { ...repo, per_page: 100, state: "open" },
      operation: { key: "pr list", budget: "rest" },
      actor: "dev:sweeps",
    });
    return answer.data
      .map((row) => ({
        number: Number(row.number ?? 0),
        headRefName: String(row.head?.ref ?? ""),
        ...(typeof row.body === "string" ? { body: row.body } : {}),
      }))
      .filter((row) => row.number > 0 && row.headRefName.length > 0);
  } catch (error) {
    reportSweepReadFailure("open pull requests", error);
    return [];
  }
}
