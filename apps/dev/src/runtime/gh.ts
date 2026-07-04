// runtime/gh.ts — concrete `gh` closures backed by exec.ts.
//
// These build the side-effect and lookup surfaces the orchestrators inject:
// issue listing/viewing/editing/commenting/closing and the per-decider lookups
// (orphan state, branch issue state, blocker state, straggler counts). Every
// call routes through runtime/exec.ts's `gh` helper — the single process seam.
// Best-effort writes swallow failures (the bash orchestrator's `|| true`).

import { execTool, type ExecOptions, type ExecFn, type ExecOutput } from "./exec.js";
import {
  LABEL_READY,
  LABEL_HUMAN,
  LABEL_RUNNING,
  LABEL_DEPENDENCY,
  LABEL_STALLED,
  LABEL_CRASHED,
  LABEL_MERGE_CONFLICT,
} from "../core/triage-labels.js";
import type { IssueCandidate } from "../core/session.js";
import type { HitlCandidate } from "../core/hitl-selection.js";
import type { IssueMeta } from "../core/branch-cleanup.js";
import type { HandoffComment } from "../core/handoff.js";
import { classifySourceTrust, TRUSTED_ASSOCIATIONS, type SourceTrustLevel } from "../core/source-trust.js";
import type { ActorTrustVerdict, RepoVisibility } from "../core/trust-gate.js";
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
 * on the report text (gh writes it to stderr): a transient blip → true (token
 * present, just couldn't validate now — boot proceeds and the individual gh
 * calls degrade on their own `r.code !== 0` guards); a definitive
 * unauthenticated signal → false. An unrecognised non-zero stays conservative →
 * false.
 *
 * The transient pattern is tested BEFORE the unauthenticated one: a transient
 * report may itself carry an auth hint ("…try again later; run `gh auth login`
 * if this persists"), and a rate-limit / 5xx blip with a valid token configured
 * must NOT be misread as unauthenticated just because the hint matched. The
 * live-API failure is the stronger signal that the credential is present.
 */
export async function ghAuthenticated(ctx: GhContext): Promise<boolean> {
  const r = await runGh(ctx, ["auth", "status"]);
  if (r.code === 0) return true;
  const report = `${r.stdout}\n${r.stderr}`;
  if (ghAuthTransientPattern.test(report)) return true;
  if (ghUnauthenticatedPattern.test(report)) return false;
  return false;
}

/** List the candidate pool projected to IssueCandidate[]. Defaults to the
 * `ready-for-agent` lane the `/afk` fleet drains; `/go` passes its isolated
 * `lane:go` label so its dedicated worker sees only the minted disposable issue
 * and the fleet never does. */
export async function listCandidates(ctx: GhContext, label: string = LABEL_READY): Promise<IssueCandidate[]> {
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
    `body=${body}`,
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
  const r = await runGh(ctx, ["issue", "edit", String(issue), ...repoArgs(ctx), "--body", body]);
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
    spec.title,
    "--body",
    spec.body,
    ...labelArgs,
  ]);
  const match = (r.stdout ?? "").match(/\/issues\/(\d+)\b/);
  const num = match ? Number(match[1]) : NaN;
  if (r.code !== 0 || !Number.isInteger(num) || num <= 0) {
    throw new Error(`gh: failed to create issue (code ${r.code}): ${(r.stdout || r.stderr || "").trim()}`);
  }
  return num;
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

/** A `resolveActorTrust`-bound lookup the projection consults for an author whose
 * association alone does not confer trust (issue #1100). Injected so gh.ts stays
 * the only IO seam and the source-trust decision stays pure. */
export type CommentTrustResolver = (actor: string) => Promise<ActorTrustVerdict>;

interface RawGhComment {
  body?: string;
  author?: { login?: string; is_bot?: boolean };
  authorAssociation?: string;
  createdAt?: string;
  reactionGroups?: Array<{
    content?: string;
    users?: { nodes?: Array<{ login?: string }> };
  }>;
}

function parseJsonLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // tolerate malformed jq lines; callers degrade to the valid subset.
    }
  }
  return out;
}

function thumbsUpReactors(comment: RawGhComment): string[] {
  const reactors: string[] = [];
  for (const group of comment.reactionGroups ?? []) {
    if (String(group.content ?? "").toUpperCase() !== "THUMBS_UP") continue;
    for (const node of group.users?.nodes ?? []) {
      const login = String(node.login ?? "").trim();
      if (login) reactors.push(login);
    }
  }
  return reactors;
}

