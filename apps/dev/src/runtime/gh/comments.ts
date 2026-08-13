import type { HandoffComment } from "../../core/handoff.js";
import { classifySourceTrust, TRUSTED_ASSOCIATIONS, type SourceTrustLevel } from "../../core/source-trust.js";
import type { ActorTrustVerdict } from "../../core/trust-gate.js";
import { githubReadClient, githubRepo, type GhContext } from "./common.js";

export type CommentTrustResolver = (actor: string) => Promise<ActorTrustVerdict>;

interface RawGhComment {
  id?: number;
  body?: string;
  author?: { login?: string; is_bot?: boolean };
  authorAssociation?: string;
  createdAt?: string;
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

/** Project GitHub comments to handoff comments with the source-trust taxonomy.
 * Bot authors resolve to `automation` and OWNER/MEMBER/COLLABORATOR associations
 * to `trusted` from the projection alone; every other author is resolved through
 * the injected `resolveTrust` primitive so allowlist / write-access / CODEOWNERS
 * overrides still promote. Results are memoised per login within the call. When
 * `resolveTrust` is omitted the level is decided from association + bot status
 * only, so a non-collaborator falls to `dubious`. */
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
    out.push({
      body: String(c.body ?? ""),
      author: login,
      createdAt: c.createdAt ? String(c.createdAt) : undefined,
      sourceTrust: classifySourceTrust({ authorAssociation, isBot, trustVerdict }),
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

/** The REST shape this reader needs: the handoff fields plus the numeric id. */
interface RestIssueCommentWithId extends RestIssueComment {
  readonly id?: number;
}

/**
 * REST-backed issue comments for mutation-sensitive idempotency checks.
 *
 * Unlike `issueComments`, this preserves the numeric REST id and reports a read
 * failure SEPARATELY from a successful empty list. The distinction is the whole
 * point: the caller decides from this answer whether to CREATE a comment or
 * UPDATE one, so degrading a transport failure to "no comments" would post a
 * duplicate on every outage.
 */
export async function readIssueComments(
  ctx: GhContext,
  issue: number,
): Promise<IssueCommentsReadResult> {
  const repo = githubRepo(ctx);
  if (!repo) return { ok: false, reason: "reading issue comments needs an owner/repository slug" };
  let rows: readonly RestIssueCommentWithId[];
  try {
    const answer = await githubReadClient(ctx).conditionalPaginate<RestIssueCommentWithId>({
      // Its OWN cache namespace. Four readers already share this route, and an
      // idempotency check must never decide from a body another reader cached.
      cacheKey: `gh:comments-for-update:${repo.owner}/${repo.repo}:${issue}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      parameters: { ...repo, issue_number: issue, per_page: 100 },
      operation: { key: "issue comments", budget: "rest" },
      actor: "dev:comments-for-update",
    });
    rows = answer.data;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (rows.some((row) => !Number.isFinite(Number(row.id)))) {
    return { ok: false, reason: "an issue comment carried no numeric id" };
  }
  return {
    ok: true,
    comments: rows.map((row) => ({
      id: Number(row.id),
      body: String(row.body ?? ""),
      author: row.user?.login ? String(row.user.login) : undefined,
      createdAt: row.created_at ? String(row.created_at) : undefined,
      sourceTrust: classifySourceTrust({
        authorAssociation: row.author_association,
        isBot: row.user?.type === "Bot",
      }),
    })),
  };
}
