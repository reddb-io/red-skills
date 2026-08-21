// countersign-vocabulary-guard — the noun ADR 0156 chose, and the one the
// Wave-1 artifacts may no longer spell (issue #4172, Spec #4164).
//
// ADR 0136 owns **Verdict**: the gate's pure classifier of a failed Validation
// round. ADR 0154 then landed a verification ledger and named ITS rows verdicts
// too — two meanings for one word in one pipeline, which is how the next reader
// learns the wrong architecture. ADR 0156 settles it: the second signature is a
// **Countersign**, the lane is `.red/state/castle/countersigns.toonl`, and
// `Verdict` keeps the meaning it already had.
//
// **A RENAME NOTHING PINS IS A RENAME THAT GROWS BACK.** The whole surface is
// text: a type, a lane id, a refusal string. Nothing a type checker sees stops
// the next slice from adding `VerdictRow` beside `CountersignRow`, and the two
// would compile happily side by side while teaching opposite architectures.
//
// This is deliberately NOT a war on the word. Only the verification-ledger
// spellings are reddened, each declared beside the live word that replaced it:
// the gate's own `Verdict`, `decideVerdict`, `gateVerdict` and
// `staleHeadVerdict` are ADR 0136's vocabulary and must stay untouched, so no
// pattern here matches a bare `verdict`.
//
// It reuses `domain-vocabulary-guard`'s reader and audit rather than restating
// them, so history is kept out of the way by the same two explicit mechanisms:
// comments are stripped before matching, and every surviving literal is a
// declared allowance that only ever shrinks.
import type {
  DomainVocabularyAllowance,
  RetiredOwnershipTerm,
} from "./domain-vocabulary-guard.js";

/**
 * The trees that carry the Wave-1 verification artifacts. `packages/shared` is
 * here and absent from the ownership sweep for one reason: `land-countersign.ts`
 * — the vocabulary every land entry point asks its question in — lives there,
 * and a sweep that could not reach it would pin the answer while leaving the
 * question free to drift.
 */
export const COUNTERSIGN_VOCABULARY_ROOTS = [
  "apps/plugin-dev/src",
  "apps/redskilled/src",
  "packages/worker/src",
  "packages/protocol-acp",
  "packages/shared",
] as const;

/** The shipped skills: source for the reader who has no source. */
export const COUNTERSIGN_VOCABULARY_SKILL_ROOTS = [
  "plugins/dev/skills",
  "plugins/memory/skills",
  "plugins/brain/skills",
] as const;

/**
 * The retired verification-ledger spellings, each paired with the live word.
 *
 * Every pattern names a LEDGER surface, never the bare noun: `verdict` alone is
 * still what ADR 0136's gate classifier produces, and reddening it would rename
 * the wrong thing in the next slice.
 */
export const RETIRED_COUNTERSIGN_TERMS: readonly RetiredOwnershipTerm[] = [
  {
    term: "verdicts.toonl",
    pattern: /verdicts\.toonl/i,
    liveOwner: "the Countersign lane `.red/state/castle/countersigns.toonl`",
    why:
      "ADR 0156 renamed ADR 0154's lane before implementation, and the four-way lane" +
      " obligations — registry, writer, enforcement, census — were migrated together",
  },
  {
    term: "verdict ledger",
    pattern: /verdicts?[\s_-]*ledger/i,
    liveOwner: "the Countersign ledger (`countersign-ledger.ts`, `CountersignLedger`)",
    why:
      "the ledger records the SECOND signature on a change, which is what a Countersign is;" +
      " ADR 0136's Verdict never left the gate",
  },
  {
    term: "land verdict",
    pattern: /land[\s_-]*verdicts?/i,
    liveOwner: "the land Countersign vocabulary (`@reddb-io/shared/land-countersign.js`)",
    why:
      "the question every enumerated land entry point asks is whether a non-voided passing" +
      " Countersign matches the head being merged (ADR 0154 as amended by 0156)",
  },
  {
    term: "verdict row",
    pattern: /\bverdicts?[\s_-]*(row|key|name|standing|append|void)/i,
    liveOwner: "the Countersign row types (`CountersignRow`, `CountersignKey`, `CountersignClass`)",
    why:
      "the row, its `(pr, head_sha, patch_id)` key and its closed class enum are the Countersign's" +
      " own shape; naming them for the gate's classifier is the overload ADR 0156 removed",
  },
  {
    term: "standing verdict",
    pattern: /standing[\s_-]*verdicts?/i,
    liveOwner: "the standing Countersign (`standingCountersigns`, `CountersignStanding`)",
    why:
      "what stands for a key after every row is folded is the Countersign a merge may be" +
      " authorized on, never a gate classification",
  },
  // The three land refusal reasons, declared one at a time rather than as one
  // alternation: an operator reads the reason to know WHICH repair to run, so
  // each retired spelling names the live reason that replaced it.
  {
    term: "no-verdict",
    pattern: /\bno-verdict\b/i,
    liveOwner: "the land refusal reason `no-countersign`",
    why: "the ledger holding no row for a head means nobody countersigned it, not that a gate classified it",
  },
  {
    term: "voided-verdict",
    pattern: /\bvoided-verdict\b/i,
    liveOwner: "the land refusal reason `voided-countersign`",
    why: "supersession voids a Countersign by appending a row; the gate's classifier has nothing to void",
  },
  {
    term: "stale-verdict",
    pattern: /\bstale-verdict\b/i,
    liveOwner: "the land refusal reason `stale-countersign`",
    why: "a judgement at another head is a stale Countersign, and `staleHeadVerdict` is a different question the gate asks",
  },
] as const;

/**
 * Every live site that may still spell a retired term.
 *
 * #4172 renamed the whole Wave-1 surface rather than grandfathering any of it,
 * so the only survivor is this declaration — a guard must SPELL what it refuses.
 * The list only ever SHRINKS: an entry added to admit a new reference is the
 * regression this guard exists to refuse.
 */
export const COUNTERSIGN_VOCABULARY_ALLOWANCES: readonly DomainVocabularyAllowance[] =
  RETIRED_COUNTERSIGN_TERMS.map((term) => ({
    path: "apps/plugin-dev/src/core/countersign-vocabulary-guard.ts",
    term: term.term,
    kind: "historical" as const,
    reason: "the declaration itself — a guard must spell the phrase it refuses",
  }));
