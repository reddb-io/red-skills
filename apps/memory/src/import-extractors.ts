import { dirname, join, sep } from "node:path";

export interface Import {
  specifier: string;
  kind: "relative" | "bare";
  resolvedPath?: string;
}

export type ImportExtractor = (parseTree: unknown, sourceText: string) => Import[];

const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const RUST_EXTENSIONS = new Set([".rs"]);
const GO_EXTENSIONS = new Set([".go"]);
const PYTHON_EXTENSIONS = new Set([".py"]);

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

/**
 * Expand Rust `use` trees into concrete path specifiers. This scanner keeps the
 * extraction deterministic and intentionally narrow: malformed use groups throw
 * so the dispatcher can fail closed for that file's imports.
 */
export const rustImportExtractor: ImportExtractor = (_parseTree, sourceText) => {
  const imports: Import[] = [];

  for (const declaration of rustUseDeclarations(sourceText)) {
    assertBalancedBraces(declaration);
    const useClause = declaration
      .replace(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/, "")
      .replace(/;\s*$/, "");
    for (const specifier of expandRustUseTree(useClause)) {
      imports.push({ specifier, kind: isRustRelative(specifier) ? "relative" : "bare" });
    }
  }

  const externCrateRe =
    /\b(?:pub(?:\([^)]*\))?\s+)?extern\s+crate\s+([A-Za-z_]\w*)(?:\s+as\s+[A-Za-z_]\w*)?\s*;/g;
  for (const match of sourceText.matchAll(externCrateRe)) {
    const specifier = match[1];
    if (!specifier) continue;
    imports.push({ specifier, kind: "bare" });
  }

  return imports;
};

/**
 * Extract Go import package paths. Go import paths are module/package strings,
 * so they are always indexed as bare specifiers in this deterministic pass.
 */
export const goImportExtractor: ImportExtractor = (_parseTree, sourceText) => {
  assertGoImportClausesParse(sourceText);

  const imports: Import[] = [];
  const declarationRe =
    /\bimport\s*(?:\(([\s\S]*?)\)|(?:(?:[A-Za-z_]\w*|[._])\s+)?["`]([^"`]+)["`])/g;

  for (const match of sourceText.matchAll(declarationRe)) {
    const group = match[1];
    const single = match[2];
    if (single) {
      imports.push({ specifier: single, kind: "bare" });
      continue;
    }

    if (group == null) continue;
    for (const specifier of goImportSpecifiers(group)) {
      imports.push({ specifier, kind: "bare" });
    }
  }

  return imports;
};

/**
 * Extract Python import statements into concrete module/member specifiers.
 * Malformed multiline import clauses throw so the dispatcher can fail closed
 * for that file's imports.
 */
export const pythonImportExtractor: ImportExtractor = (_parseTree, sourceText) => {
  const imports: Import[] = [];

  for (const declaration of pythonImportDeclarations(sourceText)) {
    assertBalancedParens(declaration, "malformed Python import clause");
    const trimmed = declaration.trim();

    if (trimmed.startsWith("import ")) {
      const importList = trimmed.replace(/^import\s+/, "");
      for (const item of splitTopLevel(importList, ",")) {
        const specifier = stripPythonAlias(item);
        if (specifier) imports.push({ specifier, kind: "bare" });
      }
      continue;
    }

    const fromMatch = /^from\s+([.\w]+)\s+import\s+([\s\S]+)$/.exec(trimmed);
    if (!fromMatch) continue;

    const [, moduleName, importedNames] = fromMatch;
    if (!moduleName || !importedNames) continue;

    for (const name of pythonImportedNames(importedNames)) {
      imports.push({
        specifier: `${moduleName}${moduleName.endsWith(".") ? "" : "."}${name}`,
        kind: moduleName.startsWith(".") ? "relative" : "bare",
      });
    }
  }

  return imports;
};

