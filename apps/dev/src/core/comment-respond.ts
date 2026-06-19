// comment-respond — the pure `/dev` verb grammar + advisory/mutation routing
// for the cloud comment responder (ADR 0064, PRD #745).
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
export type RespondAction =
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
export function decideRespondAction(body: string, trust: CommenterTrust): RespondAction {
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
export function actionPushesCode(action: RespondAction): action is { kind: "mutate"; instruction: string } {
  return action.kind === "mutate";
}
