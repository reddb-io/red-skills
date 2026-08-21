/**
 * verify-labels — how much verification a Ticket's land requires, declared at
 * triage (ADR 0156 §2, Spec #4164, Ticket #4174).
 *
 * ADR 0154 made every land conditional on a Countersign and applied ONE bar to
 * all of them. That prices a mechanical one-liner at the same full review as a
 * behavioural change, and a bar nobody can move is a bar somebody eventually
 * routes around. ADR 0156 makes the bar selective — and puts the choice in a
 * place that cannot be the author: a **triage human** stamps a `verify:<value>`
 * label, and the label names the minimum Countersign class the land requires.
 *
 * Three things about that sentence are load-bearing, and each is a failure mode
 * somebody would otherwise have argued their way into:
 *
 *   - **The label is the authorization, never the author's opinion.** Neither a
 *     daemon heuristic over the diff nor an implementer's self-declaration may
 *     pick the class. The whole point of ADR 0154 is that the identity judging
 *     the change is not the identity that wrote it; a discount the writer grants
 *     itself reinstates exactly what the invariant removed.
 *   - **An unlabeled Ticket fails closed.** Forgetting a label buys nothing: the
 *     default is {@link UNLABELED_VERIFY_REQUIREMENT}, ADR 0154's own bar, and
 *     it is deliberately NOT the weakest entry in the table. A default that
 *     drifted toward the discount would make the discount the silent norm.
 *   - **`verify:gate-only` is the one exemption, and it is spelled out.** It is
 *     the only requirement that admits `type-check-only` — the class the gate's
 *     own SHA-pinned row carries, signed under the implementer's identity —
 *     because a triage human judged the change mechanical. It is an exemption
 *     WITH a name, a label, and an author, which is the difference between a
 *     policy and a hole.
 *
 * The vocabulary lives in `@reddb-io/shared` for the same reason
 * `land-countersign.ts` does: five entry points in four layers ask the land
 * question, and a bar each of them spelled for itself is a bar four of them
 * would eventually spell differently. The ledger that ANSWERS the question stays
 * in the runtime layer; this module only says how strong the answer must be.
 *
 * The class names are duplicated here rather than imported because the
 * Countersign enum is runtime state's vocabulary and this package may not reach
 * it. The duplication is not left to trust: the ratchet
 * (`apps/plugin-dev/tests/verify-label-family-guard.test.ts`) pins
 * {@link COUNTERSIGN_STRENGTH_ORDER} against the live passing set in BOTH
 * directions, so a class added to one and not the other reddens rather than
 * quietly becoming a bar nothing enforces.
 */

/** The prefix every member of the family carries. */
export const VERIFY_LABEL_PREFIX = "verify:";

/** The closed family. A `verify:` label outside it is not a declaration. */
export type VerifyLabel = "verify:live" | "verify:tests" | "verify:gate-only";

/**
 * The Countersign classes that can AUTHORIZE a land, weakest first.
 *
 * Order is the whole mechanism: a requirement names a minimum, and every class
 * at or above it in this list satisfies that minimum. The two classes this list
 * omits — `verifier-failed` and `verifier-blocked` — are what a verifier writes
 * when it did NOT approve, and no label may ever raise them into a bar.
 */
export const COUNTERSIGN_STRENGTH_ORDER = [
  "type-check-only",
  "test-verified",
  "live-verified",
] as const;

export type VerifyCountersignClass = (typeof COUNTERSIGN_STRENGTH_ORDER)[number];

/** How much verification one Ticket's land requires. */
export interface VerifyRequirement {
  /** The label that declared it, or `null` for the fail-closed default. */
  readonly label: VerifyLabel | null;
  /** The weakest Countersign class this requirement admits. */
  readonly minimum: VerifyCountersignClass;
  /**
   * Every class this requirement admits, weakest first. Derived from
   * {@link minimum} by construction and written out anyway, because a reader
   * asking "does a `test-verified` row land this?" should not have to replay an
   * ordering in their head. The ratchet pins the two against each other.
   */
  readonly accepts: readonly VerifyCountersignClass[];
  /**
   * True only where the row may be the gate's OWN — signed under the
   * implementer's identity rather than by a second one. Exactly one entry in
   * the family carries it, and it is the entry a human must type.
   */
  readonly selfSignable: boolean;
  /** Why a triage human would choose this, read by the human choosing it. */
  readonly why: string;
}

/** Classes at or above `minimum`, weakest first. PURE. */
function acceptedFrom(minimum: VerifyCountersignClass): readonly VerifyCountersignClass[] {
  return COUNTERSIGN_STRENGTH_ORDER.slice(COUNTERSIGN_STRENGTH_ORDER.indexOf(minimum));
}

/** A declared member of the family: a requirement whose label is not null. */
export interface VerifyLabelDeclaration extends VerifyRequirement {
  readonly label: VerifyLabel;
}

/**
 * The declared family. One row per label, each stating the minimum it names,
 * the classes that minimum admits, whether it exempts the second identity, and
 * why a triage human would type it.
 */
