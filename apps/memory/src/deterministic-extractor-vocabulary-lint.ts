import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { STRUCTURAL_TYPES, type StructuralType } from "./extraction-schema.js";
import { EDGE_LABELS, type EdgeLabel } from "./schema.js";

export const DETERMINISTIC_EXTRACTOR_FILES = [
  "extract-code.ts",
  "extract-markdown.ts",
  "extract-sql.ts",
  "extract-asset.ts",
  "extract-dev-artifact.ts",
] as const;

export const CURRENT_DETERMINISTIC_NODE_TYPES = [
  "concept",
  "file",
  "import",
  "symbol",
  "workflow",
] as const satisfies readonly StructuralType[];

export const CURRENT_DETERMINISTIC_EDGE_LABELS = [
  "CALLS",
  "DEFINED_IN",
  "IMPORTS",
  "REFERENCES",
  "USES_TYPE",
] as const satisfies readonly EdgeLabel[];

export interface EmittedVocabulary {
  nodeTypes: Set<string>;
  edgeLabels: Set<string>;
}

export interface DeterministicExtractorVocabularyLintResult {
  emitted: {
    nodeTypes: string[];
    edgeLabels: string[];
  };
  expected: {
    nodeTypes: string[];
    edgeLabels: string[];
  };
  outOfVocabulary: {
    nodeTypes: string[];
    edgeLabels: string[];
  };
}

const DEFAULT_SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));

export async function collectDeterministicExtractorVocabulary(
  sourceDir = DEFAULT_SOURCE_DIR,
): Promise<EmittedVocabulary> {
  const nodeTypes = new Set<string>();
  const edgeLabels = new Set<string>();

  for (const file of DETERMINISTIC_EXTRACTOR_FILES) {
    const path = resolve(sourceDir, file);
    const source = await readFile(path, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

    visit(tree, (node) => {
      if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name)) return;
      const value = stringLiteralValue(node.initializer);
      if (value == null) return;

      if (node.name.text === "node_type") {
        nodeTypes.add(value);
      } else if (node.name.text === "label" && /^[A-Z][A-Z_]*$/.test(value)) {
        edgeLabels.add(value);
      }
    });
  }

  return { nodeTypes, edgeLabels };
}

export async function lintDeterministicExtractorVocabulary(
  sourceDir = DEFAULT_SOURCE_DIR,
): Promise<DeterministicExtractorVocabularyLintResult> {
  const emitted = await collectDeterministicExtractorVocabulary(sourceDir);
  const result: DeterministicExtractorVocabularyLintResult = {
    emitted: {
      nodeTypes: sorted(emitted.nodeTypes),
      edgeLabels: sorted(emitted.edgeLabels),
    },
    expected: {
      nodeTypes: [...CURRENT_DETERMINISTIC_NODE_TYPES].sort(),
      edgeLabels: [...CURRENT_DETERMINISTIC_EDGE_LABELS].sort(),
    },
    outOfVocabulary: {
      nodeTypes: outside(emitted.nodeTypes, new Set<string>(STRUCTURAL_TYPES)),
      edgeLabels: outside(emitted.edgeLabels, new Set<string>(EDGE_LABELS)),
    },
  };

  const failures = [
    listFailure("out-of-vocabulary node types", result.outOfVocabulary.nodeTypes),
    listFailure("out-of-vocabulary edge labels", result.outOfVocabulary.edgeLabels),
  ].filter((line): line is string => line != null);

  if (failures.length > 0) {
    throw new Error(`deterministic extractor vocabulary lint failed:\n${failures.join("\n")}`);
  }

  return result;
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function stringLiteralValue(expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isAsExpression(expression)) return stringLiteralValue(expression.expression);
  if (ts.isSatisfiesExpression(expression)) return stringLiteralValue(expression.expression);
  return null;
}

function outside(values: ReadonlySet<string>, vocabulary: ReadonlySet<string>): string[] {
  return sorted(values).filter((value) => !vocabulary.has(value));
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function listFailure(label: string, values: string[]): string | null {
  if (values.length === 0) return null;
  return `${label}: [${values.join(", ")}]`;
}

async function main(): Promise<void> {
  await lintDeterministicExtractorVocabulary();
  console.log("deterministic extractor vocabulary lint passed");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
