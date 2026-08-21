/**
 * land-precondition — the ledger side of ADR 0154's land rule (#4138).
 *
 * `@reddb-io/shared/land-verdict.js` owns the QUESTION every land entry point
 * asks; this module owns the ANSWER, because answering means reading the
 * verdicts lane and the lane is runtime state. The split is what lets the
 * engine's merge driver and the Worker's land request hold the same gate
 * without either of them learning where a project keeps its `.red/`.
 *
 * ## What "fresh" means, exactly
 *
 * A row authorizes a merge when it is the STANDING row for the head being
 * merged and its verdict is a passing one. Three things follow, and each is a
 * refusal somebody would otherwise have argued their way past:
 *
 *   - **A voided row authorizes nothing.** Supersession is an appended `voided`
 *     row (#4131), so a key whose last word was a void has no standing verdict
 *     at all — not a weaker one.
 *   - **A judgement at another head is not a judgement at this head.** That is
 *     the entire gap ADR 0154 closes: the branch moved between gate-green and
 *     merge. The single forgiven divergence is a clean rebase, which the stable
 *     patch id proves, exactly as {@link staleHeadVerdict} forgives it.
 *   - **A stale row is VOIDED on the way to the refusal.** A ledger that keeps
 *     quietly offering a superseded authorization is one the next pass lands
 *     on; appending the void is what routes the branch to re-review instead.
 *
 * `verifier-failed` and `verifier-blocked` refuse under their own names rather
 * than collapsing into "no verdict", because a reviewer that RAN and refused is
 * work for the implementer while a reviewer that could not run is a runner to
 * repair — and #4137 writes both.
 */
import {
  allowLand,
  refuseLand,
  type LandSubject,
  type LandVerdictDecision,
  type LandVerdictGate,
} from "@reddb-io/shared/land-verdict.js";
import type { Exec } from "./merge.js";
import { resolveRemoteBranchTip, stablePatchId, staleHeadVerdict } from "./stale-head.js";
import {
  humanVerifierIdentity,
  standingVerdicts,
  verdictKeyOf,
  type VerdictAppendInput,
  type VerdictKey,
  type VerdictName,
  type VerdictRow,
  type VerdictVoidInput,
} from "./verdict-ledger.js";

/**
 * The verdicts that AUTHORIZE a merge. Narrower than {@link VerdictName} on
 * purpose: the two names this list omits are the two a verifier writes when it
 * did not approve, and a land precondition that accepted them would be reading
 * "the reviewer answered" as "the reviewer said yes".
 */
export const LAND_PASSING_VERDICTS: readonly VerdictName[] = [
  "live-verified",
  "test-verified",
  "type-check-only",
];

/** True when a verdict name authorizes a merge. PURE. */
export function isPassingVerdict(verdict: VerdictName): boolean {
  return LAND_PASSING_VERDICTS.includes(verdict);
}

/**
 * What the ledger says about one head, plus the row a refusal must supersede.
 *
 * The void is reported rather than performed so the rule stays pure: the same
 * decision drives a unit test with no filesystem and the live gate that appends.
 */
export interface LandVerdictJudgement {
  readonly decision: LandVerdictDecision;
  /**
   * The standing row this landing invalidates — a passing judgement of a
   * DIFFERENT head — which the gate voids before refusing. Null when nothing
   * stands to supersede.
   */
  readonly supersede: VerdictRow | null;
}

function subjectOf(key: VerdictKey): LandSubject {
  return { kind: "head", headSha: key.head_sha };
}

/**
 * Judge one head against every row the ledger holds. PURE.
 *
 * The order is the rule read top to bottom: the exact key first, then the
 * clean-rebase equivalence, then the stale judgement that must be voided, then
 * the absence.
 */
