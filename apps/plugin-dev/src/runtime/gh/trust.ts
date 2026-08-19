import { LABEL_READY, EXTERNAL_APPROVAL_MARKER } from "../../core/triage-labels.js";
import { classifySourceTrust, type SourceTrustLevel } from "../../core/source-trust.js";
import type { RepoVisibility } from "../../core/trust-gate.js";
import { githubReadClient, githubRepo, type GhContext } from "./common.js";

interface GithubUser {
  readonly login?: string;
  readonly type?: string;
}

function authorLogin(user: GithubUser | null | undefined): string | undefined {
  const login = String(user?.login ?? "");
  if (login === "") return undefined;
  return String(user?.type ?? "").toLowerCase() === "bot" && login.endsWith("[bot]")
    ? `app/${login.slice(0, -5)}`
    : login;
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

export async function issueTrust(
  ctx: GhContext,
  issue: number,
  promoterLabel: string = LABEL_READY,
): Promise<{ author?: string; authorSourceTrust?: SourceTrustLevel; readyForAgentActor?: string }> {
  // The PROMOTER label is the lane label the issue was selected under (#2602):
  // `ready-for-agent` for the fleet, `lane:go` / `lane:scout` for the isolated
  // /go/scout lanes. A lane:go/lane:scout issue never carries `ready-for-agent`
  // (lane isolation is by design), so resolving the promoter from the lane
  // label's own `labeled` event is what lets the trust gate see the maintainer
  // who minted the dispatch — otherwise every /go dies at claim time under any
  // non-permissive posture.
  const [author, actor] = await Promise.all([
    issueAuthorProfile(ctx, issue),
    labelActor(ctx, issue, promoterLabel),
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
  const repo = githubRepo(ctx);
  if (!repo) return undefined;
  try {
    const answer = await githubReadClient(ctx).conditionalRest<{ visibility?: string }>({
      cacheKey: `gh:repo-visibility:${repo.owner}/${repo.repo}`,
      route: "GET /repos/{owner}/{repo}",
      parameters: { ...repo },
      operation: { key: "repo view", budget: "rest" },
      actor: "dev:trust",
    });
    const raw = answer.data.visibility;
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
  const repo = githubRepo(ctx);
  if (!repo) return {};
  try {
    const answer = await githubReadClient(ctx).conditionalRest<{
      user?: GithubUser | null;
      author_association?: string;
    }>({
      cacheKey: `gh:issue-author:${repo.owner}/${repo.repo}:${issue}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
      parameters: { ...repo, issue_number: issue },
      operation: { key: "issue view", budget: "rest" },
      actor: "dev:trust",
    });
    const login = authorLogin(answer.data.user);
    if (!login) return {};
    const isBot = String(answer.data.user?.type ?? "").toLowerCase() === "bot";
    return {
      login,
      sourceTrust: classifySourceTrust({ authorAssociation: answer.data.author_association, isBot }),
    };
  } catch {
    return {};
  }
}

/** Read the login of the actor who applied `label` from the issue timeline
 * (REST `…/issues/{n}/timeline`). Returns the MOST RECENT `labeled` event for
 * the label — a re-applied label reflects the latest promoter. undefined when
 * the read fails or no such event exists. `label` is the promoter label the
 * claim was selected under (`ready-for-agent`, `lane:go`, `lane:scout`), so the
 * lane label's applier is the promoter analog for the isolated lanes (#2602). */
async function labelActor(ctx: GhContext, issue: number, label: string): Promise<string | undefined> {
  const repo = githubRepo(ctx);
  if (!repo) return undefined;
  try {
    const answer = await githubReadClient(ctx).conditionalPaginate<{
      event?: string;
      label?: { name?: string };
      actor?: GithubUser | null;
    }>({
      cacheKey: `gh:issue-timeline:${repo.owner}/${repo.repo}:${issue}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
      parameters: { ...repo, issue_number: issue, per_page: 100 },
      operation: { key: "api rest", budget: "rest" },
      actor: "dev:trust",
    });
    let actor: string | undefined;
    for (const event of answer.data) {
      if (event.event === "labeled" && event.label?.name === label && event.actor?.login) {
        actor = String(event.actor.login); // keep the last (most recent) match
      }
    }
    return actor;
  } catch {
    return undefined;
  }
}

/**
 * Logins of comment authors who posted an `/approve-external` marker on the issue
 * (issue #2603), de-duped, most-recent-last. A best-effort read: `[]` on any gh
 * failure so the external-origin gate degrades to "unapproved" (held) rather than
 * waving an external issue through. The marker must appear as the FIRST token of a
 * line (a leading command, not merely quoted inside prose the author is discussing).
 * Trust of each returned login is decided by the caller through `resolveActorTrust`.
 */
export async function externalApprovalActors(ctx: GhContext, issue: number): Promise<string[]> {
  const repo = githubRepo(ctx);
  if (!repo) return [];
  try {
    const answer = await githubReadClient(ctx).conditionalPaginate<{
      body?: string;
      user?: GithubUser | null;
    }>({
      cacheKey: `gh:issue-comments:${repo.owner}/${repo.repo}:${issue}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      parameters: { ...repo, issue_number: issue, per_page: 100 },
      operation: { key: "api rest", budget: "rest" },
      actor: "dev:trust",
    });
    const seen = new Set<string>();
    const actors: string[] = [];
    for (const comment of answer.data) {
      const login = authorLogin(comment.user) ?? "";
      if (!login || !commentBearsApprovalMarker(comment.body ?? "")) continue;
      if (seen.has(login)) continue;
      seen.add(login);
      actors.push(login);
    }
    return actors;
  } catch {
    return [];
  }
}

/** True when a comment body carries the `/approve-external` marker as the leading
 * token of some line — a deliberate command, not the string quoted inside prose. */
function commentBearsApprovalMarker(body: string): boolean {
  for (const rawLine of body.split("\n")) {
    if (rawLine.trim().startsWith(EXTERNAL_APPROVAL_MARKER)) return true;
  }
  return false;
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
 * A one-off call is one independent evaluation. Callers judging several actors
 * together use {@link createActorTrustLookup} so those actors share one
 * CODEOWNERS resolution without carrying it into a later evaluation.
 */
export async function actorTrustSignals(
  ctx: GhContext,
  actor: string,
): Promise<{ hasWriteAccess?: boolean; inCodeowners?: boolean }> {
  return createActorTrustLookup(ctx)(actor);
}

/**
 * Bind one trust evaluation to a repository context. CODEOWNERS is resolved at
 * most once per repository for the returned lookup, including a definitive
 * absence, and is forgotten when the caller releases the lookup.
 */
export function createActorTrustLookup(
  ctx: GhContext,
): (actor: string) => Promise<{ hasWriteAccess?: boolean; inCodeowners?: boolean }> {
  const codeownersByRepo = new Map<string, Promise<string | null | undefined>>();
  return (actor) => actorTrustSignalsInEvaluation(ctx, actor, codeownersByRepo);
}

async function actorTrustSignalsInEvaluation(
  ctx: GhContext,
  actor: string,
  codeownersByRepo: Map<string, Promise<string | null | undefined>>,
): Promise<{ hasWriteAccess?: boolean; inCodeowners?: boolean }> {
  const [hasWriteAccess, inCodeowners] = await Promise.all([
    actorWriteAccess(ctx, actor),
    actorInCodeowners(ctx, actor, codeownersByRepo),
  ]);
  return { hasWriteAccess, inCodeowners };
}

/** Permission levels at or above repository write access. */
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/** `gh api repos/{owner}/{repo}/collaborators/{actor}/permission` → true when the
 * actor's permission is write-or-higher. undefined on a transient/auth failure;
 * a definitive 404 (not a collaborator) resolves to `false`. */
async function actorWriteAccess(ctx: GhContext, actor: string): Promise<boolean | undefined> {
  const repo = githubRepo(ctx);
  if (!repo) return undefined;
  try {
    const answer = await githubReadClient(ctx).conditionalRest<{ permission?: string }>({
      cacheKey: `gh:collaborator-permission:${repo.owner}/${repo.repo}:${actor}`,
      route: "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      parameters: { ...repo, username: actor },
      operation: { key: "api rest", budget: "rest" },
      actor: "dev:trust",
    });
    const permission = String(answer.data.permission ?? "").trim().toLowerCase();
    return permission === "" ? undefined : WRITE_PERMISSIONS.has(permission);
  } catch (error) {
    return errorStatus(error) === 404 ? false : undefined;
  }
}

/** The GitHub-recognised CODEOWNERS locations, in resolution order. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** Read the first CODEOWNERS location that resolves. `null` when every
 * recognised location answered a definitive 404, `undefined` when no read
 * succeeded (transient/auth). */
async function readRepoCodeowners(
  ctx: GhContext,
  repo: { owner: string; repo: string },
): Promise<string | null | undefined> {
  let sawDefinitiveMiss = false;
  for (const path of CODEOWNERS_PATHS) {
    try {
      const answer = await githubReadClient(ctx).conditionalRest<string>({
        cacheKey: `gh:codeowners:${repo.owner}/${repo.repo}:${path}`,
        route: "GET /repos/{owner}/{repo}/contents/{path}",
        parameters: { ...repo, path, mediaType: { format: "raw" } },
        operation: { key: "api rest", budget: "rest" },
        actor: "dev:trust",
      });
      return String(answer.data ?? "");
    } catch (error) {
      if (errorStatus(error) === 404) {
        sawDefinitiveMiss = true;
        continue; // this location is absent; try the next one
      }
      return undefined; // transient/auth failure — signal not available
    }
  }
  return sawDefinitiveMiss ? null : undefined;
}

/** Resolve whether `@actor` is an owner token in the repo CODEOWNERS file.
 * undefined when no read succeeded (transient/auth) and `false` when a file was
 * read but the actor is absent (or no CODEOWNERS exists at all). */
async function actorInCodeowners(
  ctx: GhContext,
  actor: string,
  codeownersByRepo: Map<string, Promise<string | null | undefined>>,
): Promise<boolean | undefined> {
  const repo = githubRepo(ctx);
  if (!repo) return undefined;
  const key = `${repo.owner}/${repo.repo}`;
  let pending = codeownersByRepo.get(key);
  if (pending === undefined) {
    pending = readRepoCodeowners(ctx, repo);
    codeownersByRepo.set(key, pending);
  }
  const content = await pending;
  if (content === undefined) {
    codeownersByRepo.delete(key); // an unavailable signal is not an answer to keep
    return undefined;
  }
  return content === null ? false : codeownersHasOwner(content, actor);
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
