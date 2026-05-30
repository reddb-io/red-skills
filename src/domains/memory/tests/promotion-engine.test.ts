import { describe, expect, test } from "vitest";
import {
  DEFAULT_PROMOTABLE_TYPES,
  extractKeywords,
  runPromotionEngine,
  type PromotionCandidate,
  type PromotionExistingNode,
} from "../src/promotion-engine.js";

const decisionCandidate = (
  overrides: Partial<PromotionCandidate> = {},
): PromotionCandidate => ({
  id: overrides.id ?? "cand-1",
  type: overrides.type ?? "decision",
  title: overrides.title ?? "Use pnpm",
  content: overrides.content ?? "We will standardise on pnpm for this repo.",
  ...overrides,
});

const decisionExisting = (
  overrides: Partial<PromotionExistingNode> = {},
): PromotionExistingNode => ({
  rid: overrides.rid ?? 100,
  type: overrides.type ?? "decision",
  title: overrides.title ?? "Use pnpm",
  content: overrides.content ?? "We will standardise on pnpm for this repo.",
  reinforced: overrides.reinforced ?? 0,
  ...overrides,
});

describe("PromotionEngine — type gate", () => {
  test("default promotable set covers decision/fix/gotcha/validation/why_note", () => {
    for (const t of ["decision", "fix", "gotcha", "validation", "why_note"]) {
      expect(DEFAULT_PROMOTABLE_TYPES.has(t)).toBe(true);
    }
  });

  test("rejects candidates whose type is not in the promotable set (type-filter-rejected)", () => {
    const result = runPromotionEngine({
      candidates: [
        decisionCandidate({ id: "noise", type: "tool_result", title: "stdout chunk" }),
      ],
      existing: [],
    });
    expect(result.promote).toHaveLength(0);
    expect(result.reinforce).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("type-rejected");
    expect(result.decisions[0]).toMatchObject({ decision: "skip", reason: "type-rejected" });
  });

  test("honors a custom promotable set", () => {
    const result = runPromotionEngine({
      candidates: [decisionCandidate({ type: "decision" })],
      existing: [],
      options: { promotableTypes: new Set(["fix"]) },
    });
    expect(result.promote).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });
});