export function decideLandVerdict(
  rows: readonly VerdictRow[],
  key: VerdictKey,
): LandVerdictJudgement {
  const subject = subjectOf(key);
  const forPr = rows.filter((row) => row.pr === key.pr);
  const standing = standingVerdicts(forPr);
  const exact = standing.get(verdictKeyOf(key));

  if (exact?.standing) {
    const row = exact.standing;
    if (isPassingVerdict(row.verdict)) {
      return { decision: allowLand("head-sha", row.verdict, row.verifier_identity), supersede: null };
    }
    const reason = row.verdict === "verifier-failed" ? "verifier-failed" : "verifier-blocked";
    return { decision: refuseLand(reason, subject, row.reason ?? undefined), supersede: null };
  }
  if (exact) {
    const voided = exact.voidedBy;
    return {
      decision: refuseLand("voided-verdict", subject, voided?.reason ?? undefined),
      supersede: null,
    };
  }

  const passing = [...standing.values()]
    .map((entry) => entry.standing)
    .filter((row): row is VerdictRow => row !== null && isPassingVerdict(row.verdict));
  const rebased = passing.find((row) => row.patch_id === key.patch_id);
  if (rebased) {
    return {
      decision: allowLand("patch-id", rebased.verdict, rebased.verifier_identity),
      supersede: null,
    };
  }
  const stale = passing[passing.length - 1];
  if (stale) {
    return {
      decision: refuseLand("stale-verdict", subject, `judged at ${stale.head_sha.slice(0, 12)}`),
      supersede: stale,
    };
  }
  return { decision: refuseLand("no-verdict", subject), supersede: null };
}

/** The slice of the ledger a gate needs: read every row, void a stale one. */
export interface LandVerdictLedger {
  read(): Promise<VerdictRow[]>;
  void(input: VerdictVoidInput): Promise<VerdictRow>;
  append(input: VerdictAppendInput): Promise<VerdictRow>;
}

export interface LedgerLandVerdictGateDeps {
  readonly ledger: LandVerdictLedger;
  /**
   * Turn the subject an entry point holds into the `(pr, head_sha, patch_id)`
   * triple the ledger is keyed by. The entry points genuinely know different
   * halves — a local landing has the object name and no pull request, the merge
   * driver has the pull request and lets the forge name the head — so resolving
   * the missing half is the arranger's job, not the rule's. `null` is a subject
   * nobody could pin, which refuses.
   */
  resolveKey(subject: LandSubject): Promise<VerdictKey | null>;
}

/**
 * The ledger-backed gate every enumerated entry point holds.
 *
 * It VOIDS before it refuses. A stale passing row left standing is an
 * authorization the next pass would find just as valid, so the refusal and the
 * supersession are one act — that is the "mismatch appends `voided` and routes
 * to re-review" clause of ADR 0154, and it is why this is not a pure read.
 */
export function createLedgerLandVerdictGate(deps: LedgerLandVerdictGateDeps): LandVerdictGate {
  return {
    async check(subject) {
      const key = await deps.resolveKey(subject);
      if (key === null) return refuseLand("unresolvable-head", subject);
      const judged = decideLandVerdict(await deps.ledger.read(), key);
      if (judged.supersede) {
        await deps.ledger.void({
          pr: judged.supersede.pr,
          head_sha: judged.supersede.head_sha,
          patch_id: judged.supersede.patch_id,
          verdict: judged.supersede.verdict,
          verifier_identity: judged.supersede.verifier_identity,
          reason: `superseded: the landing head moved to ${key.head_sha.slice(0, 12)}, which this row never judged`,
        });
      }
      return judged.decision;
    },
  };
}

/**
 * The human adoption row (ADR 0154, user story 9).
 *
 * A maintainer who adopts a branch by hand is a legitimate lander, and the
 * naive reading of "no land without a verdict" bricks exactly that path. The
 * answer is not an exemption — an exemption is a hole nothing audits — but a
 * ROW: the human signs `human:<login>`, the no-self-landing invariant holds
 * because a human is not the implementing agent, and the morning audit reads
 * who adopted what instead of inferring it from a merge commit.
 */
