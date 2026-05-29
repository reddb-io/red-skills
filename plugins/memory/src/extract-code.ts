import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { contentHash } from "./hash.js";
import { extractImportsForFile } from "./import-extractors.js";
import type { EdgeLabel, MemoryNode } from "./schema.js";

/** A code file's extracted graph fragment: nodes plus label-keyed edges. */
export interface CodeExtraction {
  nodes: MemoryNode[];
  /** Edges declared by label — the indexer resolves labels to rids after upsert. */
  edges: Array<{ fromLabel: string; toLabel: string; label: EdgeLabel }>;
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

/**
 * Symbol-level code extraction (the deterministic `EXTRACTED` path).
 *
 * Ported from red-memory `packages/extractor/src/code.ts`. This slice ships the
 * regex symbol scanner — a fully deterministic parse that needs no native
 * toolchain. It also extracts conservative intra-file TS/JS call and type-use
 * edges between symbols. tree-sitter grammars (richer call/type graphs) are the planned
 * upgrade and slot in behind this same `CodeExtraction` shape; until then the
 * regex path is the tested surface, per issue #53 ("deterministic paths only").
 *
 * Produces one `file` node plus one `symbol` node per top-level declaration,
 * with a `DEFINED_IN` edge from each symbol to its file. Unsupported extensions
 * yield an empty extraction.
 */
export async function extractCode(path: string): Promise<CodeExtraction> {
  const ext = extname(path).toLowerCase();
  const lang = LANG_BY_EXT[ext];
  if (!lang) return { nodes: [], edges: [] };

  const source = await readFile(path, "utf8");
  const exports = exportedNames(source, lang);
  const fileNode: MemoryNode = {
    label: `file:${path}`,
    node_type: "file",
    properties: {
      title: path,
      language: lang,
      source: path,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-code",
        confidence: "EXTRACTED",
        evidence: [path],
      },
      hash: contentHash(path, source),
      // Exported symbol names, surfaced so the graph contract (#234) can
      // round-trip a file's public surface to consumers.
      ...(exports.length > 0 ? { exports } : {}),
    },
  };

  const symbolHits = regexSymbols(source, lang);
  const symbols = symbolHits.map<MemoryNode>((sym) => ({
    label: `sym:${path}#${sym.name}`,
    node_type: "symbol",
    properties: {
      title: sym.name,
      summary: sym.kind,
      source: `${path}:${sym.line}`,
      language: lang,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-code",
        confidence: "EXTRACTED",
        evidence: [`${path}:${sym.line}`],
      },
      hash: contentHash(path, sym.name, sym.kind),
    },
  }));

  const imports = extractImportsForFile(path, null, source).map<MemoryNode>((imp) => ({
    label: `import:${path}#${imp.specifier}`,
    node_type: "import",
    properties: {
      title: imp.specifier,
      summary: imp.kind === "relative" ? imp.resolvedPath : undefined,
      source: path,
      language: lang,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-code",
        confidence: "EXTRACTED",
        evidence: [path],
      },
      hash: contentHash(path, "import", imp.specifier),
      import_kind: imp.kind,
      ...(imp.resolvedPath ? { resolved_path: imp.resolvedPath } : {}),
    },
  }));

  const edges: CodeExtraction["edges"] = symbols.map((s) => ({
    fromLabel: s.label,
    toLabel: fileNode.label,
    label: "DEFINED_IN",
  }));
  edges.push(
    ...imports.map((imp) => ({
      fromLabel: fileNode.label,
      toLabel: imp.label,
      label: "IMPORTS" as const,
    })),
    ...extractCallEdges(path, source, lang, symbolHits),
    ...extractTypeEdges(path, source, lang, symbolHits),
  );

  return { nodes: [fileNode, ...symbols, ...imports], edges };
}

interface SymbolHit {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "struct";
  line: number;
  index: number;
}

const PATTERNS: Record<string, Array<{ kind: SymbolHit["kind"]; re: RegExp }>> = {
  typescript: [
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/gm },
    { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/gm },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_]\w*)/gm },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=/gm },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/gm },
  ],
  python: [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/gm },
  ],
  go: [
    { kind: "function", re: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)/gm },
    { kind: "struct", re: /^\s*type\s+([A-Za-z_]\w*)\s+struct/gm },
    { kind: "interface", re: /^\s*type\s+([A-Za-z_]\w*)\s+interface/gm },
  ],
  rust: [
    { kind: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm },
    { kind: "struct", re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm },
    { kind: "interface", re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/gm },
  ],
};

