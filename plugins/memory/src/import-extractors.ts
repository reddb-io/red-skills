import { dirname, join } from "node:path";

export interface Import {
  specifier: string;
  kind: "relative" | "bare";
  resolvedPath?: string;
}

export type ImportExtractor = (parseTree: unknown, sourceText: string) => Import[];

const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/**
 * Extract ES module specifiers from TypeScript/JavaScript source text.
 * The parseTree parameter is reserved for parser-backed extractors; this
 * deterministic slice scans the import/export grammar forms we index today.
 */
export const typescriptJavascriptImportExtractor: ImportExtractor = (
  _parseTree,
  sourceText,
) => {
  assertImportClausesParse(sourceText);

  const imports: Import[] = [];
  const re =
    /\b(?:import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?|export\s+(?:type\s+)?[\s\S]*?\s+from\s+)["']([^"']+)["']/g;

  for (const match of sourceText.matchAll(re)) {
    const specifier = match[1];
    if (!specifier) continue;
    imports.push({ specifier, kind: isRelative(specifier) ? "relative" : "bare" });
  }

  return imports;
};

const EXTRACTORS_BY_EXT = new Map<string, ImportExtractor>();
for (const ext of TS_JS_EXTENSIONS) {
  EXTRACTORS_BY_EXT.set(ext, typescriptJavascriptImportExtractor);
}

export function extractImportsForFile(
  sourcePath: string,
  parseTree: unknown,
  sourceText: string,
): Import[] {
  const ext = sourcePath.slice(sourcePath.lastIndexOf(".")).toLowerCase();
  const extractor = EXTRACTORS_BY_EXT.get(ext);
  if (!extractor) return [];

  try {
    return extractor(parseTree, sourceText).map((imp) =>
      imp.kind === "relative"
        ? { ...imp, resolvedPath: join(dirname(sourcePath), imp.specifier) }
        : imp,
    );
  } catch {
    return [];
  }
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function assertImportClausesParse(sourceText: string): void {
  const declarations = [
    ...sourceText.matchAll(/\bimport\b[\s\S]*?(?:;|$)/g),
    ...sourceText.matchAll(/\bexport\b[\s\S]*?\bfrom\b[\s\S]*?(?:;|$)/g),
  ];
  for (const declaration of declarations) {
    const text = declaration[0] ?? "";
    let braceDepth = 0;
    for (const char of text) {
      if (char === "{") braceDepth += 1;
      if (char === "}") braceDepth -= 1;
      if (braceDepth < 0) throw new Error("malformed import/export clause");
    }
    if (braceDepth !== 0) throw new Error("malformed import/export clause");
  }
}
