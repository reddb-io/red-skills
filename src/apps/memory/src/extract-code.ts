import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { contentHash } from "./hash.js";
import { extractImportsForFile } from "./import-extractors.js";
import type { Confidence, EdgeLabel, MemoryEdgeProps, MemoryNode } from "./schema.js";
import type * as TypeScript from "typescript";

/** A code file's extracted graph fragment: nodes plus label-keyed edges. */
export interface CodeExtraction {
  nodes: MemoryNode[];
  /** Edges declared by label - the indexer resolves labels to rids after upsert. */
  edges: CodeEdgeExtraction[];
}

export interface CodeEdgeExtraction {
  fromLabel: string;
  toLabel: string;
  label: EdgeLabel;
  weight?: number;
  properties?: MemoryEdgeProps;
}

export interface ExtractCodeOptions {
  /** Test seam for exercising compiler-unavailable degradation. */
  loadTypeScript?: () => Promise<typeof TypeScript | null>;
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

const TS_LANGS = new Set(["typescript", "tsx"]);
const TS_JS_LANGS = new Set(["typescript", "tsx", "javascript"]);

const EDGE_WEIGHTS: Partial<Record<EdgeLabel, number>> = {
  DEFINED_IN: 1.2,
  IMPORTS: 0.9,
  CALLS: 1.1,
  USES_TYPE: 1.0,
};

/**
 * Symbol-level code extraction (the deterministic `EXTRACTED` path).
 *
 * TypeScript/TSX files prefer the TypeScript compiler API so Memory gets AST
 * source locations and checker-backed call/type-use edges. If the compiler is
 * unavailable or cannot parse the file, extraction falls back to the historical
 * deterministic regex scanner and marks the file node as degraded. Other
 * languages keep the regex import/symbol scanner.
 *
 * Produces one `file` node plus one `symbol` node per top-level declaration,
 * with a `DEFINED_IN` edge from each symbol to its file. Unsupported extensions
 * yield an empty extraction.
 */
export async function extractCode(
  path: string,
  options: ExtractCodeOptions = {},
): Promise<CodeExtraction> {
  const ext = extname(path).toLowerCase();
  const lang = LANG_BY_EXT[ext];
  if (!lang) return { nodes: [], edges: [] };

  const source = await readFile(path, "utf8");
  if (TS_LANGS.has(lang)) {
    const tsResult = await extractTypeScriptMap(path, source, lang, options);
    if ("extraction" in tsResult) return tsResult.extraction;
    return regexExtraction(path, source, lang, tsResult.fallbackReason);
  }

  return regexExtraction(path, source, lang);
}

type TypeScriptMapResult =
  | { extraction: CodeExtraction }
  | { fallbackReason: string };

async function extractTypeScriptMap(
  path: string,
  source: string,
  lang: string,
  options: ExtractCodeOptions,
): Promise<TypeScriptMapResult> {
  const ts = await (options.loadTypeScript ?? loadTypeScript)();
  if (ts == null) return { fallbackReason: "typescript compiler unavailable" };

  try {
    const program = createTypeScriptProgram(ts, path);
    const sourceFile = program.getSourceFile(path) ?? sourceFileByPath(ts, program, path);
    if (sourceFile == null) return { fallbackReason: "typescript source file unavailable" };

    const syntacticErrors = program
      .getSyntacticDiagnostics(sourceFile)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (syntacticErrors.length > 0) {
      const first = syntacticErrors[0];
      return {
        fallbackReason: `typescript syntax diagnostic ${first?.code ?? "unknown"}`,
      };
    }

    const checker = program.getTypeChecker();
    const symbols = compilerSymbols(ts, checker, sourceFile);
    const exports = compilerExportedNames(ts, checker, sourceFile, source);
    const imports = importLineMap(ts, sourceFile);
    const compilerRelations = compilerRelationEdges(ts, checker, sourceFile, path, symbols);
    const extraction = buildExtraction({
      path,
      source,
      lang,
      symbols,
      externalSymbols: compilerRelations.externalSymbols,
      exports,
      backend: "typescript-compiler",
      importLines: imports,
      extraEdges: compilerRelations.edges,
    });
    return { extraction };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fallbackReason: `typescript compiler extraction failed: ${message}` };
  }
}

