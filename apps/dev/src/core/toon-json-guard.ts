import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { ALLOWLIST_PATH } from "./shared-gate.js";

export type ToonJsonIoKind = "json-parse-file-read" | "json-stringify-file-write";
export type ToonJsonAllowlistClassification = "migrate" | "external";

export interface ToonJsonIoFinding {
  id: string;
  kind: ToonJsonIoKind;
  relativePath: string;
  line: number;
  column: number;
  snippet: string;
  /** Path-independent identity (sha1 of kind + snippet). Stable when a
   * behavior-preserving file-split relocates the site to a new file, so the
   * guard recognizes a move instead of redding on the new path's fresh id. */
  moveKey: string;
}

export interface ToonJsonAllowlistEntry {
  id: string;
  classification: ToonJsonAllowlistClassification;
  reason?: string;
  /** Path-independent identity of the site (see ToonJsonIoFinding.moveKey). A
   * stale external entry offers its moveKey to absorb the one relocated finding
   * carrying the same key, so a file-split move never reds the guard. */
  moveKey?: string;
}

export interface ToonJsonGuardReport {
  findings: ToonJsonIoFinding[];
  allowlist: ToonJsonAllowlistEntry[];
}

export interface ToonJsonSourceFile {
  relativePath: string;
  sourceText: string;
}

const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx"]);
const SKIP_DIRS = new Set([
  ".git",
  ".red",
  ".turbo",
  "coverage",
  "dist",
  "docs",
  "node_modules",
  "test",
  "tests",
  "__tests__",
  "fixtures",
]);
const READ_FILE_NAMES = new Set(["readFile", "readFileSync"]);
const WRITE_FILE_NAMES = new Set(["appendFile", "appendFileSync", "writeFile", "writeFileSync"]);

interface FsBindings {
  readIdentifiers: Set<string>;
  writeIdentifiers: Set<string>;
  namespaces: Set<string>;
}

type JsonOrigin = "file-read" | "json-stringify";

export function collectToonJsonGuardReport(root: string): ToonJsonGuardReport {
  return {
    findings: collectToonJsonIoFindings(root),
    allowlist: readToonJsonAllowlist(root),
  };
}

export function collectToonJsonIoFindings(root: string): ToonJsonIoFinding[] {
  return collectToonJsonIoFindingsFromFiles(readSourceFiles(root));
}

export function collectToonJsonIoFindingsFromFiles(files: readonly ToonJsonSourceFile[]): ToonJsonIoFinding[] {
  return files.flatMap((file) => collectFileFindings(file)).sort((a, b) => a.id.localeCompare(b.id));
}

export function formatToonJsonGuardViolations(report: ToonJsonGuardReport): string[] {
  const findingsById = new Map(report.findings.map((finding) => [finding.id, finding]));
  const allowlistIds = new Set(report.allowlist.map((entry) => entry.id));
  const seenAllowlistIds = new Set<string>();
  const violations: string[] = [];

  // Path-independent keys of EXTERNAL allowlist entries whose exact id has no
  // current finding — the site at that path/snippet is gone. Each such stale
  // external move key can absorb one relocated finding sharing the same key: a
  // behavior-preserving file-split moved the site to a new file (new id, but the
  // same kind + snippet, hence the same moveKey). Counted so a stale entry
  // launders at most ONE occurrence — a genuinely-new second site with the same
  // snippet still reds the guard.
  const relocatable = new Map<string, number>();
  for (const entry of report.allowlist) {
    if (entry.classification === "external" && entry.moveKey && !findingsById.has(entry.id)) {
      relocatable.set(entry.moveKey, (relocatable.get(entry.moveKey) ?? 0) + 1);
    }
  }

  for (const entry of report.allowlist) {
    if (seenAllowlistIds.has(entry.id)) violations.push(`duplicate allowlist id ${entry.id}`);
    seenAllowlistIds.add(entry.id);
    if (entry.classification !== "migrate" && entry.classification !== "external") {
      violations.push(`allowlist id ${entry.id} has invalid classification ${String(entry.classification)}`);
    }
    if (entry.classification === "external" && !entry.reason?.trim()) {
      violations.push(`external allowlist id ${entry.id} must include a one-line reason`);
    }
    // A stale entry (no finding at its exact id) is NOT flagged: a stale migrate
    // entry means a to-convert site was TOON-ified or deleted (the goal); a stale
    // external entry is a moved/removed external site whose moveKey is offered
    // above. Leftover ids are harmless cruft a periodic re-seed prunes.
  }

  for (const finding of report.findings) {
    if (allowlistIds.has(finding.id)) continue;
    // Unallowlisted by exact id. Tolerate iff a stale external entry with the same
    // moveKey is available (a relocation), consuming it 1:1. Otherwise this is a
    // genuinely-new JSON I/O site that must be classified.
    const available = relocatable.get(finding.moveKey) ?? 0;
    if (available > 0) {
      relocatable.set(finding.moveKey, available - 1);
      continue;
    }
    violations.push(
      `unallowlisted ${finding.kind} ${finding.id} at ${finding.relativePath}:${finding.line}:${finding.column} ${finding.snippet}`,
    );
  }

  return violations;
}

