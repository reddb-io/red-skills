import { LABEL_READY } from "../../core/triage-labels.js";
import { classifySourceTrust, type SourceTrustLevel } from "../../core/source-trust.js";
import type { RepoVisibility } from "../../core/trust-gate.js";
import { apiPath, repoArgs, runGh, type GhContext } from "./common.js";

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

/** Read the login of the actor who applied `label` from the issue timeline
 * (REST `…/issues/{n}/timeline`). Returns the MOST RECENT `labeled` event for
 * the label — a re-applied label reflects the latest promoter. undefined when
 * the read fails or no such event exists. `label` is the promoter label the
 * claim was selected under (`ready-for-agent`, `lane:go`, `lane:scout`), so the
 * lane label's applier is the promoter analog for the isolated lanes (#2602). */
async function labelActor(ctx: GhContext, issue: number, label: string): Promise<string | undefined> {
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
      if (e.event === "labeled" && e.label?.name === label && e.actor?.login) {
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