async function loadTypeScript(): Promise<typeof TypeScript | null> {
  try {
    return await import("typescript");
  } catch {
    return null;
  }
}

function createTypeScriptProgram(ts: typeof TypeScript, path: string): TypeScript.Program {
  const configPath = ts.findConfigFile(dirname(path), ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    return ts.createProgram([path], {
      ...parsed.options,
      noEmit: true,
      skipLibCheck: true,
    });
  }

  return ts.createProgram([path], {
    allowJs: true,
    esModuleInterop: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  });
}

function sourceFileByPath(
  ts: typeof TypeScript,
  program: TypeScript.Program,
  path: string,
): TypeScript.SourceFile | undefined {
  const wanted = normalizePath(ts, path);
  return program.getSourceFiles().find((sourceFile) => normalizePath(ts, sourceFile.fileName) === wanted);
}

function normalizePath(ts: typeof TypeScript, path: string): string {
  return ts.sys.useCaseSensitiveFileNames ? resolve(path) : resolve(path).toLowerCase();
}

function regexExtraction(
  path: string,
  source: string,
  lang: string,
  fallbackReason?: string,
): CodeExtraction {
  const symbolHits = regexSymbols(source, lang);
  return buildExtraction({
    path,
    source,
    lang,
    symbols: symbolHits,
    exports: exportedNames(source, lang),
    backend: fallbackReason ? "regex-fallback" : "regex",
    fallbackReason,
    extraEdges: [
      ...extractCallEdges(path, source, lang, symbolHits, fallbackReason ? "regex-fallback" : "regex"),
      ...extractTypeEdges(path, source, lang, symbolHits, fallbackReason ? "regex-fallback" : "regex"),
    ],
  });
}

interface BuildExtractionInput {
  path: string;
  source: string;
  lang: string;
  symbols: SymbolHit[];
  externalSymbols?: SymbolHit[];
  exports: string[];
  backend: string;
  fallbackReason?: string;
  importLines?: Map<string, number>;
  extraEdges?: CodeEdgeExtraction[];
}