export async function recordHumanAdoptionVerdict(
  ledger: Pick<LandVerdictLedger, "append">,
  input: {
    readonly key: VerdictKey;
    readonly login: string;
    readonly evidence?: string | null;
    readonly reason?: string;
  },
): Promise<VerdictRow> {
  return ledger.append({
    ...input.key,
    verdict: "live-verified",
    verifier_identity: humanVerifierIdentity(input.login),
    evidence: input.evidence ?? null,
    reason:
      input.reason ??
      "a human adopted the branch by hand and lands under their own name (ADR 0154)",
  });
}

/** The adopt lane's ledger and gate, carried as one dep so neither arrives alone. */
export interface AdoptionVerdictDeps {
  readonly ledger: LandVerdictLedger;
  readonly gate: LandVerdictGate;
}

/**
 * Record the adopting human's row for a branch tip, resolving the key the
 * ledger needs from git. Returns null when the caller supplied no adopting
 * human — an autonomous reconcile is not an adoption and must not sign one.
 *
 * When git cannot answer the stable patch id the row is pinned to the head
 * alone (`head:<sha>`), because a row that names the head it judged is still
 * an audit trail while a row with no key at all is nothing.
 */
export async function recordAdoptionVerdict(
  deps: AdoptionVerdictDeps | undefined,
  input: {
    readonly exec: Exec;
    readonly repoDir: string;
    readonly baseRef: string;
    readonly tip: string;
    readonly login?: string;
    readonly pr?: number;
    readonly evidence?: string;
  },
): Promise<VerdictRow | null> {
  if (!deps || input.login === undefined || input.pr === undefined) return null;
  const patchId = await stablePatchId(input.exec, input.repoDir, input.baseRef, input.tip);
  return recordHumanAdoptionVerdict(deps.ledger, {
    key: { pr: input.pr, head_sha: input.tip, patch_id: patchId ?? `head:${input.tip}` },
    login: input.login,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
}

/** Why a landing refused before it merged anything: the head, or its judgement. */
export interface LandHeadRefusal {
  readonly reason: "stale-head" | "unverified-head";
  readonly message: string;
}

export interface LandHeadPreconditionInput {
  readonly repoDir: string;
  readonly remote: string;
  readonly branch: string;
  readonly base: string;
  readonly intentBaseRef?: string;
  /** The gate-validated worker tip, when the caller pinned one (#4134). */
  readonly validatedBranchTip?: string;
}

/**
 * The two questions a landing must answer before it merges, in one call: is
 * this the head the gate validated (#4134), and did anyone judge it (#4138)?
 *
 * They are one precondition because they fail for one reason — the tree being
 * merged is not the tree that was judged — and a caller that asked only the
 * first would refuse a moved head while merrily merging an unjudged one.
 *
 * An absent gate leaves the verdict question unasked. That is not a silent
 * skip: the enumeration in `land-entry-points.ts` names every caller and the
 * ratchet pins which of them supply one, so an unarmed entry point is a
 * declared fact rather than an accident nobody can see.
 */
export async function landHeadPrecondition(
  exec: Exec,
  input: LandHeadPreconditionInput,
  gate?: LandVerdictGate,
): Promise<LandHeadRefusal | null> {
  const { repoDir, remote, branch, base, intentBaseRef, validatedBranchTip } = input;
  if (validatedBranchTip) {
    const verdict = await staleHeadVerdict(exec, {
      repoDir, remote, branch, base, validatedBranchTip,
      ...(intentBaseRef == null ? {} : { intentBaseRef }),
    });
    if (verdict.stale) return { reason: "stale-head", message: verdict.message };
  }
  if (!gate) return null;
  const head = validatedBranchTip ??
    (await resolveRemoteBranchTip(exec, { repo: repoDir, remote, branch }));
  const subject: LandSubject = head
    ? { kind: "head", headSha: head }
    : { kind: "head", headSha: "0000000" };
  const decision = head
    ? await gate.check(subject)
    : refuseLand("unresolvable-head", subject, `${remote}/${branch} resolved to nothing`);
  return decision.allowed ? null : { reason: "unverified-head", message: decision.message };
}
