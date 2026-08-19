// repair-guard — every castle refusal and empty state is declared and carries
// a callable repair or an argued none (ADR 0134 decision 5, issues #3260/#3261).

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface RepairScanFile {
  readonly path: string;
  readonly sourceText: string;
}

export type RepairSurface = "refusal" | "empty-state";

/** One outward castle site that must keep its repair contract. */
export interface RepairSite {
  readonly path: string;
  /** Stable enclosing function name; line numbers are diagnostics only. */
  readonly fn: string;
  readonly line: number;
  readonly surface: RepairSurface;
}

/** One reviewed member of the repair inventory. */
export interface DeclaredRepairSite {
  readonly path: string;
  readonly fn: string;
  readonly surface: RepairSurface;
}

/**
 * The live castle repair inventory.
 *
 * The scan finds structured refusals (`refused: true`) and composed empty
 * states. A new site must be added here in the same slice that gives it a
 * repair; a removed path must remove its declaration in the same slice.
 */
export const DECLARED_REPAIR_SITES: readonly DeclaredRepairSite[] = [
  {
    path: "packages/worker/src/mcp/posture.ts",
    fn: "refusal",
    surface: "refusal",
  },
  {
    path: "packages/worker/src/mcp/worker.ts",
    fn: "workerInputRefusal",
    surface: "refusal",
  },
  {
    path: "packages/worker/src/mcp/help.ts",
    fn: "invoke",
    surface: "empty-state",
  },
];

export interface RepairViolation {
  readonly path: string;
  readonly line: number;
  readonly reason:
    | "structured refusal has no repair or argued none"
    | "repair none has no repair_reason";
}

export type RepairDeclarationViolation =
  | ({ readonly kind: "undeclared" } & RepairSite)
  | ({ readonly kind: "stale" } & DeclaredRepairSite)
  | ({ readonly kind: "invalid-repair" } & RepairViolation);

/**
 * Scanned as a DIRECTORY, not as one file, so every engine refusal is covered.
 * The deleted Dev MCP workflow implementation is intentionally absent: the
 * surviving stdio adapter translates every invocation into ACP.
 */
export const REPAIR_SCAN_ROOTS = [
  "packages/worker/src/mcp",
] as const;

export function readRepairScanFiles(
  root: string,
  roots: readonly string[] = REPAIR_SCAN_ROOTS,
): RepairScanFile[] {
  const files: RepairScanFile[] = [];
  const visit = (absolute: string) => {
    const path = relative(root, absolute).split(sep).join("/");
    if (/\.(?:test|spec)\.ts$/.test(path)) return;
    files.push({ path, sourceText: readFileSync(absolute, "utf8") });
  };
  const walk = (absolute: string) => {
    const entries = readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) visit(child);
    }
  };
  for (const scanRoot of roots) {
    const absolute = join(root, scanRoot);
    if (scanRoot.endsWith(".ts")) visit(absolute);
    else walk(absolute);
  }
  return files;
}

/**
 * Enumerate outward repair sites by stable `(path, function, surface)` key.
 *
 * A composed state without `refused: true` is an empty state. If a function
 * contains both a composer and an explicit refusal marker it is one refusal
 * site, not two implementation-detail reaches.
 */