function buildExtraction(input: BuildExtractionInput): CodeExtraction {
  const { path, source, lang, symbols: symbolHits, exports, backend, fallbackReason } = input;
  const fileNode: MemoryNode = {
    label: `file:${path}`,
    node_type: "file",
    properties: {
      title: path,
      language: lang,
      source: path,
      source_location: sourceLocation(path, 1),
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-code",
        confidence: "EXTRACTED",
        evidence: [path],
      },
      hash: contentHash(path, source),
      extraction_backend: backend,
      ...(fallbackReason
        ? { extraction_degraded: true, extraction_degradation_reason: fallbackReason }
        : {}),
      ...(exports.length > 0 ? { exports } : {}),
    },
  };

  const allSymbols = dedupeSymbols([...symbolHits, ...(input.externalSymbols ?? [])], path);
  const symbolNodes = allSymbols.map<MemoryNode>((sym) => ({
    label: symbolLabel(sym, path),
    node_type: "symbol",
    properties: {
      title: sym.name,
      summary: sym.kind,
      source: sourceLocation(symbolPath(sym, path), sym.line),
      source_location: sourceLocation(symbolPath(sym, path), sym.line, sym.column),
      ...(sym.endLine
        ? {
            source_span: {
              path: symbolPath(sym, path),
              start_line: sym.line,
              start_column: sym.column,
              end_line: sym.endLine,
              end_column: sym.endColumn,
            },
          }
        : {}),
      language: lang,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-code",
        confidence: "EXTRACTED",
        evidence: [sourceLocation(symbolPath(sym, path), sym.line)],
      },
      hash: contentHash(symbolPath(sym, path), sym.name, sym.kind),
      extraction_backend: backend,
    },
  }));
  const localSymbolLabels = new Set(symbolHits.map((sym) => symbolLabel(sym, path)));

  const imports = extractImportsForFile(path, null, source).map<MemoryNode>((imp) => {
    const line = input.importLines?.get(imp.specifier);
    const location = line ? sourceLocation(path, line) : path;
    return {
      label: `import:${path}#${imp.specifier}`,
      node_type: "import",
      properties: {
        title: imp.specifier,
        summary: imp.kind === "relative" ? imp.resolvedPath : undefined,
        source: location,
        source_location: location,
        language: lang,
        confidence: "EXTRACTED",
        provenance: {
          source_kind: "derived",
          writer: "extract-code",
          confidence: "EXTRACTED",
          evidence: [location],
        },
        hash: contentHash(path, "import", imp.specifier),
        import_kind: imp.kind,
        extraction_backend: backend,
        ...(imp.resolvedPath ? { resolved_path: imp.resolvedPath } : {}),
      },
    };
  });

  const edges: CodeExtraction["edges"] = symbolNodes
    .filter((s) => localSymbolLabels.has(s.label))
    .map((s) =>
      codeEdge({
        path,
        fromLabel: s.label,
        toLabel: fileNode.label,
        label: "DEFINED_IN",
        backend,
        source: stringValue(s.properties.source) ?? path,
        reason: "symbol is declared in file",
      }),
    );
  edges.push(
    ...imports.map((imp) =>
      codeEdge({
        path,
        fromLabel: fileNode.label,
        toLabel: imp.label,
        label: "IMPORTS",
        backend,
        source: stringValue(imp.properties.source) ?? path,
        reason: "file imports module specifier",
      }),
    ),
    ...(input.extraEdges ?? []),
  );

  return { nodes: [fileNode, ...symbolNodes, ...imports], edges };
}

interface CodeEdgeInput {
  path: string;
  fromLabel: string;
  toLabel: string;
  label: EdgeLabel;
  backend: string;
  source?: string;
  reason?: string;
  confidence?: Confidence;
}

function codeEdge(input: CodeEdgeInput): CodeEdgeExtraction {
  const confidence = input.confidence ?? "EXTRACTED";
  const weight = EDGE_WEIGHTS[input.label] ?? 1.0;
  const evidence = input.source ?? input.path;
  return {
    fromLabel: input.fromLabel,
    toLabel: input.toLabel,
    label: input.label,
    weight,
    properties: {
      confidence,
      source: evidence,
      source_location: evidence,
      weight,
      topological_weight: weight,
      reason: input.reason,
      extraction_backend: input.backend,
      provenance: {
        source_kind: "derived",
        writer: "extract-code",
        confidence,
        evidence: [evidence],
      },
    },
  };
}

interface SymbolHit {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "struct" | "enum";
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  index: number;
  sourcePath?: string;
  tsSymbol?: TypeScript.Symbol;
  node?: TypeScript.Node;
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
  return sortSymbols(hits);
}

function compilerSymbols(
  ts: typeof TypeScript,
  checker: TypeScript.TypeChecker,
  sourceFile: TypeScript.SourceFile,
): SymbolHit[] {
  const hits: SymbolHit[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      hits.push(symbolHitForNode(ts, checker, sourceFile, statement.name, statement, "function"));
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      hits.push(symbolHitForNode(ts, checker, sourceFile, statement.name, statement, "class"));
      continue;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      hits.push(symbolHitForNode(ts, checker, sourceFile, statement.name, statement, "interface"));
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      hits.push(symbolHitForNode(ts, checker, sourceFile, statement.name, statement, "type"));
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      hits.push(symbolHitForNode(ts, checker, sourceFile, statement.name, statement, "enum"));
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        hits.push(symbolHitForNode(ts, checker, sourceFile, declaration.name, declaration, "const"));
      }
    }
  }

  return sortSymbols(hits);
}