/**
 * The failure message the ratchet assertion carries (issue #2762). A bare
 * `expect(violations).toEqual([])` prints `expected [ Array(1) ] to deeply equal
 * []` — the diff names neither the offending path nor what to do about it, so a
 * worker reading its own gate output learns only that something broke. This
 * spells out each violation, the allowlist file that classifies it, and the
 * `.toon`-written-as-JSON shape that is the recurring cause. PURE.
 */
export function formatToonJsonGuardFailureMessage(violations: readonly string[]): string {
  if (violations.length === 0) return "";
  const plural = violations.length === 1 ? "site" : "sites";
  return [
    `TOON JSON file-I/O ratchet: ${violations.length} unresolved ${plural}.`,
    ...violations.map((violation) => `  - ${violation}`),
    `Fix each site (write TOON via @reddb-io/toon) or classify it in ${ALLOWLIST_PATH}.`,
    "A `*.toon` path written with JSON.stringify is a violation even though the decoder" +
      " sniffs JSON-or-TOON and accepts it at runtime — it looks correct locally and is wrong by policy.",
  ].join("\n");
}

export function readToonJsonAllowlist(root: string): ToonJsonAllowlistEntry[] {
  const allowlistPath = join(root, ALLOWLIST_PATH);
  if (!existsSync(allowlistPath)) return [];
  const raw = readFileSync(allowlistPath, "utf8");
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) return [];
  return parsed.entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      id: String(record.id ?? ""),
      classification: record.classification === "external" ? "external" : "migrate",
      reason: typeof record.reason === "string" ? record.reason : undefined,
      moveKey: typeof record.moveKey === "string" ? record.moveKey : undefined,
    };
  });
}

function readSourceFiles(root: string): ToonJsonSourceFile[] {
  const roots = ["apps", "packages"];
  const files: ToonJsonSourceFile[] = [];
  for (const sourceRoot of roots) {
    const absoluteRoot = join(root, sourceRoot);
    if (existsSync(absoluteRoot)) collectSourceFiles(root, absoluteRoot, files);
  }
  return files;
}

function collectSourceFiles(root: string, dir: string, out: ToonJsonSourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(root, join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = join(dir, entry.name);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!isGuardedSourceFile(relativePath)) continue;
    out.push({ relativePath, sourceText: readFileSync(absolutePath, "utf8") });
  }
}

function isGuardedSourceFile(relativePath: string): boolean {
  const base = relativePath.split("/").at(-1) ?? "";
  if (base.includes(".test.") || base.includes(".spec.") || base.endsWith(".d.ts")) return false;
  const dot = base.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(base.slice(dot));
}

