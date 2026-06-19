// core/comment-respond.ts — the advisory comment responder (PRD #745, issue #750).
//
// A maintainer talks to the agent through PR/issue comments using advisory `/dev`
// verbs. A thin `issue_comment` / `pull_request_review_comment` event-router
// workflow passes the parsed event as structured flags to `dev respond`; this
// module owns all logic. It:
//
//   1. parses the `/dev` summon via the `comment-classification` seam — a comment
//      with no `/dev` verb and no @mention is IGNORED (no reply, no mutation);
//   2. authorizes the commenter through the #747 layered trust resolver — an
//      untrusted commenter is REFUSED with a clear reason and nothing else;
//   3. routes the advisory verb: `/dev explain` answers in-thread; `/dev review`
//      delegates to the #746 advisory review path.
//
// This slice ships the ADVISORY verbs only. No code is ever pushed: the only
// side effects are an in-thread reply and (for `review`) the advisory review's
// own comment/label writes. Every side effect is an injected port so the seam is
// exercised against a fake `gh`, a fake trust resolver, and a stubbed explainer.

import { parseDevDirective, type DevDirective } from "./comment-classification.js";
import type { ActorTrustVerdict } from "./trust-gate.js";
import type { AgentRunner } from "./execution.js";

/** The advisory verbs this slice honours. `fix` / `triage` are future slices. */
export const ADVISORY_VERBS = ["explain", "review"] as const;
export type AdvisoryVerb = (typeof ADVISORY_VERBS)[number];

function isAdvisoryVerb(verb: string): verb is AdvisoryVerb {
  return (ADVISORY_VERBS as readonly string[]).includes(verb);
}

/** The parsed comment event the workflow hands to `dev respond` as flags. */
export interface CommentEvent {
  /** The comment body (the summon line plus any following prose). */
  readonly body: string;
  /** The commenter's GitHub login (authorized against the trust resolver). */
  readonly author: string | undefined;
  /** The issue OR pull-request number carrying the comment thread. */
  readonly number: number;
  /** True when the thread is on a pull request (gates the `review` verb). */
  readonly isPr: boolean;
  /** The provider the advisory paths run under. */
  readonly runner: AgentRunner;
}

/** What the responder did. Exactly one terminal action per event. */
export type RespondAction = "ignored" | "refused" | "explained" | "reviewed" | "unsupported";

export interface RespondResult {
  readonly action: RespondAction;
  /** The routed verb, when a `/dev` summon was parsed. */
  readonly verb?: string;
  /** The refusal / unsupported reason, surfaced for the log and the reply. */
  readonly reason?: string;
}

/**
 * The `gh` write-back surface the responder needs. It carries a single
 * in-thread reply primitive and NO push/merge — a code push is structurally
 * impossible from this path.
 */
export interface RespondGh {
  /** Post a top-level reply on the issue/PR thread `number`. */
  reply(number: number, body: string): Promise<void>;
}

export interface RespondDeps {
  readonly gh: RespondGh;
  /** Resolve commenter trust (the #747 layered resolver, gh-backed in prod). */
  resolveTrust(actor: string | undefined): Promise<ActorTrustVerdict>;
  /** Produce the `/dev explain` answer for the event + directive. */
  explain(event: CommentEvent, directive: DevDirective): Promise<string>;
  /** Run the #746 advisory review path for the PR carrying the comment. */
  review(event: CommentEvent): Promise<void>;
  /** Bot handles whose @mention also summons the agent (besides `/dev`). */
  readonly mentions?: readonly string[];
  log?: (message: string) => void;
}

/** Prefix every agent reply so the thread reads as machine-authored. */
const REPLY_PREFIX = "🤖 ";

/** The refusal body for an untrusted commenter. */
export function refusalBody(reason: string): string {
  return (
    `${REPLY_PREFIX}\`/dev\` command refused — ${reason}. ` +
    `Only repository maintainers (write access / CODEOWNERS / trust-gate allowlist) may command the agent.`
  );
}