export function collectRepairSites(files: readonly RepairScanFile[]): RepairSite[] {
  const sites = new Map<string, RepairSite>();
  for (const file of files) {
    const structural = blankCommentsAndStrings(file.sourceText);
    const reaches: Array<{ index: number; surface: RepairSurface }> = [];
    for (const match of structural.matchAll(/\bcomposeRepair\s*\(/g)) {
      reaches.push({ index: match.index ?? 0, surface: "empty-state" });
    }
    for (const match of structural.matchAll(/\brefused\s*:\s*true\b/g)) {
      const index = match.index ?? 0;
      const open = enclosingOpenBrace(structural, index);
      if (open >= 0 && isTypeDeclaration(structural, open)) continue;
      reaches.push({ index, surface: "refusal" });
    }
    reaches.sort((a, b) => a.index - b.index);

    for (const reach of reaches) {
      const fn = enclosingFunctionName(structural, reach.index);
      const line = file.sourceText.slice(0, reach.index).split("\n").length;
      const baseKey = `${file.path}\0${fn}`;
      const existing = sites.get(baseKey);
      if (existing === undefined || reach.surface === "refusal") {
        sites.set(baseKey, { path: file.path, fn, line, surface: reach.surface });
      }
    }
  }
  return [...sites.values()];
}

/** Compare the swept tree with the declaration table in both directions. */
export function findRepairDeclarationViolations(
  sites: readonly RepairSite[],
  declared: readonly DeclaredRepairSite[] = DECLARED_REPAIR_SITES,
  files: readonly RepairScanFile[] = [],
): RepairDeclarationViolation[] {
  const violations: RepairDeclarationViolation[] = [];
  const declaredKeys = new Set(declared.map(repairSiteKey));
  const liveKeys = new Set(sites.map(repairSiteKey));

  for (const site of sites) {
    if (!declaredKeys.has(repairSiteKey(site))) {
      violations.push({ kind: "undeclared", ...site });
    }
  }
  for (const site of declared) {
    if (!liveKeys.has(repairSiteKey(site))) {
      violations.push({ kind: "stale", ...site });
    }
  }
  for (const violation of collectRepairViolations(files)) {
    violations.push({ kind: "invalid-repair", ...violation });
  }
  return violations;
}

function repairSiteKey(site: DeclaredRepairSite): string {
  return `${site.path}\0${site.fn}\0${site.surface}`;
}

/** Name every inventory disagreement so the failing site is immediately actionable. */
export function formatRepairDeclarationFailure(
  violations: readonly RepairDeclarationViolation[],
): string {
  if (violations.length === 0) return "";
  const lines = [
    `structured-repair ratchet (#3261): ${violations.length} disagreement(s) between the castle` +
      " surface and `DECLARED_REPAIR_SITES` in apps/dev/src/core/repair-guard.ts.",
  ];
  for (const violation of violations) {
    if (violation.kind === "undeclared") {
      lines.push(
        `  - UNDECLARED ${violation.path}:${violation.line} in \`${violation.fn}\` ` +
          `(${violation.surface}) — add a composed repair or an argued \`repair: none\`, then declare the site.`,
      );
      continue;
    }
    if (violation.kind === "stale") {
      lines.push(
        `  - STALE ${violation.path} \`${violation.fn}\` (${violation.surface}) — the path is gone; ` +
          "delete the declaration with it.",
      );
      continue;
    }
    lines.push(
      `  - INVALID ${violation.path}:${violation.line} — ${violation.reason}.`,
    );
  }
  return lines.join("\n");
}

/** Preserve the #3260 field-level check inside each explicit refusal object. */
export function collectRepairViolations(
  files: readonly RepairScanFile[],
): RepairViolation[] {
  const violations: RepairViolation[] = [];
  for (const file of files) {
    const structural = blankCommentsAndStrings(file.sourceText);
    for (const match of structural.matchAll(/\brefused\s*:\s*true\b/g)) {
      const index = match.index ?? 0;
      const open = enclosingOpenBrace(structural, index);
      if (open < 0 || isTypeDeclaration(structural, open)) continue;
      const close = matchingCloseBrace(structural, open);
      const object = file.sourceText.slice(open, close + 1);
      const line = file.sourceText.slice(0, index).split("\n").length;
      if (!/\brepair\s*:/.test(object)) {
        violations.push({
          path: file.path,
          line,
          reason: "structured refusal has no repair or argued none",
        });
      } else if (
        /\brepair\s*:\s*["']none["']/.test(object) &&
        !/\brepair_reason\s*:/.test(object)
      ) {
        violations.push({
          path: file.path,
          line,
          reason: "repair none has no repair_reason",
        });
      }
    }
  }
  return violations;
}

interface FunctionFrame {
  readonly fn: string | null;
  readonly resumeHeader: string | null;
  readonly resumeParenDepth: number;
}

/** Find the innermost stable function name at one source offset. */
function enclosingFunctionName(source: string, target: number): string {
  const frames: FunctionFrame[] = [];
  let header = "";
  let parenDepth = 0;
  for (let index = 0; index < target; index += 1) {
    const ch = source[index]!;
    if (ch === "\n") {
      header += " ";
      continue;
    }
    if (ch === "(" || ch === "[") parenDepth += 1;
    else if (ch === ")" || ch === "]") parenDepth = Math.max(0, parenDepth - 1);
    if (ch === "{") {
      frames.push({
        fn: functionNameFromHeader(header),
        resumeHeader: parenDepth > 0 ? header : null,
        resumeParenDepth: parenDepth,
      });
      header = "";
      parenDepth = 0;
      continue;
    }
    if (ch === "}") {
      const closed = frames.pop();
      header = closed?.resumeHeader ?? "";
      parenDepth = closed?.resumeParenDepth ?? 0;
      continue;
    }
    if (ch === ";" && parenDepth === 0) {
      header = "";
      continue;
    }
    header += ch;
  }
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (frames[index]!.fn !== null) return frames[index]!.fn!;
  }
  return "<module>";
}

const FUNCTION_HEADERS: readonly RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function|\()/,
  /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^=]*)?$/,
  /(?<![.\w$])([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/,
];

function functionNameFromHeader(header: string): string | null {
  const collapsed = header.replace(/\s+/g, " ").trim();
  for (const pattern of FUNCTION_HEADERS) {
    const hit = pattern.exec(collapsed);
    if (hit?.[1] !== undefined && !RESERVED.has(hit[1])) return hit[1];
  }
  return null;
}

const RESERVED = new Set(["if", "for", "while", "switch", "catch", "try", "return", "new"]);

function enclosingOpenBrace(source: string, index: number): number {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (source[cursor] === "}") depth += 1;
    if (source[cursor] !== "{") continue;
    if (depth === 0) return cursor;
    depth -= 1;
  }
  return -1;
}

function matchingCloseBrace(source: string, open: number): number {
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}" && --depth === 0) return cursor;
  }
  return source.length - 1;
}

function isTypeDeclaration(source: string, open: number): boolean {
  const prefix = source.slice(Math.max(0, open - 160), open);
  return /\b(?:interface|type)\s+[A-Za-z_$][\w$]*(?:\s*=)?\s*$/.test(prefix);
}

/** Blank comments and literals while preserving byte offsets and braces. */
function blankCommentsAndStrings(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (value) => value.replace(/[^\n]/g, " "),
  );
}