function collectFileFindings(file: ToonJsonSourceFile): ToonJsonIoFinding[] {
  const sourceFile = ts.createSourceFile(file.relativePath, file.sourceText, ts.ScriptTarget.Latest, true);
  const bindings = collectFsBindings(sourceFile);
  const origins = new Map<string, JsonOrigin>();
  const findings: ToonJsonIoFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const origin = expressionOrigin(node.initializer, origins, bindings);
      if (origin) origins.set(node.name.text, origin);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const origin = expressionOrigin(node.right, origins, bindings);
      if (origin) origins.set(node.left.text, origin);
    }
    if (ts.isCallExpression(node)) {
      if (isJsonParseCall(node) && node.arguments.some((arg) => expressionOrigin(arg, origins, bindings) === "file-read")) {
        findings.push(makeFinding(file, sourceFile, node, "json-parse-file-read"));
      }
      if (isFileWriteCall(node, bindings) && node.arguments.slice(1).some((arg) => expressionOrigin(arg, origins, bindings) === "json-stringify")) {
        findings.push(makeFinding(file, sourceFile, node, "json-stringify-file-write"));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

function collectFsBindings(sourceFile: ts.SourceFile): FsBindings {
  const bindings: FsBindings = {
    readIdentifiers: new Set(),
    writeIdentifiers: new Set(),
    namespaces: new Set(),
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleName) || !["fs", "node:fs", "node:fs/promises"].includes(moduleName.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.namespaces.add(clause.name.text);
    const namedBindings = clause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      bindings.namespaces.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      if (READ_FILE_NAMES.has(imported)) bindings.readIdentifiers.add(local);
      if (WRITE_FILE_NAMES.has(imported)) bindings.writeIdentifiers.add(local);
      if (imported === "promises") bindings.namespaces.add(local);
    }
  }

  return bindings;
}

function expressionOrigin(expression: ts.Expression, origins: ReadonlyMap<string, JsonOrigin>, bindings: FsBindings): JsonOrigin | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return origins.get(unwrapped.text) ?? null;
  if (ts.isCallExpression(unwrapped)) {
    if (isFileReadCall(unwrapped, bindings)) return "file-read";
    if (isJsonStringifyCall(unwrapped)) return "json-stringify";
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const left = expressionOrigin(unwrapped.left, origins, bindings);
    const right = expressionOrigin(unwrapped.right, origins, bindings);
    if (left === "json-stringify" || right === "json-stringify") return "json-stringify";
    if (left === "file-read" || right === "file-read") return "file-read";
  }
  if (ts.isTemplateExpression(unwrapped)) {
    for (const span of unwrapped.templateSpans) {
      const origin = expressionOrigin(span.expression, origins, bindings);
      if (origin) return origin;
    }
  }
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isJsonParseCall(node: ts.CallExpression): boolean {
  return isJsonCall(node, "parse");
}

function isJsonStringifyCall(node: ts.CallExpression): boolean {
  return isJsonCall(node, "stringify");
}

function isJsonCall(node: ts.CallExpression, method: "parse" | "stringify"): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === method &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON"
  );
}

function isFileReadCall(node: ts.CallExpression, bindings: FsBindings): boolean {
  return isFsCall(node, bindings, READ_FILE_NAMES, bindings.readIdentifiers);
}

function isFileWriteCall(node: ts.CallExpression, bindings: FsBindings): boolean {
  return isFsCall(node, bindings, WRITE_FILE_NAMES, bindings.writeIdentifiers);
}

function isFsCall(
  node: ts.CallExpression,
  bindings: FsBindings,
  importedNames: ReadonlySet<string>,
  importedIdentifiers: ReadonlySet<string>,
): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return importedIdentifiers.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) || !importedNames.has(expression.name.text)) return false;
  const root = leftmostIdentifier(expression.expression);
  return root ? bindings.namespaces.has(root.text) : false;
}

function leftmostIdentifier(expression: ts.Expression): ts.Identifier | null {
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current : null;
}

function makeFinding(
  file: ToonJsonSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  kind: ToonJsonIoKind,
): ToonJsonIoFinding {
  const start = node.getStart(sourceFile);
  const pos = sourceFile.getLineAndCharacterOfPosition(start);
  const snippet = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  const line = pos.line + 1;
  const column = pos.character + 1;
  // Snippet-anchored id: independent of line/column so a pure line shift (an
  // unrelated edit above the site) never invalidates an allowlist entry. Only a
  // change to the JSON statement text itself mints a new id (and warrants
  // re-review). line/column survive as finding fields for the violation message.
  const hash = createHash("sha1").update(`${kind}\0${file.relativePath}\0${snippet}`).digest("hex").slice(0, 12);
  // Path-independent identity: kind + snippet only (no path). A behavior-
  // preserving split that moves this site to a new file keeps kind + snippet,
  // hence the same moveKey, so the guard recognizes the relocation instead of
  // redding on the new path's fresh id (see formatToonJsonGuardViolations).
  const moveKey = createHash("sha1").update(`${kind}\0${snippet}`).digest("hex").slice(0, 12);
  return {
    id: `${file.relativePath}#${kind}#${hash}`,
    kind,
    relativePath: file.relativePath,
    line,
    column,
    snippet,
    moveKey,
  };
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