function isMaintainerThumbsUp(verdict: ActorTrustVerdict | undefined): boolean {
  return (
    verdict?.executable === true &&
    (verdict.basis === "write-access" || verdict.basis === "codeowners")
  );
}

/** Project GitHub comments to handoff comments with the source-trust taxonomy.
 * Bot authors resolve to `automation` and OWNER/MEMBER/COLLABORATOR associations
 * to `trusted` from the projection alone; every other author is resolved through
 * the injected `resolveTrust` primitive so allowlist / write-access / CODEOWNERS
 * overrides still promote. A maintainer's THUMBS_UP reaction promotes only the
 * reacted comment; it does not change the author's trust on sibling comments.
 * Results are memoised per login within the call. When `resolveTrust` is omitted
 * the level is decided from association + bot status only (a non-collaborator
 * falls to `dubious`, and reaction promotion is unavailable). */
async function projectComments(
  raw: readonly RawGhComment[],
  resolveTrust?: CommentTrustResolver,
): Promise<HandoffComment[]> {
  // Memoise the (potentially gh-backed) trust verdict per login within this call.
  const verdicts = new Map<string, ActorTrustVerdict | undefined>();
  const resolveVerdict = async (login: string | undefined): Promise<ActorTrustVerdict | undefined> => {
    if (!login || !resolveTrust) return undefined;
    if (verdicts.has(login)) return verdicts.get(login);
    let verdict: ActorTrustVerdict | undefined;
    try {
      verdict = await resolveTrust(login);
    } catch {
      verdict = undefined;
    }
    verdicts.set(login, verdict);
    return verdict;
  };

  const out: HandoffComment[] = [];
  for (const c of raw) {
    const login = c.author?.login ? String(c.author.login) : undefined;
    const isBot = c.author?.is_bot === true;
    const authorAssociation = c.authorAssociation ? String(c.authorAssociation) : undefined;
    // A bot, or an already-trusted association, needs no gh trust lookup — only an
    // otherwise-dubious human author is resolved through the trust primitive.
    const associationTrusted = TRUSTED_ASSOCIATIONS.has((authorAssociation ?? "").trim().toUpperCase());
    const trustVerdict = isBot || associationTrusted ? undefined : await resolveVerdict(login);
    const maintainerThumbsUp = (
      await Promise.all(thumbsUpReactors(c).map((actor) => resolveVerdict(actor)))
    ).some(isMaintainerThumbsUp);
    out.push({
      body: String(c.body ?? ""),
      author: login,
      createdAt: c.createdAt ? String(c.createdAt) : undefined,
      sourceTrust: classifySourceTrust({
        authorAssociation,
        isBot,
        trustVerdict,
        maintainerThumbsUp,
      }),
    });
  }
  return out;
}

/** `gh issue view --json comments` → handoff-projected comment list. Each comment
 * carries the author login + body + createdAt the handoff renders, plus the
 * resolved source-trust LEVEL (issue #1100) so guidance promotion gates on SOURCE
 * rather than directive FORMAT. */
export async function issueComments(
  ctx: GhContext,
  issue: number,
  resolveTrust?: CommentTrustResolver,
): Promise<HandoffComment[]> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "comments"]);
  if (r.code !== 0) return [];
  let parsed: {
    comments?: Array<{
      body?: string;
      author?: { login?: string; is_bot?: boolean };
      authorAssociation?: string;
      createdAt?: string;
      reactionGroups?: RawGhComment["reactionGroups"];
    }>;
  };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.comments)) return [];
  return projectComments(parsed.comments, resolveTrust);
}

function restCommentJq(): string {
  return '.[] | {body: .body, author: {login: .user.login, is_bot: (.user.type == "Bot")}, authorAssociation: .author_association, createdAt: .created_at}';
}

/** PR top-level comments use GitHub's issue-comment API. Project them with the
 * exact same source-trust rule as issue comments so only trusted-source
 * directives can become authoritative guidance. */
export async function prComments(
  ctx: GhContext,
  pr: number,
  resolveTrust?: CommentTrustResolver,
): Promise<HandoffComment[]> {
  const r = await runGh(ctx, ["api", "--paginate", apiPath(ctx, `issues/${pr}/comments`), "--jq", restCommentJq()]);
  if (r.code !== 0) return [];
  return projectComments(parseJsonLines(r.stdout) as RawGhComment[], resolveTrust);
}

