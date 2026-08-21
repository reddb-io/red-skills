/**
 * The `verify:<value>` family: what a Ticket's label buys, pinned in BOTH
 * directions (ADR 0156 §2, Spec #4164, issue #4174).
 *
 * Three properties are load-bearing, and each is a way the family could rot
 * into a bar nothing enforces.
 *
 *   - **The declaration and the enforced class set cover each other exactly.**
 *     `COUNTERSIGN_STRENGTH_ORDER` lives in `packages/shared` because the land
 *     question does; `LAND_PASSING_COUNTERSIGNS` lives in the runtime layer
 *     because the ledger does. Two lists of the same classes in two packages is
 *     drift waiting to happen: a class added to one becomes a bar the other has
 *     never heard of. So the suite pins them against each other, and against the
 *     live `COUNTERSIGN_CLASSES` enum, so a class outside the declaration cannot
 *     be accepted by any enforcement path.
 *   - **Every declared label maps to an enforced minimum.** A table nobody
 *     consults is green by accident, so the land decision itself is driven per
 *     label: each requirement's minimum LANDS, and the class one step below it
 *     REFUSES under `insufficient-countersign` — not under "nobody judged it",
 *     which would send the operator to the wrong repair.
 *   - **The default is fail-closed and is not the discount.** An unlabeled
 *     Ticket pays ADR 0154's bar; only `verify:gate-only` admits the gate's own
 *     `type-check-only` row, and only it is `selfSignable`. A default that
 *     drifted downward would hand every Ticket the exemption a human is supposed
 *     to type.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COUNTERSIGN_STRENGTH_ORDER,
  UNLABELED_VERIFY_REQUIREMENT,
  VERIFY_LABELS,
  VERIFY_LABEL_CONTRACT,
  VERIFY_LABEL_PREFIX,
  countersignMeetsRequirement,
  countersignStrength,
  isVerifyLabel,
  resolveVerifyRequirement,
  verifyRequirementFor,
  verifyRequirementShortfall,
  type VerifyCountersignClass,
} from "@reddb-io/shared/verify-labels.js";
import { LAND_REFUSAL_REASONS } from "@reddb-io/shared/land-countersign.js";
import { COUNTERSIGN_CLASSES, normalizeCountersignRow, type CountersignRow } from "../src/core/countersign-ledger.js";
import { LAND_PASSING_COUNTERSIGNS, decideLandCountersign } from "../src/core/land-precondition.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DOC = join(ROOT, "plugins", "dev", "skills", "engineering", "red-setup", "triage-labels.md");

const PR = 4174;
const HEAD = "c".repeat(40);
const PATCH = "d".repeat(40);
const KEY = { pr: PR, head_sha: HEAD, patch_id: PATCH };

function rowAt(countersign: string): CountersignRow {
  return normalizeCountersignRow({
    at: "2026-08-21T00:00:00.000Z",
    ...KEY,
    countersign,
    verifier_identity: "codex:gpt-5",
    voided: false,
    evidence: null,
    reason: null,
  });
}

/** The class one step weaker than `minimum`, or null when it is the weakest. */
function oneBelow(minimum: VerifyCountersignClass): VerifyCountersignClass | null {
  const index = COUNTERSIGN_STRENGTH_ORDER.indexOf(minimum);
  return index === 0 ? null : COUNTERSIGN_STRENGTH_ORDER[index - 1]!;
}

