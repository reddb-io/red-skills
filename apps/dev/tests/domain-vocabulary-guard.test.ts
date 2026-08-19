import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  auditDomainVocabulary,
  DOMAIN_VOCABULARY_ALLOWANCES,
  DOMAIN_VOCABULARY_ROOTS,
  readDomainVocabularyFiles,
  RETIRED_OWNERSHIP_TERMS,
  staleDomainVocabularyAllowances,
  type DomainVocabularyFile,
} from "../src/core/domain-vocabulary-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const LIVE_FILES: DomainVocabularyFile[] = readDomainVocabularyFiles(ROOT);

describe("domain vocabulary ratchet — a retired owner named in live source is an architecture nobody decided", () => {
  it("reaches the whole live control plane, so a green sweep means something", () => {
    expect(LIVE_FILES.length).toBeGreaterThan(200);
    for (const root of DOMAIN_VOCABULARY_ROOTS) {
      expect(
        LIVE_FILES.some((file) => file.path.startsWith(`${root}/`)),
        `the sweep reached nothing under ${root}`,
      ).toBe(true);
    }
  });

  it("holds live source to the live ownership vocabulary", () => {
    const findings = auditDomainVocabulary(LIVE_FILES);
    expect(
      findings,
      findings.length === 0
        ? ""
        : `domain vocabulary: ${findings.length} finding(s).\n` +
          `${findings.map((finding) => `  - ${finding.reason}`).join("\n")}\n` +
          "Declarations: apps/dev/src/core/domain-vocabulary-guard.ts (DOMAIN_VOCABULARY_ALLOWANCES); shrink only.",
    ).toEqual([]);
  });

  it.each(RETIRED_OWNERSHIP_TERMS)(
    "rejects a newly introduced live $term and names the owner that replaced it",
    (term) => {
      const invented: DomainVocabularyFile = {
        path: "apps/redskilled/src/invented.ts",
        sourceText: `export interface Owner { readonly role: "${term.term}"; }\n`,
      };

      const [finding] = auditDomainVocabulary([invented]);

      expect(finding?.path).toBe("apps/redskilled/src/invented.ts");
      expect(finding?.term).toBe(term.term);
      expect(finding?.reason).toContain(term.liveOwner);
      expect(finding?.reason).toContain(term.why);
    },
  );

  it.each([
    { spelling: "CastleResident", term: "Castle resident" },
    { spelling: "castle_resident", term: "Castle resident" },
    { spelling: "demandProducer", term: "Demand producer" },
    { spelling: "project-coordinator", term: "Project coordinator Worker" },
    { spelling: "ManagerService", term: "Manager service" },
  ])("reads $spelling as the $term claim it is", ({ spelling, term }) => {
    const findings = auditDomainVocabulary([
      { path: "packages/worker/src/invented.ts", sourceText: `export const ${spelling} = 1;\n` },
    ]);

    expect(findings.map((finding) => finding.term)).toEqual([term]);
  });

  // Criterion 4 of issue #3897: history and compatibility are DISTINGUISHED,
  // not merely tolerated. Two mechanisms, both explicit.
  it("keeps prose describing the retirement out of the live claim", () => {
    const documented: DomainVocabularyFile = {
      path: "apps/dev/src/documented.ts",
      sourceText:
        "// The Castle resident and its Demand producer were retired by ADR 0143;\n" +
        "/* no Project coordinator Worker and no Manager service replaced them. */\n" +
        "export const owner = \"redskilled\";\n",
    };

    expect(auditDomainVocabulary([documented])).toEqual([]);
  });

  it("declares every surviving literal as historical or as pending demolition", () => {
    for (const allowance of DOMAIN_VOCABULARY_ALLOWANCES) {
      expect(["historical", "pending-demolition"]).toContain(allowance.kind);
      expect(allowance.reason.length, `${allowance.path} states no reason`).toBeGreaterThan(0);
      expect(
        RETIRED_OWNERSHIP_TERMS.map((term) => term.term),
        `${allowance.path} allows an undeclared term`,
      ).toContain(allowance.term);
    }

    // A surface still standing must name the ratchet whose count owns its
    // removal; a historical record answers to nothing but itself.
    for (const allowance of DOMAIN_VOCABULARY_ALLOWANCES.filter((entry) => entry.kind === "pending-demolition")) {
      expect(allowance.ownedBy, `${allowance.path} is pending demolition with no owner`).toBeTruthy();
    }
  });

  it("refuses an allowance whose cause is gone", () => {
    const stale = staleDomainVocabularyAllowances(LIVE_FILES);
    expect(stale, stale.join("\n")).toEqual([]);

    const invented = staleDomainVocabularyAllowances(
      [{ path: "apps/dev/src/cleaned.ts", sourceText: "export const owner = 1;\n" }],
      RETIRED_OWNERSHIP_TERMS,
      [{ path: "apps/dev/src/cleaned.ts", term: "Castle resident", kind: "historical", reason: "stale" }],
    );
    expect(invented).toEqual([
      'apps/dev/src/cleaned.ts: allowance for "Castle resident" no longer matches — delete it',
    ]);
  });

  it("keeps the declared terms and the Dev glossary saying the same thing", () => {
    expect(RETIRED_OWNERSHIP_TERMS.map((term) => term.term)).toEqual([
      "Castle resident",
      "Demand producer",
      "Project coordinator Worker",
      "Manager service",
    ]);
    for (const term of RETIRED_OWNERSHIP_TERMS) {
      expect(term.liveOwner, `${term.term} names no live owner`).toMatch(/redskilled|Manager Skill/);
    }
  });
});
