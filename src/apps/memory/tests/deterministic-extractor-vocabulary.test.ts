import { describe, expect, test } from "vitest";
import { lintDeterministicExtractorVocabulary } from "../src/deterministic-extractor-vocabulary-lint.js";

describe("deterministic extractor vocabulary lint", () => {
  test("only emits structural node types and known edge labels", async () => {
    await expect(lintDeterministicExtractorVocabulary()).resolves.toMatchObject({
      outOfVocabulary: { nodeTypes: [], edgeLabels: [] },
    });
  });
});