function symbolHitForNode(
  ts: typeof TypeScript,
  checker: TypeScript.TypeChecker,
  sourceFile: TypeScript.SourceFile,
  nameNode: TypeScript.Identifier,
  node: TypeScript.Node,
  kind: SymbolHit["kind"],
): SymbolHit {
  const start = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  const end = ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd());
  return {
    name: nameNode.text,
    kind,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    index: node.getStart(sourceFile),
    tsSymbol: checker.getSymbolAtLocation(nameNode),
    node,
  };
}

function symbolPath(sym: SymbolHit, fallbackPath: string): string {
  return sym.sourcePath ?? fallbackPath;
}

function symbolLabel(sym: SymbolHit, fallbackPath: string): string {
  return `sym:${symbolPath(sym, fallbackPath)}#${sym.name}`;
}

function dedupeSymbols(symbols: SymbolHit[], fallbackPath: string): SymbolHit[] {
  const byLabel = new Map<string, SymbolHit>();
  for (const symbol of symbols) {
    const label = symbolLabel(symbol, fallbackPath);
    if (!byLabel.has(label)) byLabel.set(label, symbol);
  }
  return [...byLabel.values()];
}

function sortSymbols(hits: SymbolHit[]): SymbolHit[] {
  return hits.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
}

function compilerExportedNames(
  ts: typeof TypeScript,
  checker: TypeScript.TypeChecker,
  sourceFile: TypeScript.SourceFile,
  source: string,
): string[] {
  const names = new Set(exportedNames(source, "typescript"));
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      if (exported.name !== "default") names.add(exported.name);
    }
  }
  sourceFile.forEachChild((node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name &&
      hasExportModifier(ts, node)
    ) {
      names.add(node.name.text);
    }
  });
  return [...names].sort();
}

function hasExportModifier(ts: typeof TypeScript, node: TypeScript.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function importLineMap(
  ts: typeof TypeScript,
  sourceFile: TypeScript.SourceFile,
): Map<string, number> {
  const lines = new Map<string, number>();
  const remember = (literal: TypeScript.StringLiteralLike): void => {
    const line = ts.getLineAndCharacterOfPosition(sourceFile, literal.getStart(sourceFile)).line + 1;
    if (!lines.has(literal.text)) lines.set(literal.text, line);
  };
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      remember(statement.moduleSpecifier);
    }
  }
  return lines;
}

interface CompilerRelationExtraction {
  edges: CodeExtraction["edges"];
  externalSymbols: SymbolHit[];
}

function compilerRelationEdges(
  ts: typeof TypeScript,
  checker: TypeScript.TypeChecker,
  sourceFile: TypeScript.SourceFile,
  path: string,
  symbols: SymbolHit[],
): CompilerRelationExtraction {
  const externals = new Map<string, SymbolHit>();
  const externalSymbol = (symbol: TypeScript.Symbol | undefined): SymbolHit | undefined => {
    const hit = compilerExternalSymbol(ts, checker, sourceFile, symbol);
    if (!hit) return undefined;
    const label = symbolLabel(hit, path);
    const existing = externals.get(label);
    if (existing) return existing;
    externals.set(label, hit);
    return hit;
  };
  return {
    edges: [
      ...compilerCallEdges(ts, checker, sourceFile, path, symbols, externalSymbol),
      ...compilerTypeEdges(ts, checker, sourceFile, path, symbols, externalSymbol),
    ],
    externalSymbols: [...externals.values()],
  };
}

function compilerExternalSymbol(
  ts: typeof TypeScript,
  checker: TypeScript.TypeChecker,
  currentSourceFile: TypeScript.SourceFile,
  symbol: TypeScript.Symbol | undefined,
): SymbolHit | undefined {
  const resolved = resolveAlias(checker, symbol);
  const declaration = resolved?.declarations?.find((candidate) => {
    const declarationSource = candidate.getSourceFile();
    return (
      declarationSource.fileName !== currentSourceFile.fileName &&
      !declarationSource.isDeclarationFile &&
      declarationKind(ts, candidate) != null
    );
  });
  if (!declaration) return undefined;

  const sourceFile = declaration.getSourceFile();
  const nameNode = declarationNameNode(ts, declaration);
  const kind = declarationKind(ts, declaration);
  if (!nameNode || !kind) return undefined;

  return {
    ...symbolHitForNode(ts, checker, sourceFile, nameNode, declaration, kind),
    sourcePath: sourceFile.fileName,
  };
}