/** The reply naming the verbs this slice supports (unknown/unsupported verb). */
export function unsupportedBody(verb: string): string {
  const named = verb ? `\`/dev ${verb}\`` : "a bare `/dev`";
  return (
    `${REPLY_PREFIX}${named} is not an available command. ` +
    `This responder handles the advisory verbs ${ADVISORY_VERBS.map((v) => `\`/dev ${v}\``).join(" and ")}.`
  );
}

/** The reply when `/dev review` lands on an issue thread rather than a PR. */
export const REVIEW_NOT_A_PR_BODY =
  `${REPLY_PREFIX}\`/dev review\` only applies to pull requests — there is nothing to review on an issue thread.`;

/**
 * Run the advisory comment responder for one comment event. Returns the terminal
 * {@link RespondAction}; the only mutations are the in-thread reply and, for
 * `review`, the advisory review's own writes. Never pushes code.
 *
 * Precedence:
 *   1. no `/dev` summon              → ignored (NO reply, NO mutation);
 *   2. untrusted commenter           → refused (a single refusal reply, nothing else);
 *   3. `/dev explain`                → answer posted in-thread;
 *   4. `/dev review` on a PR         → delegate to the advisory review path;
 *      `/dev review` on an issue     → a one-line "PRs only" reply;
 *   5. any other `/dev` verb         → a one-line "unsupported" reply.
 */
export async function runRespond(deps: RespondDeps, event: CommentEvent): Promise<RespondResult> {
  const { gh } = deps;
  const log = deps.log ?? (() => {});

  // 1. Summon gate — ignore anything that is not a `/dev` verb or a bot @mention.
  const directive = parseDevDirective(event.body, { mentions: deps.mentions });
  if (!directive) return { action: "ignored" };

  // 2. Authorization — an untrusted commenter is refused, and nothing else happens.
  const verdict = await deps.resolveTrust(event.author);
  if (!verdict.executable) {
    const reason = verdict.reason ?? "commenter is not a repository maintainer";
    log(`[respond] refusing /dev ${directive.verb} from ${event.author ?? "(unknown)"}: ${reason}`);
    await gh.reply(event.number, refusalBody(reason));
    return { action: "refused", verb: directive.verb, reason };
  }

  // 3. Route the advisory verb.
  if (!isAdvisoryVerb(directive.verb)) {
    await gh.reply(event.number, unsupportedBody(directive.verb));
    return { action: "unsupported", verb: directive.verb };
  }

  if (directive.verb === "explain") {
    const answer = await deps.explain(event, directive);
    await gh.reply(event.number, `${REPLY_PREFIX}${answer}`);
    return { action: "explained", verb: "explain" };
  }

  // verb === "review"
  if (!event.isPr) {
    await gh.reply(event.number, REVIEW_NOT_A_PR_BODY);
    return { action: "unsupported", verb: "review", reason: "not a pull request" };
  }
  await deps.review(event);
  return { action: "reviewed", verb: "review" };
}

// ---------------------------------------------------------------------------
// The pure `/dev` verb grammar + tiered advisory/mutation decision (ADR 0064,
// PRD #745, issue #752). This IO-free decision layer is the seam the cloud
// `/dev fix` mutation path is built on: it DECIDES whether a comment ignores,
// refuses, replies (advisory), or pushes (mutate); the runtime resolves trust,
// runs the agent, and pushes via the force-with-lease helper in `runtime/git-push.ts`.
// It sits alongside `runRespond` above — its `RespondDecision` union is distinct
// from `runRespond`'s terminal-`RespondAction` string union.
// ---------------------------------------------------------------------------
//
// Two layers, both IO-free:
//
//   1. {@link parseDevVerb} — the `/dev <verb> …` grammar over a raw comment
//      body. A comment is a summon ONLY when its first non-blank line starts
//      with `/dev <verb>`; everything else is ignored. This is the seam the
//      event-router workflow funnels `issue_comment` /
//      `pull_request_review_comment` bodies through (extends the
//      `comment-classification` family).
//
//   2. {@link decideRespondAction} — the tiered-mutation decision (ADR 0064 §5,
//      §6). `fix` is the ONE verb that may push code, and only when the
//      commenter is trusted (#747, resolved upstream and passed in). Every other
//      verb is advisory (reply-only, never pushes). An untrusted commenter is
//      refused with no mutation. A non-`/dev` comment is ignored.
//
// The runtime resolves commenter trust + runs the agent + pushes; this module
// only DECIDES which of those should happen.