describe("the verify:<value> family, declared (#4174)", () => {
  it("declares each label once, prefixed, with a minimum it names and a reason", () => {
    expect(VERIFY_LABELS).toEqual(["verify:live", "verify:tests", "verify:gate-only"]);
    expect(new Set(VERIFY_LABELS).size).toBe(VERIFY_LABELS.length);
    for (const declaration of VERIFY_LABEL_CONTRACT) {
      expect(declaration.label.startsWith(VERIFY_LABEL_PREFIX)).toBe(true);
      expect(COUNTERSIGN_STRENGTH_ORDER).toContain(declaration.minimum);
      expect(declaration.why.trim().length).toBeGreaterThan(40);
      expect(verifyRequirementFor(declaration.label)).toBe(declaration);
    }
  });

  it("derives `accepts` from `minimum` — the readable half cannot disagree with the rule", () => {
    for (const requirement of [...VERIFY_LABEL_CONTRACT, UNLABELED_VERIFY_REQUIREMENT]) {
      const expected = COUNTERSIGN_STRENGTH_ORDER.filter(
        (klass) => countersignStrength(klass) >= countersignStrength(requirement.minimum),
      );
      expect([...requirement.accepts]).toEqual(expected);
    }
  });

  it("names exactly the classes the land precondition enforces — no bar outside the declaration", () => {
    expect([...COUNTERSIGN_STRENGTH_ORDER].sort()).toEqual([...LAND_PASSING_COUNTERSIGNS].sort());
    const refusing = COUNTERSIGN_CLASSES.filter(
      (klass) => !(COUNTERSIGN_STRENGTH_ORDER as readonly string[]).includes(klass),
    );
    expect([...refusing].sort()).toEqual(["verifier-blocked", "verifier-failed"]);
    for (const requirement of [...VERIFY_LABEL_CONTRACT, UNLABELED_VERIFY_REQUIREMENT]) {
      for (const klass of requirement.accepts) expect(COUNTERSIGN_CLASSES).toContain(klass);
      for (const klass of refusing) expect(countersignMeetsRequirement(requirement, klass)).toBe(false);
    }
  });

  it("keeps the fail-closed default off the discount, and the exemption on exactly one label", () => {
    expect(UNLABELED_VERIFY_REQUIREMENT.label).toBeNull();
    expect(UNLABELED_VERIFY_REQUIREMENT.selfSignable).toBe(false);
    expect(countersignMeetsRequirement(UNLABELED_VERIFY_REQUIREMENT, "type-check-only")).toBe(false);
    const selfSignable = VERIFY_LABEL_CONTRACT.filter((entry) => entry.selfSignable);
    expect(selfSignable.map((entry) => entry.label)).toEqual(["verify:gate-only"]);
    const admitsGateRow = VERIFY_LABEL_CONTRACT.filter((entry) =>
      countersignMeetsRequirement(entry, "type-check-only"),
    );
    expect(admitsGateRow.map((entry) => entry.label)).toEqual(["verify:gate-only"]);
  });

  it("resolves an unlabeled Ticket to the default and a disagreement to the STRICTEST label", () => {
    expect(resolveVerifyRequirement(undefined)).toBe(UNLABELED_VERIFY_REQUIREMENT);
    expect(resolveVerifyRequirement(["ready-for-agent", "spec:4164"])).toBe(
      UNLABELED_VERIFY_REQUIREMENT,
    );
    expect(resolveVerifyRequirement(["verify:tests"]).label).toBe("verify:tests");
    expect(resolveVerifyRequirement(["verify:gate-only", "verify:live"]).label).toBe("verify:live");
    expect(isVerifyLabel("verify:live")).toBe(true);
    expect(isVerifyLabel("verify:vibes")).toBe(false);
    expect(isVerifyLabel(undefined)).toBe(false);
  });
});

describe("the land fixtures, per class (#4174)", () => {
  it("lands at each declared minimum and refuses the class below it", () => {
    for (const requirement of [...VERIFY_LABEL_CONTRACT, UNLABELED_VERIFY_REQUIREMENT]) {
      const atMinimum = decideLandCountersign([rowAt(requirement.minimum)], KEY, requirement);
      expect(atMinimum.decision.allowed).toBe(true);

      const weaker = oneBelow(requirement.minimum);
      if (weaker === null) continue;
      const below = decideLandCountersign([rowAt(weaker)], KEY, requirement);
      expect(below.decision.allowed).toBe(false);
      if (below.decision.allowed) continue;
      expect(below.decision.reason).toBe("insufficient-countersign");
      expect(below.decision.message).toContain(requirement.minimum);
      expect(below.decision.message).toContain(weaker);
      expect(below.supersede).toBeNull();
    }
  });

  it("requires full review of an unlabeled Ticket — the gate's own row lands nothing", () => {
    const unlabeled = decideLandCountersign(
      [rowAt("type-check-only")],
      KEY,
      resolveVerifyRequirement([]),
    );
    expect(unlabeled.decision.allowed).toBe(false);
    const declared = decideLandCountersign(
      [rowAt("type-check-only")],
      KEY,
      resolveVerifyRequirement(["verify:gate-only"]),
    );
    expect(declared.decision.allowed).toBe(true);
  });

  it("defaults a caller that named no requirement to the fail-closed bar", () => {
    expect(decideLandCountersign([rowAt("type-check-only")], KEY).decision.allowed).toBe(false);
    expect(decideLandCountersign([rowAt("test-verified")], KEY).decision.allowed).toBe(true);
  });

  it("keeps a below-bar pass distinct from a verifier that refused or could not conclude", () => {
    const live = resolveVerifyRequirement(["verify:live"]);
    for (const klass of ["verifier-failed", "verifier-blocked"] as const) {
      const judged = decideLandCountersign([rowAt(klass)], KEY, live);
      expect(judged.decision.allowed).toBe(false);
      if (judged.decision.allowed) continue;
      expect(judged.decision.reason).toBe(klass);
    }
    expect(LAND_REFUSAL_REASONS).toContain("insufficient-countersign");
    expect(verifyRequirementShortfall(live, "live-verified")).toBeNull();
    expect(verifyRequirementShortfall(live, "test-verified")).toContain("verify:live");
  });
});

describe("the family reaches the humans and the gate cone (#4174)", () => {
  it("is taught by the triage-labels doc, one row per declared label", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toContain("## Verification bar (`verify:<value>`)");
    for (const declaration of VERIFY_LABEL_CONTRACT) {
      expect(doc).toContain(`\`${declaration.label}\``);
      expect(doc).toContain(declaration.minimum);
    }
    expect(doc).toContain("fails closed");
  });

  it("runs in every gate cone as a repo-wide invariant", () => {
    const names = REPO_INVARIANT_SUITES.map((suite) => suite.name);
    expect(names).toContain("invariants:verify-label-family");
  });
});