function declarationNameNode(
  ts: typeof TypeScript,
  node: TypeScript.Declaration,
): TypeScript.Identifier | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name;
  }
  return undefined;
}

function declarationKind(
  ts: typeof TypeScript,
  node: TypeScript.Declaration,
): SymbolHit["kind"] | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableDeclaration(node)) return "const";
  return undefined;
}

function isCallableKind(kind: SymbolHit["kind"]): boolean {
  return kind === "function" || kind === "const" || kind === "class";
}

function isTypeKind(kind: SymbolHit["kind"]): boolean {
  return kind === "type" || kind === "interface" || kind === "class" || kind === "enum";
}

function compilerCallEdges(
  ts: typeof TypeScript,
  checker: TypeScript.TypeChecker,
  sourceFile: TypeScript.SourceFile,
  path: string,
  symbols: SymbolHit[],
  externalSymbol?: (symbol: TypeScript.Symbol | undefined) => SymbolHit | undefined,
): CodeExtraction["edges"] {
  const bySymbol = localSymbolMap(checker, symbols);
  const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const edges: CodeExtraction["edges"] = [];

  for (const from of symbols) {
    if (!from.node || !isCallableKind(from.kind)) continue;
    const called = new Map<string, { symbol: SymbolHit; line: number }>();
    visit(from.node, (node) => {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
      const expression = node.expression;
      const symbol = checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(expression) ? expression.name : expression,
      );
      const resolved = resolveAlias(checker, symbol);
      const to =
        (resolved ? bySymbol.get(resolved) : undefined) ??
        byName.get(symbol?.name ?? "") ??
        externalSymbol?.(resolved ?? symbol);
      if (
        !to ||
        symbolLabel(to, path) === symbolLabel(from, path) ||
        !isCallableKind(to.kind)
      ) {
        return;
      }
      const line =
        ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart(sourceFile)).line + 1;
      called.set(symbolLabel(to, path), { symbol: to, line });
    });
    for (const { symbol, line } of called.values()) {
      edges.push(
        codeEdge({
          path,
          fromLabel: symbolLabel(from, path),
          toLabel: symbolLabel(symbol, path),
          label: "CALLS",
          backend: "typescript-compiler",
          source: sourceLocation(path, line),
          reason: "checker resolved call expression to symbol",
        }),
      );
    }
  }
  return edges;
}

function compilerTypeEdges(
  ts: typeof TypeScript,
  checker: TypeScript.TypeChecker,
  sourceFile: TypeScript.SourceFile,
  path: string,
  symbols: SymbolHit[],
  externalSymbol?: (symbol: TypeScript.Symbol | undefined) => SymbolHit | undefined,
): CodeExtraction["edges"] {
  const bySymbol = localSymbolMap(checker, symbols);
  const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const edges: CodeExtraction["edges"] = [];

  for (const from of symbols) {
    if (!from.node) continue;
    const used = new Map<string, { symbol: SymbolHit; line: number }>();
    visit(from.node, (node) => {
      const targetNode = typeReferenceNameNode(ts, node);
      if (!targetNode) return;
      const symbol = checker.getSymbolAtLocation(targetNode);
      const resolved = resolveAlias(checker, symbol);
      const to =
        (resolved ? bySymbol.get(resolved) : undefined) ??
        byName.get(targetNode.getText(sourceFile)) ??
        externalSymbol?.(resolved ?? symbol);
      if (!to || symbolLabel(to, path) === symbolLabel(from, path) || !isTypeKind(to.kind)) {
        return;
      }
      const line =
        ts.getLineAndCharacterOfPosition(sourceFile, targetNode.getStart(sourceFile)).line + 1;
      used.set(symbolLabel(to, path), { symbol: to, line });
    });
    for (const { symbol, line } of used.values()) {
      edges.push(
        codeEdge({
          path,
          fromLabel: symbolLabel(from, path),
          toLabel: symbolLabel(symbol, path),
          label: "USES_TYPE",
          backend: "typescript-compiler",
          source: sourceLocation(path, line),
          reason: "checker resolved type reference to symbol",
        }),
      );
    }
  }

  return edges;
}