describe("PromotionEngine — dedup gate", () => {
  test("no-dup → candidate is promoted", () => {
    const result = runPromotionEngine({
      candidates: [decisionCandidate({ id: "new", title: "Adopt Vitest", content: "Switch test runner to Vitest." })],
      existing: [decisionExisting({ rid: 1, title: "Use pnpm" })],
    });
    expect(result.promote).toHaveLength(1);
    expect(result.promote[0].candidate.id).toBe("new");
    expect(result.reinforce).toHaveLength(0);
  });

  test("exact-dup → bump reinforced on the L3 node, do not promote", () => {
    const existing = decisionExisting({ rid: 42, reinforced: 2 });
    const result = runPromotionEngine({
      candidates: [decisionCandidate()],
      existing: [existing],
    });
    expect(result.promote).toHaveLength(0);
    expect(result.reinforce).toHaveLength(1);
    expect(result.reinforce[0].target_rid).toBe(42);
    expect(result.reinforce[0].match).toBe("exact");
    expect(result.reinforce[0].reinforced).toBe(3);
  });

  test("near-dup by keyword (Jaccard ≥ threshold) → reinforce, not promote", () => {
    const existing: PromotionExistingNode = {
      rid: 7,
      type: "fix",
      title: "tests must hit real postgres avoid mock",
      content: "real database integration migration breakage",
      reinforced: 0,
    };
    const candidate: PromotionCandidate = {
      id: "k1",
      type: "fix",
      title: "real postgres tests must hit avoid mock",
      content: "real database integration breakage migration extra",
    };
    const result = runPromotionEngine({
      candidates: [candidate],
      existing: [existing],
    });
    expect(result.reinforce).toHaveLength(1);
    expect(result.reinforce[0].match).toBe("keyword");
    expect(result.reinforce[0].target_rid).toBe(7);
  });

  test("near-dup by vector (cosine ≥ threshold) → reinforce, not promote", () => {
    const sharedVec = [1, 0, 0, 0];
    const closeVec = [0.99, 0.05, 0, 0];
    const result = runPromotionEngine({
      candidates: [
        {
          id: "v1",
          type: "decision",
          title: "decision A",
          content: "totally different surface text",
          embedding: closeVec,
        },
      ],
      existing: [
        {
          rid: 9,
          type: "decision",
          title: "completely unrelated wording",
          content: "no keyword overlap whatsoever lorem ipsum",
          embedding: sharedVec,
        },
      ],
    });
    expect(result.reinforce).toHaveLength(1);
    expect(result.reinforce[0].match).toBe("vector");
    expect(result.reinforce[0].target_rid).toBe(9);
  });

  test("low-similarity vector + low-overlap keywords → promote", () => {
    const result = runPromotionEngine({
      candidates: [
        {
          id: "v2",
          type: "decision",
          title: "ship feature flag XYZ",
          content: "wrap rollout in growthbook flag",
          embedding: [1, 0, 0, 0],
        },
      ],
      existing: [
        {
          rid: 9,
          type: "decision",
          title: "unrelated infra topic",
          content: "different domain entirely",
          embedding: [0, 1, 0, 0],
        },
      ],
    });
    expect(result.promote).toHaveLength(1);
    expect(result.reinforce).toHaveLength(0);
  });

  test("reinforcement count increments by exactly one per matching candidate", () => {
    const existing = decisionExisting({ rid: 5, reinforced: 0 });
    const result = runPromotionEngine({
      candidates: [
        decisionCandidate({ id: "c1" }),
        decisionCandidate({ id: "c2", title: "Use pnpm", content: "We will standardise on pnpm for this repo." }),
        decisionCandidate({ id: "c3", title: "USE PNPM", content: "We will standardise on pnpm for this repo." }),
      ],
      existing: [existing],
    });
    expect(result.promote).toHaveLength(0);
    expect(result.reinforce).toHaveLength(3);
    expect(result.reinforce.map((r) => r.reinforced)).toEqual([1, 2, 3]);
  });

  test("two near-equivalent candidates in one batch dedup against each other", () => {
    // Both candidates carry identical title+content; the second should
    // reinforce the first instead of double-promoting.
    const candidate = decisionCandidate({ id: "c1", title: "Switch to esbuild", content: "Faster TS bundling." });
    const candidate2 = decisionCandidate({ id: "c2", title: "Switch to esbuild", content: "Faster TS bundling." });
    const result = runPromotionEngine({
      candidates: [candidate, candidate2],
      existing: [],
    });
    expect(result.promote).toHaveLength(1);
    expect(result.promote[0].candidate.id).toBe("c1");
    expect(result.reinforce).toHaveLength(1);
    expect(result.reinforce[0].candidate.id).toBe("c2");
    expect(result.reinforce[0].match).toBe("exact");
  });

  test("type mismatch prevents dedup even when titles match", () => {
    const existing = decisionExisting({ rid: 1, type: "fix", title: "Use pnpm" });
    const result = runPromotionEngine({
      candidates: [decisionCandidate({ type: "decision", title: "Use pnpm" })],
      existing: [existing],
    });
    expect(result.promote).toHaveLength(1);
    expect(result.reinforce).toHaveLength(0);
  });
});

describe("PromotionEngine — keyword extraction", () => {
  test("extracts content-bearing tokens, drops stopwords and short tokens", () => {
    const kw = extractKeywords("We will adopt pnpm for the repo");
    expect(kw).toContain("adopt");
    expect(kw).toContain("pnpm");
    expect(kw).toContain("repo");
    expect(kw).not.toContain("we");
    expect(kw).not.toContain("the");
  });
});
