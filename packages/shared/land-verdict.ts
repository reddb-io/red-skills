/**
 * land-verdict — the one question every land entry point asks before it merges.
 *
 * ADR 0154's land precondition is a single sentence: **no land without a
 * non-voided passing verdict matching the head actually being merged.** The
 * sentence is easy; the failure mode is that there is no single place that says
 * it. A merge happens in five places — the AFK lifecycle landing, the merge
 * driver, the land tool, the ACP land method, and reconcile/adopt-branch — and
 * they sit in four different layers. A rule each of them spells for itself is a
 * rule four of them will eventually spell differently.
 *
 * So the VOCABULARY lives here, in the lowest layer everything can reach: the
 * refusal reasons, the subject a gate is asked about, the decision it answers
 * with, and the port through which an entry point asks. The ledger-backed
 * implementation cannot live here — the verdicts lane is runtime state and this
 * package may reach nothing above it — so it stays in the runtime layer and
 * arrives as {@link LandVerdictGate}. That split is deliberate: the engine and
 * the daemon get the question without inheriting the store.
 *
 * There is deliberately NO "unknown" or "skip" outcome. A gate that cannot
 * answer refuses, because the whole point of ADR 0154 is that an absence of
 * judgement stopped being indistinguishable from a passing one.
 */

/**
 * Why a landing was refused. The list is closed, and every entry names a
 * DIFFERENT repair — an operator reading `stale-verdict` re-reviews, one
 * reading `verifier-blocked` repairs the reviewer runner, and collapsing the
 * two into "unverified" would send both to the wrong place.
 */
export type LandRefusalReason =
  /** The ledger holds no row for this head at all — nobody judged it. */
  | "no-verdict"
  /** A row stood and was superseded by a `voided` row; the key's last word was a void. */
  | "voided-verdict"
  /** The only passing rows judge a DIFFERENT head whose change is not equivalent. */
  | "stale-verdict"
  /** A verifier ran and refused the change. Work for the implementer, not a park. */
  | "verifier-failed"
  /** A verifier could not conclude — runner down, unwired, identity unpinnable. */
  | "verifier-blocked"
  /** The entry point could not even name the head it was about to merge. */
  | "unresolvable-head";

export const LAND_REFUSAL_REASONS: readonly LandRefusalReason[] = [
  "no-verdict",
  "voided-verdict",
  "stale-verdict",
  "verifier-failed",
  "verifier-blocked",
  "unresolvable-head",
];

/**
 * What a gate is asked about. Two shapes, because the entry points genuinely
 * know different things: a local landing holds the object name it is about to
 * merge and no pull request yet, while the merge driver holds a pull request
 * number and lets the forge tell it what the head is.
 */
export type LandSubject =
  | { readonly kind: "head"; readonly headSha: string }
  | { readonly kind: "pull-request"; readonly pr: number };

/**
 * How a standing verdict was matched to the head being merged.
 *
 * `patch-id` is the ONE forgiven divergence: a clean rebase moves the validated
 * change without editing it, so the stable patch id over the base is the same
 * and the judgement still applies. Anything else is a different tree.
 */
export type LandVerdictMatch = "head-sha" | "patch-id";

export type LandVerdictDecision =
  | {
      readonly allowed: true;
      readonly matchedBy: LandVerdictMatch;
      /** The verdict name the standing row carried. */
      readonly verdict: string;
      /** `<runner>:<model>` or `human:<login>` — who signed it. */
      readonly identity: string;
    }
  | {
      readonly allowed: false;
      readonly reason: LandRefusalReason;
      /** Actionable refusal text: what was refused, and what repairs it. */
      readonly message: string;
    };

/**
 * The port an entry point holds. One method, one question, no escape hatch —
 * a caller that wants to land asks, and a gate that cannot answer refuses.
 */
export interface LandVerdictGate {
  check(subject: LandSubject): Promise<LandVerdictDecision>;
}

/** Name a subject in one phrase, so every refusal says what it refused. PURE. */
export function describeLandSubject(subject: LandSubject): string {
  return subject.kind === "head"
    ? `head ${subject.headSha.slice(0, 12)}`
    : `pull request ${subject.pr}`;
}

/**
 * The one refusal sentence per reason. Written once here rather than at each
 * entry point, because five spellings of one repair drift into five different
 * repairs — the same reason `canonicalInvocation` exists for operator hints.
 * PURE.
 */
export function landRefusalMessage(
  reason: LandRefusalReason,
  subject: LandSubject,
  detail?: string,
): string {
  const where = describeLandSubject(subject);
  const tail = detail && detail.trim() !== "" ? ` (${detail.trim()})` : "";
  switch (reason) {
    case "no-verdict":
      return `the verdicts ledger holds no verdict for ${where}${tail} — ADR 0154 lets nothing merge that no identity other than the implementer judged; run the review stage against this head, then land`;
    case "voided-verdict":
      return `the verdict for ${where} was voided${tail} — a superseded judgement authorizes nothing; re-review at this head, then land`;
    case "stale-verdict":
      return `${where} is judged only at another head whose change is not equivalent${tail} — the stale row was voided; re-review at this head, then land`;
    case "verifier-failed":
      return `the verifier refused ${where}${tail} — a refusal is work for the implementer, not a merge; address the finding and publish a new head`;
    case "verifier-blocked":
      return `the verifier could not conclude on ${where}${tail} — repair the reviewer runner (or set \`dev.review.mode: advisory\` while you do), then re-review`;
    case "unresolvable-head":
      return `the landing could not name the head it was about to merge for ${where}${tail} — a verdict cannot be matched to a head nobody resolved, so nothing merges`;
  }
}

/** Build the refusal every entry point returns, on the one refusal sentence. PURE. */
export function refuseLand(
  reason: LandRefusalReason,
  subject: LandSubject,
  detail?: string,
): LandVerdictDecision {
  return { allowed: false, reason, message: landRefusalMessage(reason, subject, detail) };
}

/** Build the authorization a standing passing row grants. PURE. */
export function allowLand(
  matchedBy: LandVerdictMatch,
  verdict: string,
  identity: string,
): LandVerdictDecision {
  return { allowed: true, matchedBy, verdict, identity };
}

/** True for a value the closed refusal list names. PURE. */
export function isLandRefusalReason(value: unknown): value is LandRefusalReason {
  return typeof value === "string" && LAND_REFUSAL_REASONS.includes(value as LandRefusalReason);
}
