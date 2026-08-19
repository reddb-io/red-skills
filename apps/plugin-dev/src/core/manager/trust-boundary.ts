// core/manager/trust-boundary.ts — the Manager trust boundary
// (Spec #2290, slice #2296; architecture in ADR 0109).
//
// One rule, stated once and enforced at one seam: a DIRECTIVE may only arrive
// from the local operator session or an owning HITL workflow. Everything the
// tracker holds — issue bodies, comments, PR descriptions, review text — is
// EVIDENCE. Evidence informs the brief; it never changes intent, authority, or
// dispatch.
//
// Author association does not promote evidence. An `OWNER` comment and an
// anonymous one carry the same trust, because the tracker is a public,
// forgeable-by-anyone-with-write channel: privilege there says who typed the
// text, never that the text was addressed to this Manager session. Treating
// OWNER content as a directive is exactly the prompt-injection path this
// boundary exists to close.
//
// Classification is intentionally origin-based, not content-based: no regex
// hunts for "instructions" in a comment. Content inspection is a filter that
// always loses; provenance is a property that cannot be typed into an issue.

import { ManagerStoreError } from "./effort-store.js";

/** Where a would-be directive reached the Manager from. */
export type DirectiveOrigin =
  /** The local operator, through the active Manager liaison session. */
  | "operator-session"
  /** An owning HITL workflow acting on a recorded human decision. */
  | "hitl-workflow"
  /** A tracker issue body — evidence. */
  | "tracker-issue"
  /** A tracker comment, at any author association — evidence. */
  | "tracker-comment"
  /** A pull-request body, review, or review comment — evidence. */
  | "tracker-pr"
  /** Provenance could not be established — treated exactly like tracker content. */
  | "unknown";

/**
 * The only two origins authorised to issue a directive (ADR 0109). Anything
 * absent from this list is evidence — including `unknown`, because an origin
 * this module cannot name is an origin it cannot vouch for.
 */
export const TRUSTED_ORIGINS: readonly DirectiveOrigin[] = ["operator-session", "hitl-workflow"];

/** True only for an origin authorised to issue directives. */
export function isTrustedOrigin(origin: DirectiveOrigin): boolean {
  return TRUSTED_ORIGINS.includes(origin);
}

/** Raised when a mutation was requested from an origin that may not direct. */
export class ManagerTrustBoundaryError extends ManagerStoreError {}

/**
 * Gate one mutating operation on its provenance. Every Manager write passes
 * through here, so "tracker content is never executable" is a property of the
 * command surface rather than a discipline each subcommand has to remember.
 */
export function assertTrustedDirective(origin: DirectiveOrigin, operation: string): void {
  if (isTrustedOrigin(origin)) return;
  throw new ManagerTrustBoundaryError(
    `refusing "${operation}": directives from ${origin} are untrusted evidence, not commands; ` +
      "only the local operator session or an owning HITL workflow may direct the Manager",
  );
}

/**
 * Classify a tracker comment. The author association is accepted so callers can
 * record it as evidence metadata — it is deliberately NOT consulted, so no
 * privilege level can turn a comment into a directive.
 */
export function classifyCommentOrigin(comment: { author_association?: string }): DirectiveOrigin {
  void comment;
  return "tracker-comment";
}

/** Classify an issue body. Always evidence, whoever opened the issue. */
export function classifyIssueBodyOrigin(): DirectiveOrigin {
  return "tracker-issue";
}

/** Classify PR content — body, review, or review comment. Always evidence. */
export function classifyPullRequestOrigin(): DirectiveOrigin {
  return "tracker-pr";
}

/**
 * Tracker content, carried in a shape that cannot be mistaken for a directive.
 * `trusted` is the literal `false`, so a value that reaches a directive-typed
 * parameter fails to type-check rather than failing at review time.
 */
export interface UntrustedEvidence {
  readonly trusted: false;
  readonly origin: DirectiveOrigin;
  /** Recorded for the brief; never consulted when deciding trust. */
  readonly author_association: string;
  readonly text: string;
}

/**
 * Wrap tracker content as evidence. Refuses a trusted origin, because operator
 * or HITL input is a directive — mislabelling it as evidence would silently
 * discard the one channel that is allowed to act.
 */
export function asUntrustedEvidence(
  origin: DirectiveOrigin,
  text: string,
  authorAssociation = "NONE",
): UntrustedEvidence {
  if (isTrustedOrigin(origin)) {
    throw new ManagerTrustBoundaryError(
      `${origin} content is a directive channel, not evidence`,
    );
  }
  return { trusted: false, origin, author_association: authorAssociation, text };
}