function localSymbolMap(
  checker: TypeScript.TypeChecker,
  symbols: SymbolHit[],
): Map<TypeScript.Symbol, SymbolHit> {
  const bySymbol = new Map<TypeScript.Symbol, SymbolHit>();
  for (const symbol of symbols) {
    if (!symbol.tsSymbol) continue;
    bySymbol.set(symbol.tsSymbol, symbol);
    const resolved = resolveAlias(checker, symbol.tsSymbol);
    if (resolved) bySymbol.set(resolved, symbol);
  }
  return bySymbol;
}

function resolveAlias(
  checker: TypeScript.TypeChecker,
  symbol: TypeScript.Symbol | undefined,
): TypeScript.Symbol | undefined {
  if (!symbol) return undefined;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function typeReferenceNameNode(
  ts: typeof TypeScript,
  node: TypeScript.Node,
): TypeScript.Node | null {
  if (ts.isTypeReferenceNode(node)) {
    return rightmostEntityName(ts, node.typeName);
  }
  if (ts.isExpressionWithTypeArguments(node)) {
    return ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  }
  return null;
}

function rightmostEntityName(ts: typeof TypeScript, name: TypeScript.EntityName): TypeScript.Node {
  return ts.isQualifiedName(name) ? name.right : name;
}

function visit(node: TypeScript.Node, each: (node: TypeScript.Node) => void): void {
  each(node);
  node.forEachChild((child) => visit(child, each));
}

function extractCallEdges(
  path: string,
  source: string,
  lang: string,
  symbols: SymbolHit[],
  backend: string,
): CodeExtraction["edges"] {
  if (!TS_JS_LANGS.has(lang) || symbols.length === 0) {
    return [];
  }
  const callableNames = new Set(
    symbols
      .filter((symbol) => isCallableKind(symbol.kind))
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
      edges.push(
        codeEdge({
          path,
          fromLabel: `sym:${path}#${from.name}`,
          toLabel: `sym:${path}#${name}`,
          label: "CALLS",
          backend,
          source: sourceLocation(path, from.line),
          reason: "regex scanner found local call expression",
        }),
      );
    }
  }
  return edges;
}

function extractTypeEdges(
  path: string,
  source: string,
  lang: string,
  symbols: SymbolHit[],
  backend: string,
): CodeExtraction["edges"] {
  if (!TS_JS_LANGS.has(lang) || symbols.length === 0) {
    return [];
  }
  const typeNames = new Set(
    symbols
      .filter((symbol) => isTypeKind(symbol.kind))
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
      edges.push(
        codeEdge({
          path,
          fromLabel: `sym:${path}#${from.name}`,
          toLabel: `sym:${path}#${name}`,
          label: "USES_TYPE",
          backend,
          source: sourceLocation(path, from.line),
          reason: "regex scanner found local type reference",
        }),
      );
    }
  }
  return edges;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceLocation(path: string, line: number, column?: number): string {
  return column == null ? `${path}:${line}` : `${path}:${line}:${column}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Conservative, deterministic list of a file's exported names. Covers the
 * common declaration and re-export forms across the supported languages:
 *  - `export function/class/interface/type/const/let/var <name>` (TS/JS)
 *  - `export { a, b as c }` named clauses (TS/JS)
 *  - `pub fn/struct/trait/enum <name>` (Rust)
 * Python and Go have no keyword-level export marker (Go uses capitalization),
 * so they contribute nothing here - `exports` stays empty rather than guessing.
 */
function exportedNames(source: string, lang: string): string[] {
  const names = new Set<string>();
  if (TS_JS_LANGS.has(lang)) {
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
  return [...names].sort();
}
