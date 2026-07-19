import type { HandoffComment } from "../../core/handoff.js";
import { classifySourceTrust, TRUSTED_ASSOCIATIONS } from "../../core/source-trust.js";
import type { ActorTrustVerdict } from "../../core/trust-gate.js";
import { apiPath, repoArgs, runGh, type GhContext } from "./common.js";

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