/** The advisory verbs (reply-only, never push) plus the single mutation verb. */
export type DevVerb = "fix" | "explain" | "review" | "triage";

/** The mutation verb — the only verb whose action may push a commit. */
export const MUTATION_VERB: DevVerb = "fix";

const KNOWN_VERBS: ReadonlySet<string> = new Set<DevVerb>(["fix", "explain", "review", "triage"]);

/** A parsed `/dev <verb> <instruction>` summon. */
export interface ParsedDevComment {
  /** The recognised verb. */
  verb: DevVerb;
  /** Everything after the verb on the summon line + any following lines, trimmed.
   * Empty string when the verb carried no trailing text. */
  instruction: string;
}

/**
 * Parse a `/dev <verb> …` summon from a comment body. Returns the parsed verb +
 * instruction, or `null` when the body is not a `/dev` summon (no verb on the
 * first non-blank line, or an unrecognised verb).
 *
 * Grammar:
 *   - The summon is recognised only on the FIRST non-blank line of the body.
 *   - That line, trimmed, must begin with `/dev` (case-insensitive) followed by
 *     whitespace and a known verb token.
 *   - The instruction is the remainder of that line after the verb, joined with
 *     every subsequent line, trimmed. (A `fix` instruction often spans lines.)
 *   - An unknown verb (`/dev frobnicate`) is NOT a summon → `null`, so the
 *     responder ignores it rather than guessing intent.
 */
export function parseDevVerb(body: string): ParsedDevComment | null {
  const lines = body.split("\n");
  let idx = 0;
  while (idx < lines.length && lines[idx]!.trim().length === 0) idx += 1;
  if (idx >= lines.length) return null;

  const first = lines[idx]!.trim();
  const match = /^\/dev\s+(\S+)\s*(.*)$/i.exec(first);
  if (!match) return null;

  const verb = match[1]!.toLowerCase();
  if (!KNOWN_VERBS.has(verb)) return null;

  const rest = [match[2] ?? "", ...lines.slice(idx + 1)].join("\n").trim();
  return { verb: verb as DevVerb, instruction: rest };
}

/** The commenter-trust input resolved upstream (#747: CODEOWNERS / write-access
 * base + allowlist override). `reason` explains a refusal for the audit reply. */
export interface CommenterTrust {
  trusted: boolean;
  reason?: string;
}

/** The decided action. Exactly one `kind` is a mutation (`mutate`) — the single
 * surface that needs `contents: write`. */
export type RespondDecision =
  | { kind: "ignore" }
  | { kind: "refuse"; reason: string }
  | { kind: "advisory"; verb: DevVerb; instruction: string }
  | { kind: "mutate"; instruction: string };

/**
 * Decide what the responder does for a comment. The two gates are EXPLICIT-VERB
 * and TRUST (ADR 0064 §5–§7):
 *
 *   - No `/dev` summon            → ignore (no reply, no push).
 *   - Untrusted commenter         → refuse (no push), regardless of verb.
 *   - Trusted + `fix`             → mutate (run agent, push via force-with-lease).
 *   - Trusted + any other verb    → advisory (reply-only, never pushes).
 *
 * `mutate` is the ONLY arm that pushes code, so it is the only path a workflow
 * needs to grant `contents: write` for. Every advisory verb — and every refusal
 * and ignore — is push-free by construction.
 */
export function decideRespondAction(body: string, trust: CommenterTrust): RespondDecision {
  const parsed = parseDevVerb(body);
  if (!parsed) return { kind: "ignore" };

  if (!trust.trusted) {
    const why = trust.reason ?? "not a trusted maintainer";
    return {
      kind: "refuse",
      reason: `\`/dev ${parsed.verb}\` refused — ${why}. No changes were made.`,
    };
  }

  if (parsed.verb === MUTATION_VERB) {
    return { kind: "mutate", instruction: parsed.instruction };
  }
  return { kind: "advisory", verb: parsed.verb, instruction: parsed.instruction };
}

/** True only for the one action arm that pushes code — the `contents: write`
 * surface. A convenience for callers that gate the write permission on intent. */
export function actionPushesCode(action: RespondDecision): action is { kind: "mutate"; instruction: string } {
  return action.kind === "mutate";
}
