import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  auditDomainVocabulary,
  DOMAIN_VOCABULARY_ALLOWANCES,
  DOMAIN_VOCABULARY_ROOTS,
  DOMAIN_VOCABULARY_SKILL_ROOTS,
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

  it("reaches the shipped skills, which are the source for a reader who has no source", () => {
    for (const root of DOMAIN_VOCABULARY_SKILL_ROOTS) {
      const swept = LIVE_FILES.filter((file) => file.path.startsWith(`${root}/`));
      expect(swept.length, `the sweep reached nothing under ${root}`).toBeGreaterThan(0);
      expect(swept.every((file) => file.kind === "prose" && file.path.endsWith(".md"))).toBe(true);
    }
    // A projection is not a second place to fix: the mirrors are generated.
    expect(LIVE_FILES.some((file) => file.path.startsWith("packaging/pi/"))).toBe(false);
  });

  it("refuses a retired owner taught by a shipped skill", () => {
    const skill: DomainVocabularyFile = {
      path: "plugins/dev/skills/engineering/invented/SKILL.md",
      sourceText: "The **Castle resident** owns engine state; ask it first.\n",
      kind: "prose",
    };

    const [finding] = auditDomainVocabulary([skill]);

    expect(finding?.term).toBe("Castle resident");
    expect(finding?.reason).toContain("redskilled's Project control state");
  });

  it("reads prose as prose: an HTML comment is history, a URL is not a comment", () => {
    const historical: DomainVocabularyFile = {
      path: "plugins/dev/skills/engineering/invented/HISTORY.md",
      sourceText: "<!-- the Demand producer was retired by ADR 0147 -->\nThe daemon reaps.\n",
      kind: "prose",
    };
    expect(auditDomainVocabulary([historical])).toEqual([]);

    // `//` inside a link must not swallow the rest of the line, or a skill could
    // hide a retired owner behind a URL and read clean.
    const behindAUrl: DomainVocabularyFile = {
      path: "plugins/dev/skills/engineering/invented/LINK.md",
      sourceText: "See https://example.test/adr — the Castle resident answers.\n",
      kind: "prose",
    };
    expect(auditDomainVocabulary([behindAUrl])).toHaveLength(1);
  });

  it("holds live source to the live ownership vocabulary", () => {
    const findings = auditDomainVocabulary(LIVE_FILES);
    expect(
      findings,
      findings.length === 0
        ? ""
        : `domain vocabulary: ${findings.length} finding(s).\n` +
          `${findings.map((finding) => `  - ${finding.reason}`).join("\n")}\n` +
          "Declarations: apps/plugin-dev/src/core/domain-vocabulary-guard.ts (DOMAIN_VOCABULARY_ALLOWANCES); shrink only.",
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
      path: "apps/plugin-dev/src/documented.ts",
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
      [{ path: "apps/plugin-dev/src/cleaned.ts", sourceText: "export const owner = 1;\n" }],
      RETIRED_OWNERSHIP_TERMS,
      [{ path: "apps/plugin-dev/src/cleaned.ts", term: "Castle resident", kind: "historical", reason: "stale" }],
    );
    expect(invented).toEqual([
      'apps/plugin-dev/src/cleaned.ts: allowance for "Castle resident" no longer matches — delete it',
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
