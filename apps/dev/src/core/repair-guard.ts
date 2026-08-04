// repair-guard — every structured castle refusal carries a callable repair or
// an argued none (ADR 0134 decision 5, issue #3260).

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface RepairScanFile {
  readonly path: string;
  readonly sourceText: string;
}

export interface RepairViolation {
  readonly path: string;
  readonly line: number;
  readonly reason:
    | "structured refusal has no repair or argued none"
    | "repair none has no repair_reason";
}

export const REPAIR_SCAN_ROOTS = [
  "packages/red-castle/src/mcp",
  "apps/dev/src/mcp-adapter.ts",
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
