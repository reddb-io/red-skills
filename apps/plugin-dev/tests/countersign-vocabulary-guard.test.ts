/**
 * The Countersign vocabulary ratchet (issue #4172, Spec #4164, ADR 0156).
 *
 * ADR 0156 renamed ADR 0154's rows, ledger and lane so that ADR 0136's
 * **Verdict** — the gate's classifier of a failed Validation round — keeps its
 * one meaning. Every surface of that rename is text, so nothing a type checker
 * sees stops `VerdictRow` from reappearing beside `CountersignRow`. This suite
 * is what stops it, in both directions: the retired spellings are refused, and
 * ADR 0136's own vocabulary is proven UNTOUCHED, because a ratchet that reds the
 * survivor teaches the next slice to rename the wrong thing.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  COUNTERSIGN_VOCABULARY_ALLOWANCES,
  COUNTERSIGN_VOCABULARY_ROOTS,
  COUNTERSIGN_VOCABULARY_SKILL_ROOTS,
  RETIRED_COUNTERSIGN_TERMS,
} from "../src/core/countersign-vocabulary-guard.js";
import {
  auditDomainVocabulary,
  readDomainVocabularyFiles,
  staleDomainVocabularyAllowances,
  type DomainVocabularyFile,
} from "../src/core/domain-vocabulary-guard.js";
import { COUNTERSIGN_LANE_ID } from "../src/core/countersign-ledger.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";
import { CASTLE_STATE_MEMBERS } from "@reddb-io/shared/red-paths.js";
import { laneCensusLaneIds } from "../src/core/operational-probes/lane-census.js";
import { LANE_WRITER_ENFORCEMENT } from "../src/core/lane-retention-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const LIVE_FILES: DomainVocabularyFile[] = readDomainVocabularyFiles(
  ROOT,
  COUNTERSIGN_VOCABULARY_ROOTS,
  COUNTERSIGN_VOCABULARY_SKILL_ROOTS,
);

const audit = (files: readonly DomainVocabularyFile[]) =>
  auditDomainVocabulary(files, RETIRED_COUNTERSIGN_TERMS, COUNTERSIGN_VOCABULARY_ALLOWANCES);

describe("countersign vocabulary ratchet — a rename nothing pins is a rename that grows back", () => {
  it("reaches every tree that carries a Wave-1 artifact, so a green sweep means something", () => {
    expect(LIVE_FILES.length).toBeGreaterThan(200);
    for (const root of COUNTERSIGN_VOCABULARY_ROOTS) {
      expect(
        LIVE_FILES.some((file) => file.path.startsWith(`${root}/`)),
        `the sweep reached nothing under ${root}`,
      ).toBe(true);
    }
    // packages/shared is what the ownership sweep cannot see, and it holds the
    // question every land entry point asks.
    expect(LIVE_FILES.some((file) => file.path === "packages/shared/land-countersign.ts")).toBe(true);
  });

  it("holds live source to the Countersign vocabulary", () => {
    const findings = audit(LIVE_FILES);
    expect(
      findings,
      findings.length === 0
        ? ""
        : `countersign vocabulary: ${findings.length} finding(s).\n` +
          `${findings.map((finding) => `  - ${finding.reason}`).join("\n")}\n` +
          "Declarations: apps/plugin-dev/src/core/countersign-vocabulary-guard.ts" +
          " (COUNTERSIGN_VOCABULARY_ALLOWANCES); shrink only.",
    ).toEqual([]);
  });

  it.each(RETIRED_COUNTERSIGN_TERMS)(
    "rejects a newly introduced live $term and names the word that replaced it",
    (term) => {
      const invented: DomainVocabularyFile = {
        path: "apps/plugin-dev/src/core/invented.ts",
        sourceText: `export const spelling = "${term.term}";\n`,
      };

      const [finding] = audit([invented]);

      expect(finding?.path).toBe("apps/plugin-dev/src/core/invented.ts");
      expect(finding?.term).toBe(term.term);
      expect(finding?.reason).toContain(term.liveOwner);
      expect(finding?.reason).toContain(term.why);
    },
  );

  it.each([
    { spelling: 'join(castleStateDir(root), "verdicts.toonl")', term: "verdicts.toonl" },
    { spelling: "createVerdictLedger", term: "verdict ledger" },
    { spelling: "verdict_ledger_path", term: "verdict ledger" },
    { spelling: "LandVerdictGate", term: "land verdict" },
    { spelling: "landVerdictGate", term: "land verdict" },
    { spelling: "VerdictRow", term: "verdict row" },
    { spelling: "verdictKeyOf", term: "verdict row" },
    { spelling: "VerdictAppendInput", term: "verdict row" },
    { spelling: "standingVerdicts", term: "standing verdict" },
    { spelling: 'refuseLand("stale-verdict", subject)', term: "stale-verdict" },
    { spelling: 'reason === "no-verdict"', term: "no-verdict" },
    { spelling: 'refuseLand("voided-verdict", subject)', term: "voided-verdict" },
  ])("reads $spelling as the retired $term surface", ({ spelling, term }) => {
    const findings = audit([
      { path: "packages/shared/invented.ts", sourceText: `export const x = ${JSON.stringify(spelling)};\n` },
    ]);

    expect(findings.map((finding) => finding.term)).toContain(term);
  });

  // Acceptance criterion 3: ADR 0136's Verdict is UNTOUCHED. A ratchet that
  // reddens the survivor is worse than none — it teaches the next slice to
  // rename the gate's classifier.
  it.each([
    "export function decideVerdict(input: VerdictInput): Verdict {",
    "const verdict = gateVerdict(run.stages);",
    "const verdict = await staleHeadVerdict(exec, input);",
    'export type VerdictFault = { readonly kind: "branch" };',
    "export const attributions = encodeVerdicts(result.verdicts);",
  ])("leaves ADR 0136's own vocabulary alone: %s", (sourceText) => {
    expect(audit([{ path: "apps/plugin-dev/src/core/verdict.ts", sourceText: `${sourceText}\n` }])).toEqual([]);
  });

  it("keeps prose describing the rename out of the live claim", () => {
    const documented: DomainVocabularyFile = {
      path: "apps/plugin-dev/src/documented.ts",
      sourceText:
        "// ADR 0154 called this lane verdicts.toonl and its rows verdict rows;\n" +
        "/* the land verdict gate and its standing verdict went the same way. */\n" +
        "export const lane = \"countersigns\";\n",
    };

    expect(audit([documented])).toEqual([]);
  });

  it("refuses an allowance whose cause is gone", () => {
    const stale = staleDomainVocabularyAllowances(
      LIVE_FILES,
      RETIRED_COUNTERSIGN_TERMS,
      COUNTERSIGN_VOCABULARY_ALLOWANCES,
    );
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("declares only the guard itself, and declares it historical", () => {
    for (const allowance of COUNTERSIGN_VOCABULARY_ALLOWANCES) {
      expect(allowance.path).toBe("apps/plugin-dev/src/core/countersign-vocabulary-guard.ts");
      expect(allowance.kind).toBe("historical");
      expect(RETIRED_COUNTERSIGN_TERMS.map((term) => term.term)).toContain(allowance.term);
    }
  });

  // Acceptance criterion 2: the lane is registered under the NEW name across all
  // four obligations, together. Three of four is a lane nobody can audit.
  it("registers the Countersign lane across the four-way lane obligations", () => {
    expect(COUNTERSIGN_LANE_ID).toBe("countersigns");
    expect(Object.keys(LANE_RETENTION_REGISTRY)).toContain("countersigns");
    expect(laneCensusLaneIds()).toContain("countersigns");
    expect(Object.keys(CASTLE_STATE_MEMBERS)).toContain("countersigns.toonl");
    expect(
      LANE_WRITER_ENFORCEMENT.find((entry) => entry.lane === "countersigns")?.writers,
    ).toEqual(["apps/plugin-dev/src/core/countersign-ledger.ts"]);
  });

  it("runs in every gate run, however narrow the cone", () => {
    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name)).toContain("invariants:countersign-vocabulary");
  });
});