const EXTRACTORS_BY_EXT = new Map<string, ImportExtractor>();
for (const ext of TS_JS_EXTENSIONS) {
  EXTRACTORS_BY_EXT.set(ext, typescriptJavascriptImportExtractor);
}
for (const ext of RUST_EXTENSIONS) {
  EXTRACTORS_BY_EXT.set(ext, rustImportExtractor);
}
for (const ext of GO_EXTENSIONS) {
  EXTRACTORS_BY_EXT.set(ext, goImportExtractor);
}
for (const ext of PYTHON_EXTENSIONS) {
  EXTRACTORS_BY_EXT.set(ext, pythonImportExtractor);
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
        ? {
            ...imp,
            resolvedPath:
              ext === ".rs"
                ? resolveRustRelativeImport(sourcePath, imp.specifier)
                : ext === ".py"
                  ? resolvePythonRelativeImport(sourcePath, imp.specifier)
                : join(dirname(sourcePath), imp.specifier),
          }
        : imp,
    );
  } catch {
    return [];
  }
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isRustRelative(specifier: string): boolean {
  return /^(?:crate|self|super)(?:::|$)/.test(specifier);
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

function assertGoImportClausesParse(sourceText: string): void {
  const groupedImportRe = /\bimport\s*\(/g;
  for (const match of sourceText.matchAll(groupedImportRe)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = sourceText.indexOf(")", start);
    if (end < 0) throw new Error("malformed Go import clause");
    assertGoImportGroupParse(sourceText.slice(start, end));
  }
}

function assertGoImportGroupParse(group: string): void {
  for (const statement of group.split(/[;\n]/)) {
    const trimmed = statement.replace(/\/\/.*$/, "").trim();
    if (!trimmed) continue;
    if (!/^(?:(?:[A-Za-z_]\w*|[._])\s+)?["`][^"`]+["`]$/.test(trimmed)) {
      throw new Error("malformed Go import clause");
    }
  }
}

function goImportSpecifiers(group: string): string[] {
  return [...group.matchAll(/(?:^|[\s;])(?:(?:[A-Za-z_]\w*|[._])\s+)?["`]([^"`]+)["`]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier));
}

function rustUseDeclarations(sourceText: string): string[] {
  return [...sourceText.matchAll(/\b(?:pub(?:\([^)]*\))?\s+)?use\s+[\s\S]*?(?:;|$)/g)].map(
    (m) => m[0] ?? "",
  );
}

function assertBalancedBraces(text: string): void {
  let braceDepth = 0;
  for (const char of text) {
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth -= 1;
    if (braceDepth < 0) throw new Error("malformed Rust use clause");
  }
  if (braceDepth !== 0) throw new Error("malformed Rust use clause");
}

function assertBalancedParens(text: string, message: string): void {
  let parenDepth = 0;
  for (const char of text) {
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth -= 1;
    if (parenDepth < 0) throw new Error(message);
  }
  if (parenDepth !== 0) throw new Error(message);
}

function pythonImportDeclarations(sourceText: string): string[] {
  const declarations: string[] = [];
  const lines = sourceText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripPythonComment(lines[index] ?? "").trimEnd();
    if (!/^\s*(?:import|from)\s+/.test(line)) continue;

    const parts = [line];
    let parenDepth = pythonParenDelta(line);
    while (parenDepth > 0 && index + 1 < lines.length) {
      index += 1;
      const continuation = stripPythonComment(lines[index] ?? "").trimEnd();
      parts.push(continuation);
      parenDepth += pythonParenDelta(continuation);
    }
    declarations.push(parts.join("\n"));
  }
  return declarations;
}

function stripPythonComment(line: string): string {
  const index = line.indexOf("#");
  return index >= 0 ? line.slice(0, index) : line;
}

function pythonParenDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "(") delta += 1;
    if (char === ")") delta -= 1;
  }
  return delta;
}

function pythonImportedNames(importedNames: string): string[] {
  const body = importedNames.trim().replace(/^\(\s*/, "").replace(/\s*\)$/, "");
  return splitTopLevel(body, ",")
    .map((item) => stripPythonAlias(item))
    .filter(Boolean);
}

function stripPythonAlias(importPath: string): string {
  return importPath.replace(/\s+as\s+[A-Za-z_]\w*\s*$/, "").trim();
}

function expandRustUseTree(useTree: string, prefix: string[] = []): string[] {
  const imports: string[] = [];
  for (const item of splitTopLevel(useTree, ",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const groupStart = indexOfTopLevel(trimmed, "{");
    if (groupStart >= 0) {
      const groupEnd = matchingBraceIndex(trimmed, groupStart);
      if (groupEnd == null) throw new Error("malformed Rust use clause");

      const pathPrefix = trimmed.slice(0, groupStart).replace(/::\s*$/, "");
      const group = trimmed.slice(groupStart + 1, groupEnd);
      imports.push(...expandRustUseTree(group, [...prefix, ...rustPathSegments(pathPrefix)]));
      continue;
    }

    const segments = rustPathSegments(stripTopLevelAlias(trimmed));
    if (segments.length === 1 && segments[0] === "self" && prefix.length > 0) {
      imports.push(prefix.join("::"));
      continue;
    }
    if (segments.length > 0) imports.push([...prefix, ...segments].join("::"));
  }
  return imports;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let braceDepth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth -= 1;
    if (char === separator && braceDepth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function indexOfTopLevel(text: string, needle: string): number {
  let braceDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === needle && braceDepth === 0) return index;
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth -= 1;
  }
  return -1;
}

function matchingBraceIndex(text: string, openIndex: number): number | null {
  let braceDepth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") braceDepth += 1;
    if (char === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return index;
    }
  }
  return null;
}

function stripTopLevelAlias(path: string): string {
  return path.replace(/\s+as\s+[A-Za-z_]\w*\s*$/, "").trim();
}

function rustPathSegments(path: string): string[] {
  return path
    .split("::")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function resolveRustRelativeImport(sourcePath: string, specifier: string): string {
  const segments = rustPathSegments(specifier);
  if (segments.length === 0) return dirname(sourcePath);

  const [head, ...tail] = segments;
  if (head === "crate") return join(rustCrateModuleRoot(sourcePath), ...tail);
  if (head === "self") return join(dirname(sourcePath), ...tail);
  if (head === "super") {
    let base = dirname(sourcePath);
    let index = 0;
    while (segments[index] === "super") {
      base = dirname(base);
      index += 1;
    }
    return join(base, ...segments.slice(index));
  }
  return join(dirname(sourcePath), ...segments);
}

function resolvePythonRelativeImport(sourcePath: string, specifier: string): string {
  const match = /^(\.+)(.*)$/.exec(specifier);
  if (!match) return join(dirname(sourcePath), ...specifier.split(".").filter(Boolean));

  const [, dots, rest] = match;
  let base = dirname(sourcePath);
  for (let level = 1; level < dots.length; level += 1) {
    base = dirname(base);
  }
  return join(base, ...rest.split(".").filter(Boolean));
}

function rustCrateModuleRoot(sourcePath: string): string {
  const marker = `${sep}src${sep}`;
  const index = sourcePath.lastIndexOf(marker);
  if (index >= 0) return sourcePath.slice(0, index + marker.length - 1);
  return dirname(sourcePath);
}
