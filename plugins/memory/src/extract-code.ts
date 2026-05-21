import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { contentHash } from "./hash.js";
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
 * toolchain. tree-sitter grammars (call/import/type graphs) are the planned
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
  const fileNode: MemoryNode = {
    label: `file:${path}`,
    node_type: "file",
    properties: {
      title: path,
      language: lang,
      source: path,
      confidence: "EXTRACTED",
      hash: contentHash(path, source),
    },
  };

  const symbols = regexSymbols(source, lang).map<MemoryNode>((sym) => ({
    label: `sym:${path}#${sym.name}`,
    node_type: "symbol",
    properties: {
      title: sym.name,
      summary: sym.kind,
      source: `${path}:${sym.line}`,
      language: lang,
      confidence: "EXTRACTED",
      hash: contentHash(path, sym.name, sym.kind),
    },
  }));

  const edges: CodeExtraction["edges"] = symbols.map((s) => ({
    fromLabel: s.label,
    toLabel: fileNode.label,
    label: "DEFINED_IN",
  }));

  return { nodes: [fileNode, ...symbols], edges };
}

interface SymbolHit {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "struct";
  line: number;
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
      hits.push({ name, kind, line });
    }
  }
  return hits;
}