export const VERIFY_LABEL_CONTRACT: readonly VerifyLabelDeclaration[] = [
  {
    label: "verify:live",
    minimum: "live-verified",
    accepts: acceptedFrom("live-verified"),
    selfSignable: false,
    why: "the change's risk is behavioural — a green suite proves the code compiles and runs, not that the behaviour a human asked for appeared; only a verifier that RAN the change may authorize it.",
  },
  {
    label: "verify:tests",
    minimum: "test-verified",
    accepts: acceptedFrom("test-verified"),
    selfSignable: false,
    why: "the change's risk is covered by the suite — a second identity reading the diff on top of a green feedback stage is the proportionate bar, and it is ADR 0154's default stated out loud so a future default cannot move it by accident.",
  },
  {
    label: "verify:gate-only",
    minimum: "type-check-only",
    accepts: acceptedFrom("type-check-only"),
    selfSignable: true,
    why: "a triage HUMAN judged the change mechanical, so it lands on the gate's own SHA-pinned row under the implementer's identity (ADR 0156 §2); this is the family's one exemption to ADR 0154's second-identity invariant, and the label is what makes it a decision somebody signed rather than a hole.",
  },
];

/** Every declared label, in contract order. */
export const VERIFY_LABELS: readonly VerifyLabel[] = VERIFY_LABEL_CONTRACT.map(
  (declaration) => declaration.label,
);

/**
 * What a Ticket carrying no `verify:` label requires: ADR 0154's own bar.
 *
 * `test-verified` rather than `type-check-only`, deliberately. A default that
 * admitted the gate's own row would hand every unlabeled Ticket the exemption
 * `verify:gate-only` exists to make a human type, which is the precise shape of
 * "forgetting a label weakens the landing invariant".
 */
export const UNLABELED_VERIFY_REQUIREMENT: VerifyRequirement = {
  label: null,
  minimum: "test-verified",
  accepts: acceptedFrom("test-verified"),
  selfSignable: false,
  why: "no triage human declared how much verification this Ticket needs, so it pays ADR 0154's full bar: a second identity judged the tree, and the gate's own row does not count.",
};

/** True for a string the closed family names. PURE. */
export function isVerifyLabel(value: unknown): value is VerifyLabel {
  return typeof value === "string" && (VERIFY_LABELS as readonly string[]).includes(value);
}

/** How strong a Countersign class is; `-1` for anything that authorizes nothing. PURE. */
export function countersignStrength(countersign: string): number {
  return (COUNTERSIGN_STRENGTH_ORDER as readonly string[]).indexOf(countersign);
}

/** The requirement one declared label names. PURE. */
export function verifyRequirementFor(label: VerifyLabel): VerifyLabelDeclaration {
  const declaration = VERIFY_LABEL_CONTRACT.find((entry) => entry.label === label);
  if (declaration === undefined) {
    throw new Error(`no verify requirement declared for ${label}`);
  }
  return declaration;
}

/**
 * The requirement a Ticket's labels declare. PURE.
 *
 * Two rules, both fail-closed. No `verify:` label at all resolves to
 * {@link UNLABELED_VERIFY_REQUIREMENT}. Several of them resolve to the
 * STRICTEST — a Ticket carrying both `verify:live` and `verify:gate-only` is a
 * triage disagreement, and reading the weaker one would let the cheapest label
 * in the set decide, which makes stamping the discount unilateral.
 */
export function resolveVerifyRequirement(
  labels: readonly string[] | undefined,
): VerifyRequirement {
  const declared = (labels ?? []).filter(isVerifyLabel).map(verifyRequirementFor);
  if (declared.length === 0) return UNLABELED_VERIFY_REQUIREMENT;
  return declared.reduce((strictest, candidate) =>
    countersignStrength(candidate.minimum) > countersignStrength(strictest.minimum)
      ? candidate
      : strictest,
  );
}

/** True when a Countersign class satisfies a requirement's minimum. PURE. */
export function countersignMeetsRequirement(
  requirement: VerifyRequirement,
  countersign: string,
): boolean {
  return (requirement.accepts as readonly string[]).includes(countersign);
}

/** How a requirement was declared, for a refusal that names the repair. PURE. */
export function describeVerifyRequirement(requirement: VerifyRequirement): string {
  return requirement.label === null
    ? "no `verify:` label, so the fail-closed default"
    : `\`${requirement.label}\``;
}

/**
 * The refusal detail when a standing Countersign sits below the declared bar,
 * or `null` when it satisfies it. One sentence, naming BOTH the bar and the row
 * that missed it, because an operator reading only "insufficient" has to go
 * find out which of the two to change. PURE.
 */
export function verifyRequirementShortfall(
  requirement: VerifyRequirement,
  countersign: string,
): string | null {
  if (countersignMeetsRequirement(requirement, countersign)) return null;
  return `${describeVerifyRequirement(requirement)} requires at least ${requirement.minimum}, the standing Countersign is ${countersign}`;
}
