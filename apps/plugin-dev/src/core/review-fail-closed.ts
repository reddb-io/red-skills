// review-fail-closed — the review stage that defaults ON, fails CLOSED, and
// writes what it concluded to the verdicts ledger (ADR 0154, Spec #4129,
// Ticket #4137).
//
// The adversarial review has existed since ADR 0110 as an ADVISORY pass: off by
// default, and when on, its findings were posted and the landing continued
// regardless. That shape has one failure mode and it is silent — a reviewer
// runner that is down, a CLI that exits non-zero, an identity nobody could pin
// all produce the same observable as a clean review: nothing blocks, the branch
// lands, and the morning reads a green drain that nobody judged.
//
// ADR 0154 promotes the reviewer to the VERIFIER, so this module inverts the
// three defaults that made the silence possible:
//
//   1. **Default on.** `dev.review.enabled` ships `true`.
//   2. **Fail closed.** A reviewer exception, an unwired reviewer, or an
//      unpinnable identity is a `verifier-blocked` row and a `ready-for-human`
//      park — an outcome an operator can see, never an absence.
//   3. **Every outcome is written.** Pass, refusal and block all append one row
//      under the verifier's identity, because a ledger that records only the
//      happy path cannot answer "was this judged?".
//
// ## The deadlock the escape hatch exists for
//
// Fail-closed plus a dead reviewer runner is, by construction, a drain where
// every issue parks. That is the DESIGNED behaviour — a visible, bounded park
// beats a silent land — but it must be visible and bounded, never a loop: the
// stage runs the reviewer **exactly once**, holds no retry and no wait, and the
// park is terminal for that pass. `dev.review.mode: advisory` is the operator's
// way to keep draining while the runner is repaired; it restores the ADR 0110
// non-blocking behaviour and still writes every row, so an advisory drain is
// auditable afterwards rather than unrecorded.
//
// ## The model call is a seam, never a call from here
//
// `AdversarialReviewer` is a DECLARED seam in the sense #4171 established:
// nothing in this module reaches a model, a network or a clock, so the whole
// fail-closed decision table is reproducible from fixed inputs. The production
// wiring hands it `makeExtractAdversarialReview`'s extractor on the identity
// `resolveReviewVerifier` pinned.
//
// The Dev glossary calls the row this stage writes a **Countersign** (ADR 0156
// renames ADR 0154's noun, so that `Verdict` keeps meaning the gate's failure
// classifier of ADR 0136). The lane and its module still ship under the older
// spelling; this module speaks the surface it consumes, and the rename is one
// edit in `verdict-ledger.ts` when it comes.

import type {
  AdversarialReviewContext,
  AdversarialReviewFindings,
} from "./adversarial-review.js";
import { decideAdversarialReview } from "./adversarial-review.js";
import type { GateStageOutcome } from "./shared-gate.js";
import type { ReviewVerifier } from "./review-verifier-identity.js";
import type {
  VerdictAppendInput,
  VerdictKey,
  VerdictName,
  VerdictRow,
} from "./verdict-ledger.js";

/** What the stage's outcome is allowed to DO about a landing. */
export type ReviewMode = "blocking" | "advisory";

export const REVIEW_MODES: readonly ReviewMode[] = ["blocking", "advisory"];

/** Blocking is the shipped default, and the answer for any value we cannot read. */
export const DEFAULT_REVIEW_MODE: ReviewMode = "blocking";

/**
 * Read `dev.review.mode`. **An unrecognised value resolves to `blocking`**: the
 * escape hatch has to be typed deliberately, and a typo that silently disarmed
 * the verifier would be the exact silence this module removes. PURE.
 */
export function resolveReviewMode(get: (key: string) => string): ReviewMode {
  return get("dev.review.mode").trim().toLowerCase() === "advisory" ? "advisory" : DEFAULT_REVIEW_MODE;
}

/**
 * The verdicts a PASSING review may write. Narrower than {@link VerdictName} on
 * purpose: the pass verdict names how strong the evidence under the review was
 * (a live run, a green suite, types only), and the blocked/failed names are this
 * module's to choose, never the caller's.
 */
export type ReviewPassVerdict = "live-verified" | "test-verified" | "type-check-only";

