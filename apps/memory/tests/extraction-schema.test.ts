import { describe, expect, test } from "vitest";
import {
  BASE_STRUCTURAL_TYPE,
  EXTRACTION_PROFILES,
  EXTRACTION_SCHEMA_VERSION,
  STRUCTURAL_TYPES,
  SUGGESTED_ENGINEERING_CODES,
  deriveExtractionProfiles,
  isSuggestedEngineeringCode,
  normalizeEngineeringCode,
} from "../src/extraction-schema.js";
import { GRAPH_CONTRACT_VERSION, buildGraphContract } from "../src/graph-contract.js";
import type { StoredNode } from "../src/graph-store.js";

describe("structural vocabulary (single source of truth)", () => {
  test("is versioned and closed, with the base type a member", () => {
    expect(EXTRACTION_SCHEMA_VERSION).toBe("1.1.0");
    expect(STRUCTURAL_TYPES).toContain(BASE_STRUCTURAL_TYPE);
    expect(new Set(STRUCTURAL_TYPES).size).toBe(STRUCTURAL_TYPES.length); // no dupes
  });
});

describe("strict-write profile", () => {
  const { strictWrite } = EXTRACTION_PROFILES;

  test("accepts every in-vocabulary structural type as itself", () => {
    for (const type of STRUCTURAL_TYPES) {
      const r = strictWrite.resolve(type);
      expect(r.structuralType).toBe(type);
      expect(r.inVocabulary).toBe(true);
      expect(r.engineeringCode).toBeNull();
    }
  });

  test("resolves a non-structural kind to the base type — never an error", () => {
    for (const kind of ["decision", "gotcha", "root-cause", "totally-made-up"]) {
      const r = strictWrite.resolve(kind);
      expect(r.structuralType).toBe(BASE_STRUCTURAL_TYPE);
      expect(r.inVocabulary).toBe(false);
      // the proposed kind survives as an open engineering code, not discarded
      expect(r.engineeringCode).toBe(normalizeEngineeringCode(kind));
    }
  });

  test("never throws, even on empty or junk input", () => {
    expect(() => strictWrite.resolve("")).not.toThrow();
    expect(() => strictWrite.resolve("   ")).not.toThrow();
    expect(strictWrite.resolve("").structuralType).toBe(BASE_STRUCTURAL_TYPE);
    expect(strictWrite.resolve("").engineeringCode).toBeNull();
  });
});

describe("lossless-read profile (graph contract export is unchanged)", () => {
  const { losslessRead } = EXTRACTION_PROFILES;

  test("tracks the graph contract version", () => {
    expect(losslessRead.version).toBe(GRAPH_CONTRACT_VERSION);
  });

  test("an unknown structural type round-trips through export and never breaks", () => {
    const nodes = [
      { rid: 1, label: "f", node_type: "file", properties: { title: "f" } },
      // a type the closed vocabulary has never heard of
      { rid: 2, label: "x", node_type: "speculative-future-kind", properties: { title: "x" } },
    ] as unknown as StoredNode[];

    const contract = buildGraphContract({ nodes, edges: [] });
    const types = contract.nodes.map((n) => n.type);
    expect(types).toContain("speculative-future-kind"); // preserved verbatim
    expect(losslessRead.roundTrips("speculative-future-kind")).toBe(true);
    // and every closed structural type round-trips too
    for (const type of STRUCTURAL_TYPES) {
      expect(losslessRead.roundTrips(type)).toBe(true);
    }
  });
});

describe("suggested engineering-code vocabulary (open + growable)", () => {
  test("is a non-empty list separate from the closed structural axis", () => {
    expect(SUGGESTED_ENGINEERING_CODES.length).toBeGreaterThan(0);
    // the two axes are disjoint — a structural type is not a semantic code
    for (const code of SUGGESTED_ENGINEERING_CODES) {
      expect(STRUCTURAL_TYPES as readonly string[]).not.toContain(code);
    }
  });

  test("recognises suggested codes but admits unknown ones (never gated)", () => {
    expect(isSuggestedEngineeringCode("decision")).toBe(true);
    expect(isSuggestedEngineeringCode("Root Cause")).toBe(true); // normalised
    expect(isSuggestedEngineeringCode("brand-new-code")).toBe(false);
    // "not suggested" is visibility, not rejection: the code still normalises
    // into a usable engineering code.
    expect(normalizeEngineeringCode("brand-new-code")).toBe("brand-new-code");
  });
});

describe("one vocabulary, two profiles — they cannot diverge", () => {
  test("both profiles share the SAME frozen structural set by reference", () => {
    const { strictWrite, losslessRead } = EXTRACTION_PROFILES;
    // Identity, not equality: there is no second copy to drift.
    expect(strictWrite.structuralTypes).toBe(losslessRead.structuralTypes);
  });

  test("the shared set is exactly the versioned vocabulary", () => {
    const { strictWrite } = EXTRACTION_PROFILES;
    expect([...strictWrite.structuralTypes].sort()).toEqual([...STRUCTURAL_TYPES].sort());
  });

  test("strict-write only ever emits types the lossless-read profile round-trips", () => {
    const { strictWrite, losslessRead } = EXTRACTION_PROFILES;
    // Whatever strict-write resolves to is, by construction, a structural type
    // the read profile accepts losslessly — the two axes stay consistent.
    for (const kind of [...STRUCTURAL_TYPES, "decision", "unknown-xyz", ""]) {
      const { structuralType } = strictWrite.resolve(kind);
      expect(strictWrite.isStructural(structuralType)).toBe(true);
      expect(losslessRead.isStructural(structuralType)).toBe(true);
      expect(losslessRead.roundTrips(structuralType)).toBe(true);
    }
  });

  test("a re-derivation from the same vocabulary yields an equivalent vocabulary", () => {
    const again = deriveExtractionProfiles();
    expect([...again.strictWrite.structuralTypes].sort()).toEqual(
      [...EXTRACTION_PROFILES.strictWrite.structuralTypes].sort(),
    );
    // both profiles of a single derivation still share one reference
    expect(again.strictWrite.structuralTypes).toBe(again.losslessRead.structuralTypes);
  });

  test("a base type outside the vocabulary is rejected at derivation time", () => {
    expect(() =>
      deriveExtractionProfiles(["file", "symbol"], { baseStructuralType: "concept" as never }),
    ).toThrow(/base structural type/);
  });
});
