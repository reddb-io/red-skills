import type { HandoffComment } from "../../core/handoff.js";
import { classifySourceTrust, TRUSTED_ASSOCIATIONS, type SourceTrustLevel } from "../../core/source-trust.js";
import type { ActorTrustVerdict } from "../../core/trust-gate.js";
import {
  apiPath,
  githubReadClient,
  githubRepo,
  runGithubRestRead,
  type GhContext,
} from "./common.js";

export type CommentTrustResolver = (actor: string) => Promise<ActorTrustVerdict>;

interface RawGhComment {
  id?: number;
  body?: string;
  author?: { login?: string; is_bot?: boolean };
  authorAssociation?: string;
  createdAt?: string;
  reactionGroups?: Array<{
    content?: string;
    users?: { nodes?: Array<{ login?: string }> };
  }>;
}

export interface IssueCommentForUpdate {
  id: number;
  body: string;
  author?: string;
  createdAt?: string;
  sourceTrust: SourceTrustLevel;
}

export type IssueCommentsReadResult =
  | { ok: true; comments: IssueCommentForUpdate[] }
  | { ok: false; reason: string };

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
  // Paginated through the shared client rather than `gh api --paginate --slurp
  // --jq`: the binary REFUSES `--slurp` beside `--jq`, and this caller read the
  // resulting non-zero exit as "no comments". Directive blocks are how human
  // guidance reaches a Worker, so the silent empty list did not degrade the
  // read — it erased the instruction (#3734).
  const repo = githubRepo(ctx);
  if (!repo) return [];
  let rows: readonly RestIssueComment[];
  try {
    const answer = await githubReadClient(ctx).conditionalPaginate<RestIssueComment>({
      cacheKey: `gh:comments:${repo.owner}/${repo.repo}:${issue}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      parameters: { ...repo, issue_number: issue, per_page: 100 },
      operation: { key: "issue comments", budget: "rest" },
      actor: "dev:comments",
    });
    rows = answer.data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `🤖 /afk comment read failed for #${issue}; treating as empty: ${detail}\n`,
    );
    return [];
  }
  return projectComments(
    rows.map((row) => ({
      body: String(row.body ?? ""),
      author: { login: String(row.user?.login ?? ""), is_bot: row.user?.type === "Bot" },
      authorAssociation: String(row.author_association ?? ""),
      createdAt: String(row.created_at ?? ""),
    })),
    resolveTrust,
  );
}

/** The REST shape of one issue comment, projected to what the handoff renders. */
interface RestIssueComment {
  readonly body?: string | null;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
  readonly author_association?: string;
  readonly created_at?: string;
}

function restCommentJq(): string {
  return '.[] | {body: .body, author: {login: .user.login, is_bot: (.user.type == "Bot")}, authorAssociation: .author_association, createdAt: .created_at}';
}

function restCommentWithIdJq(): string {
  return '.[] | {id: .id, body: .body, author: {login: .user.login, is_bot: (.user.type == "Bot")}, authorAssociation: .author_association, createdAt: .created_at}';
}

function parseStrictCommentJsonLines(stdout: string): RawGhComment[] | undefined {
  const out: RawGhComment[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawGhComment;
      if (!Number.isFinite(Number(parsed.id))) return undefined;
      out.push(parsed);
    } catch {
      return undefined;
    }
  }
  return out;
}

/** REST-backed issue comments for mutation-sensitive idempotency checks. Unlike
 * issueComments(), this preserves the numeric REST id and reports read/parse
 * failure separately from a successful empty list. */
export async function readIssueComments(
  ctx: GhContext,
  issue: number,
): Promise<IssueCommentsReadResult> {
  const r = await runGithubRestRead(ctx, apiPath(ctx, `issues/${issue}/comments`), ["--paginate", "--jq", restCommentWithIdJq()]);
  if (r.code !== 0) return { ok: false, reason: `failed to read issue comments (gh exit ${r.code})` };
  const raw = parseStrictCommentJsonLines(r.stdout ?? "");
  if (!raw) return { ok: false, reason: "failed to parse issue comments JSON" };
  return {
    ok: true,
    comments: raw.map((comment) => ({
      id: Number(comment.id),
      body: String(comment.body ?? ""),
      author: comment.author?.login ? String(comment.author.login) : undefined,
      createdAt: comment.createdAt ? String(comment.createdAt) : undefined,
      sourceTrust: classifySourceTrust({
        authorAssociation: comment.authorAssociation,
        isBot: comment.author?.is_bot === true,
      }),
    })),
  };
}

/** PR top-level comments use GitHub's issue-comment API. Project them with the
 * exact same source-trust rule as issue comments so only trusted-source
 * directives can become authoritative guidance. */
export async function prComments(
  ctx: GhContext,
  pr: number,
  resolveTrust?: CommentTrustResolver,
): Promise<HandoffComment[]> {
  const r = await runGithubRestRead(ctx, apiPath(ctx, `issues/${pr}/comments`), ["--paginate", "--jq", restCommentJq()]);
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
  const r = await runGithubRestRead(ctx, apiPath(ctx, `pulls/${pr}/comments`), ["--paginate", "--jq", restCommentJq()]);
  if (r.code !== 0) return [];
  return projectComments(parseJsonLines(r.stdout) as RawGhComment[], resolveTrust);
}
