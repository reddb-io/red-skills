import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CURRENT_DETERMINISTIC_EDGE_LABELS,
  CURRENT_DETERMINISTIC_NODE_TYPES,
  DETERMINISTIC_EXTRACTOR_FILES,
  lintDeterministicExtractorVocabulary,
} from "../src/deterministic-extractor-vocabulary-lint.js";

describe("deterministic extractor vocabulary lint", () => {
  test("enumerates current deterministic extractor node types and edge labels", async () => {
    await expect(lintDeterministicExtractorVocabulary()).resolves.toEqual({
      emitted: {
        nodeTypes: [...CURRENT_DETERMINISTIC_NODE_TYPES].sort(),
        edgeLabels: [...CURRENT_DETERMINISTIC_EDGE_LABELS].sort(),
      },
      expected: {
        nodeTypes: [...CURRENT_DETERMINISTIC_NODE_TYPES].sort(),
        edgeLabels: [...CURRENT_DETERMINISTIC_EDGE_LABELS].sort(),
      },
      outOfVocabulary: { nodeTypes: [], edgeLabels: [] },
    });
  });

  test("fails when an extractor emits an out-of-vocabulary node type", async () => {
    const sourceDir = await copyExtractorSourceDir();
    const path = join(sourceDir, "extract-code.ts");
    const source = await readFile(path, "utf8");
    await writeFile(path, `${source}\nconst drift = { node_type: "runtime_fact" };\n`);

    await expect(lintDeterministicExtractorVocabulary(sourceDir)).rejects.toThrow(
      /out-of-vocabulary node types: \[runtime_fact\]/,
    );
  });

  test("fails when an extractor emits an out-of-vocabulary edge label", async () => {
    const sourceDir = await copyExtractorSourceDir();
    const path = join(sourceDir, "extract-code.ts");
    const source = await readFile(path, "utf8");
    await writeFile(path, `${source}\nconst drift = { label: "MADE_UP_EDGE" };\n`);

    await expect(lintDeterministicExtractorVocabulary(sourceDir)).rejects.toThrow(
      /out-of-vocabulary edge labels: \[MADE_UP_EDGE\]/,
    );
  });
});

async function copyExtractorSourceDir(): Promise<string> {
  const sourceDir = await mkdtemp(join(tmpdir(), "memory-deterministic-lint-"));
  for (const file of DETERMINISTIC_EXTRACTOR_FILES) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    await writeFile(join(sourceDir, file), source);
  }
  return sourceDir;
}
