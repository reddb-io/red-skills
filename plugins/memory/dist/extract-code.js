import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { contentHash } from "./hash.js";
import { extractImportsForFile } from "./import-extractors.js";
const LANG_BY_EXT = {
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
export async function extractCode(path) {
    const ext = extname(path).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang)
        return { nodes: [], edges: [] };
    const source = await readFile(path, "utf8");
    const fileNode = {
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
        },
    };
    const symbolHits = regexSymbols(source, lang);
    const symbols = symbolHits.map((sym) => ({
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
    const imports = extractImportsForFile(path, null, source).map((imp) => ({
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
    const edges = symbols.map((s) => ({
        fromLabel: s.label,
        toLabel: fileNode.label,
        label: "DEFINED_IN",
    }));
    edges.push(...imports.map((imp) => ({
        fromLabel: fileNode.label,
        toLabel: imp.label,
        label: "IMPORTS",
    })), ...extractCallEdges(path, source, lang, symbolHits), ...extractTypeEdges(path, source, lang, symbolHits));
    return { nodes: [fileNode, ...symbols, ...imports], edges };
}
const PATTERNS = {
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
function regexSymbols(source, lang) {
    const patterns = PATTERNS[lang] ?? [];
    const hits = [];
    for (const { kind, re } of patterns) {
        re.lastIndex = 0;
        for (const m of source.matchAll(re)) {
            const name = m[1];
            if (!name)
                continue;
            const line = (source.slice(0, m.index ?? 0).match(/\n/g)?.length ?? 0) + 1;
            hits.push({ name, kind, line, index: m.index ?? 0 });
        }
    }
    return hits.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
}
function extractCallEdges(path, source, lang, symbols) {
    if (!["typescript", "tsx", "javascript"].includes(lang) || symbols.length === 0) {
        return [];
    }
    const callableNames = new Set(symbols
        .filter((symbol) => symbol.kind === "function" || symbol.kind === "const" || symbol.kind === "class")
        .map((symbol) => symbol.name));
    const edges = [];
    for (let i = 0; i < symbols.length; i++) {
        const from = symbols[i];
        if (!from || !callableNames.has(from.name))
            continue;
        const body = source.slice(from.index, symbols[i + 1]?.index ?? source.length);
        const called = new Set();
        const callRe = /\b(?:new\s+)?([A-Za-z_]\w*)\s*\(/g;
        for (const match of body.matchAll(callRe)) {
            const name = match[1];
            if (!name || name === from.name || !callableNames.has(name))
                continue;
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
function extractTypeEdges(path, source, lang, symbols) {
    if (!["typescript", "tsx", "javascript"].includes(lang) || symbols.length === 0) {
        return [];
    }
    const typeNames = new Set(symbols
        .filter((symbol) => symbol.kind === "type" || symbol.kind === "interface" || symbol.kind === "class")
        .map((symbol) => symbol.name));
    const edges = [];
    for (let i = 0; i < symbols.length; i++) {
        const from = symbols[i];
        if (!from)
            continue;
        const body = source.slice(from.index, symbols[i + 1]?.index ?? source.length);
        const used = new Set();
        for (const name of typeNames) {
            if (name === from.name)
                continue;
            if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(body))
                used.add(name);
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
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