/** PR review comments use a separate pull-review-comment API but share the same
 * source-trust projection as issue and PR comments. */
export async function prReviewComments(
  ctx: GhContext,
  pr: number,
  resolveTrust?: CommentTrustResolver,
): Promise<HandoffComment[]> {
  const r = await runGh(ctx, ["api", "--paginate", apiPath(ctx, `pulls/${pr}/comments`), "--jq", restCommentJq()]);
  if (r.code !== 0) return [];
  return projectComments(parseJsonLines(r.stdout) as RawGhComment[], resolveTrust);
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
    const label = labels.includes(LABEL_HUMAN)
      ? LABEL_HUMAN
      : labels.includes(LABEL_RUNNING)
        ? LABEL_RUNNING
        : null;
    return { ghOk: true, state: String(parsed.state ?? "OPEN"), label, envelopePosted: false };
  } catch {
    return { ghOk: false, state: "OPEN", label: null, envelopePosted: false };
  }
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
): Promise<{ ghOk: boolean; stillRunning: boolean; envelopePosted: boolean }> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state,labels,comments"]);
  if (r.code !== 0) return { ghOk: false, stillRunning: false, envelopePosted: false };
  try {
    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      labels?: Array<{ name?: string }>;
      comments?: Array<{ body?: string }>;
    };
    const labels = Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l.name ?? "")) : [];
    const stillRunning = String(parsed.state ?? "OPEN") !== "CLOSED" && labels.includes(LABEL_RUNNING);
    const envelopePosted = Array.isArray(parsed.comments)
      ? parsed.comments.some((c) => String(c.body ?? "").includes("data-attempt-status"))
      : false;
    return { ghOk: true, stillRunning, envelopePosted };
  } catch {
    return { ghOk: false, stillRunning: false, envelopePosted: false };
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
  return countIssues(ctx, ["--label", LABEL_READY]);
}

/** Count open `ready-for-human` issues (the 🆘 statusline count). */
export function countReadyForHuman(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", LABEL_HUMAN]);
}

/** Count `needs-triage` straggler issues. */
export function countNeedsTriage(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", "needs-triage"]);
}

/** Count ALL open issues — the repo-global `is` statusline count (no label
 * filter). Capped at 500 like {@link countIssues}; a busier repo undercounts,
 * which is acceptable for a glanceable badge. */
export function countOpenIssues(ctx: GhContext): Promise<number> {
  return countIssues(ctx, []);
}

/** Count open pull requests — the repo-global `pr` statusline count. Mirrors
 * {@link countIssues} against `gh pr list`. Returns 0 on any gh/auth/parse
 * failure so the statusline stays fail-open. */
