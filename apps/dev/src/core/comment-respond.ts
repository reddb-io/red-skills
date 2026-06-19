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