/** A review sitting on top of a green feedback stage is test-verified. */
export const DEFAULT_REVIEW_PASS_VERDICT: ReviewPassVerdict = "test-verified";

/** The identity written when none could be pinned — never an empty field. */
export const UNPINNED_VERIFIER_IDENTITY = "unpinned";

/** What the reviewer seam produced, including the two ways it produced nothing. */
export type ReviewAttempt =
  | { readonly status: "reviewed"; readonly findings: AdversarialReviewFindings }
  | { readonly status: "threw"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string };

/** The visible park a fail-closed refusal produces. */
export interface ReviewStagePark {
  readonly label: "ready-for-human";
  readonly reason: string;
}

export interface ReviewStageDecision {
  readonly verdict: VerdictName;
  /** The identity the row is signed with. */
  readonly identity: string;
  /** This stage's contribution to the gate fold. */
  readonly stage: GateStageOutcome;
  /** Non-null only when the outcome parks the issue for a human. */
  readonly park: ReviewStagePark | null;
  /** One line naming what happened, written verbatim into the row's `reason`. */
  readonly reason: string;
  /**
   * Always `false`. Stated as a field rather than left implicit because the
   * deadlock this stage risks is a RE-LOOP, and a decision that cannot say
   * "retry" is a decision no caller can build one from.
   */
  readonly retry: false;
}

export interface ReviewStageDecisionInput {
  readonly mode: ReviewMode;
  /** The pinned verifier, or `null` when no identity differs from the implementer. */
  readonly verifier: ReviewVerifier | null;
  readonly attempt: ReviewAttempt;
  readonly appraisalFloor?: number;
  readonly passVerdict?: ReviewPassVerdict;
}

const RAN_BUT_BLOCKED: GateStageOutcome = { stage: "review", ok: false };
const RAN_AND_PASSED: GateStageOutcome = { stage: "review", ok: true };
const NOTHING_RAN: GateStageOutcome = { stage: "review", ok: true, skipped: true };

/**
 * Turn one reviewer attempt into a verdict, a gate stage outcome and — when the
 * mode is blocking and the verifier could not conclude — a park. PURE.
 *
 * The table, in full:
 *
 * | attempt | blocking | advisory |
 * | --- | --- | --- |
 * | no verifier identity | `verifier-blocked`, stage BLOCKS, park | `verifier-blocked`, stage skipped |
 * | reviewer threw / unwired | `verifier-blocked`, stage BLOCKS, park | `verifier-blocked`, stage skipped |
 * | reviewer refused the diff | `verifier-failed`, stage BLOCKS, no park | `verifier-failed`, stage passes |
 * | reviewer passed the diff | the pass verdict, stage passes | same |
 *
 * A reviewer that RAN and refused does not park: a blocking finding is work for
 * the implementer, which the Re-seed budget already routes, and parking it would
 * hand a human the one case the loop can fix by itself.
 */
export function decideReviewStage(input: ReviewStageDecisionInput): ReviewStageDecision {
  const blocking = input.mode === "blocking";
  const verifier = input.verifier;
  if (verifier === null) {
    return blockedDecision(
      UNPINNED_VERIFIER_IDENTITY,
      "no verifier identity distinct from the implementer could be pinned",
      blocking,
    );
  }
  if (input.attempt.status === "threw") {
    return blockedDecision(verifier.identity, `reviewer threw: ${input.attempt.detail}`, blocking);
  }
  if (input.attempt.status === "unavailable") {
    return blockedDecision(
      verifier.identity,
      `reviewer unavailable: ${input.attempt.detail}`,
      blocking,
    );
  }

  const findings = input.attempt.findings;
  const refused = decideAdversarialReview(findings, input.appraisalFloor) === "blocking";
  const passVerdict = input.passVerdict ?? DEFAULT_REVIEW_PASS_VERDICT;
  return {
    verdict: refused ? "verifier-failed" : passVerdict,
    identity: verifier.identity,
    stage: refused && blocking ? RAN_BUT_BLOCKED : RAN_AND_PASSED,
    park: null,
    reason: refused
      ? `reviewer refused the diff: ${findings.summary}`
      : `reviewer passed the diff: ${findings.summary}`,
    retry: false,
  };
}