export async function countOpenPrs(ctx: GhContext): Promise<number> {
  const r = await runGh(ctx, [
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
  if (r.code !== 0) return 0;
  try {
    const parsed = JSON.parse(r.stdout) as unknown[];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
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

/** List open issues labelled `blocked:stalled`, `blocked:crashed`, OR
 * `blocked:merge-conflict` — the parked-mechanical candidates the boot reconcile
 * sweep processes (merge-conflict added in #1095: a land-time trunk conflict is
 * mechanical, not a human decision). The `gh issue list` calls run concurrently
 * and are de-duplicated by issue number. A failed probe for any label returns []
 * for that label; the surviving set is still processed. */
export async function listParkedMechanicalCandidates(
  ctx: GhContext,
): Promise<ReconcileSweepCandidate[]> {
  const [stalled, crashed, mergeConflict] = await Promise.all([
    listIssuesByLabel(ctx, LABEL_STALLED),
    listIssuesByLabel(ctx, LABEL_CRASHED),
    listIssuesByLabel(ctx, LABEL_MERGE_CONFLICT),
  ]);
  const seen = new Set<number>();
  const result: ReconcileSweepCandidate[] = [];
  for (const c of [...stalled, ...crashed, ...mergeConflict]) {
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
 * Trust-gate provenance for one issue (#621, ADR 0085): the author login + the
 * actor who applied `ready-for-agent`, read from the issue TIMELINE (never
 * inferred from the mutable label set). Two best-effort gh reads:
 *   - `gh issue view --json author` → author login;
 *   - `gh api repos/{owner}/{repo}/issues/{n}/timeline` → the LAST `labeled`
 *     event for `ready-for-agent`, whose `actor.login` is the promoter.
 * The `{owner}`/`{repo}` placeholders resolve from the current repo, so an empty
 * `ctx.repo` (worker's own checkout) still works. Either field is `undefined`
 * when its read fails — the gate treats unknown provenance as untrusted.
 */
export async function issueTrust(
  ctx: GhContext,
  issue: number,
): Promise<{ author?: string; authorSourceTrust?: SourceTrustLevel; readyForAgentActor?: string }> {
  const [author, actor] = await Promise.all([
    issueAuthorProfile(ctx, issue),
    readyForAgentActor(ctx, issue),
  ]);
  return { author: author.login, authorSourceTrust: author.sourceTrust, readyForAgentActor: actor };
}

/** `gh issue view --json author` → the author login, or undefined on failure.
 * Exported for the trust-gated triage router (#751), which gates auto-triage on
 * the AUTHOR alone (a `needs-triage` issue has no `ready-for-agent` actor yet). */
export async function issueAuthor(ctx: GhContext, issue: number): Promise<string | undefined> {
  return issueAuthorLogin(ctx, issue);
}

/**
 * `gh repo view --json visibility` → the repository visibility (issue #1101),
 * lower-cased to the {@link RepoVisibility} union the trust-gate folds into its
 * fail-closed default. A best-effort read: `undefined` on any failure (gh absent,
 * unauthenticated, network blip) or an unrecognised value, which the gate treats
 * as NON-public → the permissive default is preserved when visibility is unknown.
 */
export async function repoVisibility(ctx: GhContext): Promise<RepoVisibility | undefined> {
  const r = await runGh(ctx, ["repo", "view", ...(ctx.repo ? [ctx.repo] : []), "--json", "visibility"]);
  if (r.code !== 0) return undefined;
  try {
    const raw = (JSON.parse(r.stdout) as { visibility?: string }).visibility;
    const v = String(raw ?? "").trim().toLowerCase();
    return v === "public" || v === "private" || v === "internal" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `gh issue view --json author` → the author login, or undefined on failure. */
async function issueAuthorLogin(ctx: GhContext, issue: number): Promise<string | undefined> {
  return (await issueAuthorProfile(ctx, issue)).login;
}

async function issueAuthorProfile(
  ctx: GhContext,
  issue: number,
): Promise<{ login?: string; sourceTrust?: SourceTrustLevel }> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "author,authorAssociation"]);
  if (r.code !== 0) return issueAuthorProfileLegacy(ctx, issue);
  try {
    const parsed = JSON.parse(r.stdout) as {
      author?: { login?: string; is_bot?: boolean; type?: string };
      authorAssociation?: string;
    };
    const login = parsed.author?.login ? String(parsed.author.login) : undefined;
    if (!login) return issueAuthorProfileLegacy(ctx, issue);
    const authorType = String(parsed.author?.type ?? "").toLowerCase();
    const isBot = parsed.author?.is_bot === true || authorType === "bot";
    return {
      login,
      sourceTrust: classifySourceTrust({ authorAssociation: parsed.authorAssociation, isBot }),
    };
  } catch {
    return issueAuthorProfileLegacy(ctx, issue);
  }
}

async function issueAuthorProfileLegacy(
  ctx: GhContext,
  issue: number,
): Promise<{ login?: string; sourceTrust?: SourceTrustLevel }> {
  const r = await runGh(ctx, ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "author"]);
  if (r.code !== 0) return {};
  try {
    const parsed = JSON.parse(r.stdout) as { author?: { login?: string; is_bot?: boolean; type?: string } };
    const login = parsed.author?.login ? String(parsed.author.login) : undefined;
    const authorType = String(parsed.author?.type ?? "").toLowerCase();
    const isBot = parsed.author?.is_bot === true || authorType === "bot";
    return { login, sourceTrust: login ? classifySourceTrust({ isBot }) : undefined };
  } catch {
    return {};
  }
}

/** Read the login of the actor who applied `ready-for-agent` from the issue
 * timeline (REST `…/issues/{n}/timeline`). Returns the MOST RECENT `labeled`
 * event for the label — a re-applied label reflects the latest promoter.
 * undefined when the read fails or no such event exists. */
async function readyForAgentActor(ctx: GhContext, issue: number): Promise<string | undefined> {
  const r = await runGh(ctx, [
    "api",
    `repos/{owner}/{repo}/issues/${issue}/timeline`,
    "--paginate",
    "-H",
    "Accept: application/vnd.github+json",
  ]);
  if (r.code !== 0) return undefined;
  try {
    // `--paginate` concatenates pages; tolerate either one array or several.
    const text = r.stdout.trim();
    const events = text.startsWith("[")
      ? (JSON.parse(text) as unknown[])
      : (JSON.parse(`[${text.replace(/\]\s*\[/g, ",")}]`) as unknown[]);
    let actor: string | undefined;
    for (const ev of events) {
      const e = ev as { event?: string; label?: { name?: string }; actor?: { login?: string } };
      if (e.event === "labeled" && e.label?.name === LABEL_READY && e.actor?.login) {
        actor = String(e.actor.login); // keep the last (most recent) match
      }
    }
    return actor;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an actor's dynamic-base trust signals (PRD #745, issue #747): GitHub
 * write access and CODEOWNERS membership, the base the layered
 * `resolveActorTrust` resolver decides over. Two best-effort reads, each
 * degrading to `undefined` ("signal not available") on any gh failure so the
 * resolver can fall back to the allowlist override and the permissive default:
 *   - write access: `gh api repos/{owner}/{repo}/collaborators/{actor}/permission`
 *     → `admin` / `maintain` / `write` count as write-or-higher;
 *   - CODEOWNERS: fetch the repo CODEOWNERS file (the three GitHub-recognised
 *     locations) and test whether `@actor` appears as an owner token.
 * Bound to an `ActorTrustLookup` by the caller as `(actor) => actorTrustSignals(ctx, actor)`.
 */
export async function actorTrustSignals(
  ctx: GhContext,
  actor: string,
): Promise<{ hasWriteAccess?: boolean; inCodeowners?: boolean }> {
  const [hasWriteAccess, inCodeowners] = await Promise.all([
    actorWriteAccess(ctx, actor),
    actorInCodeowners(ctx, actor),
  ]);
  return { hasWriteAccess, inCodeowners };
}

/** Permission levels at or above repository write access. */
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/** `gh api repos/{owner}/{repo}/collaborators/{actor}/permission` → true when the
 * actor's permission is write-or-higher. undefined on a transient/auth failure;
 * a definitive 404 (not a collaborator) resolves to `false`. */
async function actorWriteAccess(ctx: GhContext, actor: string): Promise<boolean | undefined> {
  const r = await runGh(ctx, [
    "api",
    apiPath(ctx, `collaborators/${actor}/permission`),
    "--jq",
    ".permission",
  ]);
  if (r.code !== 0) {
    if (/not found|404|no such|could not resolve/i.test(`${r.stdout}\n${r.stderr}`)) return false;
    return undefined;
  }
  const permission = (r.stdout ?? "").trim().toLowerCase();
  if (!permission) return undefined;
  return WRITE_PERMISSIONS.has(permission);
}

/** The GitHub-recognised CODEOWNERS locations, in resolution order. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** Resolve whether `@actor` is an owner token in the repo CODEOWNERS file. Reads
 * the recognised locations in order; the first that resolves is parsed. undefined
 * when no read succeeded (transient/auth) and `false` when a file was read but
 * the actor is absent (or no CODEOWNERS exists at all). */
async function actorInCodeowners(ctx: GhContext, actor: string): Promise<boolean | undefined> {
  let sawDefinitiveMiss = false;
  for (const path of CODEOWNERS_PATHS) {
    const r = await runGh(ctx, [
      "api",
      apiPath(ctx, `contents/${path}`),
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    if (r.code === 0) return codeownersHasOwner(r.stdout ?? "", actor);
    if (/not found|404|could not resolve/i.test(`${r.stdout}\n${r.stderr}`)) {
      sawDefinitiveMiss = true;
      continue; // this location is absent; try the next one
    }
    return undefined; // transient/auth failure — signal not available
  }
  // Every location returned a definitive 404 → there is no CODEOWNERS file.
  return sawDefinitiveMiss ? false : undefined;
}

/** True when `@actor` (case-insensitive) appears as an owner token on any
 * non-comment CODEOWNERS line. Team owners (`@org/team`) are not expanded here —
 * only direct `@login` ownership is matched. */
function codeownersHasOwner(content: string, actor: string): boolean {
  const target = `@${actor.replace(/^@/, "")}`.toLowerCase();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    // tokens: <pattern> <owner> [<owner> ...]; owners start at the first @-token.
    const tokens = line.split(/\s+/).slice(1);
    if (tokens.some((t) => t.toLowerCase() === target)) return true;
  }
  return false;
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