PATTERNS.tsx = PATTERNS.typescript ?? [];
PATTERNS.javascript = PATTERNS.typescript ?? [];

function regexSymbols(source: string, lang: string): SymbolHit[] {
  const patterns = PATTERNS[lang] ?? [];
  const hits: SymbolHit[] = [];
  for (const { kind, re } of patterns) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      const name = m[1];
      if (!name) continue;
      const line = (source.slice(0, m.index ?? 0).match(/\n/g)?.length ?? 0) + 1;
      hits.push({ name, kind, line, index: m.index ?? 0 });
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
}

function extractCallEdges(
  path: string,
  source: string,
  lang: string,
  symbols: SymbolHit[],
): CodeExtraction["edges"] {
  if (!["typescript", "tsx", "javascript"].includes(lang) || symbols.length === 0) {
    return [];
  }
  const callableNames = new Set(
    symbols
      .filter((symbol) => symbol.kind === "function" || symbol.kind === "const" || symbol.kind === "class")
      .map((symbol) => symbol.name),
  );
  const edges: CodeExtraction["edges"] = [];
  for (let i = 0; i < symbols.length; i++) {
    const from = symbols[i];
    if (!from || !callableNames.has(from.name)) continue;
    const body = source.slice(from.index, symbols[i + 1]?.index ?? source.length);
    const called = new Set<string>();
    const callRe = /\b(?:new\s+)?([A-Za-z_]\w*)\s*\(/g;
    for (const match of body.matchAll(callRe)) {
      const name = match[1];
      if (!name || name === from.name || !callableNames.has(name)) continue;
      called.add(name);
    }
    for (const name of called) {
      edges.push({
        fromLabel: `sym:${path}#${from.name}`,
        toLabel: `sym:${path}#${name}`,
        label: "CALLS",
      });
    }
  }
  return edges;
}

function extractTypeEdges(
  path: string,
  source: string,
  lang: string,
  symbols: SymbolHit[],
): CodeExtraction["edges"] {
  if (!["typescript", "tsx", "javascript"].includes(lang) || symbols.length === 0) {
    return [];
  }
  const typeNames = new Set(
    symbols
      .filter((symbol) => symbol.kind === "type" || symbol.kind === "interface" || symbol.kind === "class")
      .map((symbol) => symbol.name),
  );
  const edges: CodeExtraction["edges"] = [];
  for (let i = 0; i < symbols.length; i++) {
    const from = symbols[i];
    if (!from) continue;
    const body = source.slice(from.index, symbols[i + 1]?.index ?? source.length);
    const used = new Set<string>();
    for (const name of typeNames) {
      if (name === from.name) continue;
      if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(body)) used.add(name);
    }
    for (const name of used) {
      edges.push({
        fromLabel: `sym:${path}#${from.name}`,
        toLabel: `sym:${path}#${name}`,
        label: "USES_TYPE",
      });
    }
  }
  return edges;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Conservative, deterministic list of a file's exported names. Covers the
 * common declaration and re-export forms across the supported languages:
 *  - `export function/class/interface/type/const/let/var <name>` (TS/JS)
 *  - `export { a, b as c }` named clauses (TS/JS)
 *  - `pub fn/struct/trait/enum <name>` (Rust)
 * Python and Go have no keyword-level export marker (Go uses capitalization),
 * so they contribute nothing here — `exports` stays empty rather than guessing.
 */
function exportedNames(source: string, lang: string): string[] {
  const names = new Set<string>();
  if (["typescript", "tsx", "javascript"].includes(lang)) {
    const decl =
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_]\w*)/gm;
    for (const m of source.matchAll(decl)) if (m[1]) names.add(m[1]);
    const clause = /export\s*\{([^}]*)\}/g;
    for (const m of source.matchAll(clause)) {
      for (const part of (m[1] ?? "").split(",")) {
        const exported = part.trim().split(/\s+as\s+/i).pop()?.trim();
        if (exported && /^[A-Za-z_]\w*$/.test(exported)) names.add(exported);
      }
    }
  } else if (lang === "rust") {
    const decl = /^\s*pub\s+(?:async\s+)?(?:fn|struct|trait|enum|type|const|static)\s+([A-Za-z_]\w*)/gm;
    for (const m of source.matchAll(decl)) if (m[1]) names.add(m[1]);
  }
  return [...names];
}