/** The fail-closed half of the table: a verifier that could not conclude. */
function blockedDecision(
  identity: string,
  reason: string,
  blocking: boolean,
): ReviewStageDecision {
  return {
    verdict: "verifier-blocked",
    identity,
    stage: blocking ? RAN_BUT_BLOCKED : NOTHING_RAN,
    park: blocking ? { label: "ready-for-human", reason } : null,
    reason,
    retry: false,
  };
}

/**
 * The judgment step, declared as a seam. The implementation the daemon supplies
 * wraps `makeExtractAdversarialReview` on the pinned identity; nothing in this
 * package makes a model call, so every test below runs offline.
 */
export interface AdversarialReviewer {
  review(input: {
    readonly context: AdversarialReviewContext;
    readonly verifier: ReviewVerifier;
  }): Promise<AdversarialReviewFindings>;
}

/** The slice of the ledger this stage needs: one append, nothing else. */
export interface VerdictLedgerSink {
  append(input: VerdictAppendInput): Promise<VerdictRow>;
}

export interface ReviewStageDeps {
  /** `null` is an UNWIRED reviewer — a fail-closed block, not a skip. */
  readonly reviewer: AdversarialReviewer | null;
  readonly ledger: VerdictLedgerSink;
  /** Applies the park. Absent when the caller only wants the decision. */
  readonly park?: (park: ReviewStagePark) => Promise<void>;
}

export interface ReviewStageRunInput {
  /** `(pr, head_sha, patch_id)` — the exact head this verdict judges. */
  readonly key: VerdictKey;
  readonly context: AdversarialReviewContext;
  readonly mode: ReviewMode;
  readonly verifier: ReviewVerifier | null;
  readonly appraisalFloor?: number;
  readonly passVerdict?: ReviewPassVerdict;
  /** What the review cited — a gate record, a CI run. Evidence, not authorization. */
  readonly evidence?: string | null;
}

export interface ReviewStageResult {
  readonly decision: ReviewStageDecision;
  /** The row exactly as it was appended. */
  readonly row: VerdictRow;
  readonly attempt: ReviewAttempt;
}

/**
 * Call the reviewer **once**, in a try/catch, and report what came back. No
 * loop, no wait, no second chance: one attempt is what makes the fail-closed
 * park bounded, and a retry here would be the re-loop the Spec's risk
 * mitigation names by hand.
 */
async function attemptReview(
  reviewer: AdversarialReviewer | null,
  input: ReviewStageRunInput,
): Promise<ReviewAttempt> {
  if (input.verifier === null) {
    return { status: "unavailable", detail: "no verifier identity" };
  }
  if (reviewer === null) {
    return {
      status: "unavailable",
      detail: `no reviewer runner is wired for ${input.verifier.identity}`,
    };
  }
  try {
    const findings = await reviewer.review({
      context: input.context,
      verifier: input.verifier,
    });
    return { status: "reviewed", findings };
  } catch (error) {
    return { status: "threw", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run the review stage: one reviewer attempt, one verdict row, and the park when
 * the fail-closed rule demands one.
 *
 * **Exactly one row is appended on every path**, including the paths where the
 * reviewer never ran — an unrecorded refusal is indistinguishable from a review
 * that never happened, which is the whole failure this stage exists to end.
 */
export async function runReviewStage(
  input: ReviewStageRunInput,
  deps: ReviewStageDeps,
): Promise<ReviewStageResult> {
  const attempt = await attemptReview(deps.reviewer, input);
  const decision = decideReviewStage({
    mode: input.mode,
    verifier: input.verifier,
    attempt,
    ...(input.appraisalFloor === undefined ? {} : { appraisalFloor: input.appraisalFloor }),
    ...(input.passVerdict === undefined ? {} : { passVerdict: input.passVerdict }),
  });
  const row = await deps.ledger.append({
    ...input.key,
    verdict: decision.verdict,
    verifier_identity: decision.identity,
    evidence: input.evidence ?? null,
    reason: decision.reason,
  });
  if (decision.park !== null) await deps.park?.(decision.park);
  return { decision, row, attempt };
}
