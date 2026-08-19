// source-trust — the single source-trust taxonomy for the AFK guidance channel
// (issue #1100, parent #1099). The guidance channel is the one path rated
// EXPOSED end-to-end: any GitHub actor can drop a `<details data-kind="directive">`
// marker on an issue, and the body-shape classifier in comment-classification.ts
// happily recognises it. Classification decides SHAPE; this module decides
// AUTHORITY. Authority is granted by SOURCE, never by FORMAT — a directive marker
// alone must not confer authoritative `<human-guidance>` status.
//
// Three levels, mirroring GitHub's own author-association vocabulary plus the
// bot/app dimension:
//   - trusted    — author association OWNER / MEMBER / COLLABORATOR, a
//                  trust-gate override (allowlist / write-access / CODEOWNERS),
//                  or a per-comment maintainer 👍 promotion signal.
//   - dubious    — CONTRIBUTOR / FIRST_TIMER / FIRST_TIME_CONTRIBUTOR / NONE, or a
//                  fork-PR author without write access; the "unknown source" bucket.
//   - automation — bots and GitHub Apps (their comments never carry human authority).
//
// The trusted determination reuses the existing `resolveActorTrust` primitive
// (trust-gate.ts) rather than a divergent check: its `ActorTrustVerdict` is
// threaded in as `trustVerdict`. Crucially, the `permissive-default` basis does
// NOT promote to trusted here — permissive mode trusts everyone for EXECUTION
// gating, but the guidance channel demands a POSITIVE source signal before it
// grants authority. Only the three explicit bases (allowlist / write-access /
// codeowners) count.
//
// IO-free: the caller (the handoff comment projection) resolves author
// association, bot status, and the actor-trust verdict through gh and passes
// them in; this module only DECIDES.

import type { ActorTrustVerdict } from "./trust-gate.js";

/** The resolved source-trust level of a single comment's author. */
export type SourceTrustLevel = "trusted" | "dubious" | "automation";

/** GitHub author-association values that confer trusted authority directly,
 * without a gh trust lookup. Compared upper-cased (gh emits them upper-cased,
 * but we normalise defensively). */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** The `ActorTrustVerdict.basis` values that count as a POSITIVE trust signal for
 * the guidance channel. `permissive-default` is deliberately excluded: it means
 * "no signal available", not "trusted source". */
const TRUSTED_BASES: ReadonlySet<string> = new Set([
  "allowlist",
  "write-access",
  "codeowners",
]);

/** The signals the projection resolves for one comment before classification. */
export interface SourceTrustInput {
  /** The comment's `authorAssociation` (`gh issue view --json comments`). */
  authorAssociation?: string;
  /** True when the author is a bot / GitHub App (`author.is_bot`). */
  isBot?: boolean;
  /** The `resolveActorTrust` verdict for the author login, when resolved. Used to
   * honour the allowlist / write-access / CODEOWNERS overrides for an author whose
   * association alone does not qualify. */
  trustVerdict?: ActorTrustVerdict;
}

/**
 * Resolve a comment author's source-trust level. Precedence:
 *   1. bot / app                                   → automation
 *   2. author association OWNER/MEMBER/COLLABORATOR → trusted
 *   3. a POSITIVE trust-gate override (allowlist /
 *      write-access / codeowners)                  → trusted
 *   4. everything else                             → dubious
 *
 * Note `permissive-default` never promotes: the guidance channel requires a
 * positive source signal, not the absence of one.
 *
 * A fifth rule used to sit at position 4: a maintainer's 👍 on one comment
 * promoted that comment alone. It never fired. The field it keyed on was
 * supplied by no reader in the repository — not the jq projection it was written
 * for, and not the REST payload, which carries reaction COUNTS without the
 * reacting logins. Restoring it needs a per-comment
 * `…/comments/{id}/reactions` read, which is an N+1 on a budget-aware client;
 * that is a decision to take deliberately, not a field to leave dangling.
 */
export function classifySourceTrust(input: SourceTrustInput): SourceTrustLevel {
  if (input.isBot) return "automation";

  const association = (input.authorAssociation ?? "").trim().toUpperCase();
  if (TRUSTED_ASSOCIATIONS.has(association)) return "trusted";

  const verdict = input.trustVerdict;
  if (verdict?.executable && verdict.basis !== undefined && TRUSTED_BASES.has(verdict.basis)) {
    return "trusted";
  }

  return "dubious";
}

/**
 * Whether a resolved source-trust level grants authoritative-guidance authority.
 * Only `trusted` promotes. `undefined` is a legacy/unclassified pass-through: a
 * comment projected before source-trust existed carries no level, so it keeps
 * today's promote-on-shape behaviour — the projection always populates the level
 * going forward, so production never relies on this default.
 */
export function isTrustedSource(level: SourceTrustLevel | undefined): boolean {
  return level === undefined || level === "trusted";
}
