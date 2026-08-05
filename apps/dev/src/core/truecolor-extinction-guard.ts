// truecolor-extinction-guard — ADR 0137's deletion ratchet.
//
// Painted applications may consume ANSI paint derived by @reddb-io/brand-tokens,
// but they may not carry a literal truecolor escape of their own. Keeping the
// scanner independent from the painters makes a hotfix in any one surface fail
// the repo-wide gate that can still remove it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** Source trees that can paint the dev statusline, VS Code dashboard, or herdr panes. */
export const PAINTED_SURFACE_SOURCE_ROOTS = [
  "apps/dev/src",
  "apps/vscode-extension-red-skills/src",
  "apps/herdr-plugin-red-skills/src",
] as const;

/** Exact modules allowed to derive ANSI truecolor sequences from published tokens. */
export const BRAND_TOKEN_DERIVATION_MODULES = [
  "packages/brand-tokens/index.ts",
  "packages/brand-tokens/index.mjs",
] as const;

const DERIVATION_MODULES = new Set<string>(BRAND_TOKEN_DERIVATION_MODULES);
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

// Assemble the forbidden SGR fragment so this guard's own source does not carry
// the literal it rejects while scanning apps/dev/src.
const TRUECOLOR_ESCAPE = new RegExp(`(?:${38}|${48});${2}`, "g");

export interface PaintedSurfaceSourceFile {
  readonly relativePath: string;
  readonly sourceText: string;
}

export interface TruecolorExtinctionFinding {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly layer: "foreground" | "background";
  readonly excerpt: string;
}

function repoPath(path: string): string {
  return path.split(sep).join("/");
}

function readSourceTree(
  repoRoot: string,
  directory: string,
  files: PaintedSurfaceSourceFile[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      readSourceTree(repoRoot, absolutePath, files);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    files.push({
      relativePath: repoPath(relative(repoRoot, absolutePath)),
      sourceText: readFileSync(absolutePath, "utf8"),
    });
  }
}

/** Read every source file belonging to one of ADR 0137's painted applications. */
export function readPaintedSurfaceSourceFiles(repoRoot: string): PaintedSurfaceSourceFile[] {
  const files: PaintedSurfaceSourceFile[] = [];
  for (const sourceRoot of PAINTED_SURFACE_SOURCE_ROOTS) {
    const absoluteRoot = join(repoRoot, sourceRoot);
    if (existsSync(absoluteRoot)) readSourceTree(repoRoot, absoluteRoot, files);
  }
  return files;
}

function locationAt(sourceText: string, index: number): {
  line: number;
  column: number;
  excerpt: string;
} {
  const before = sourceText.slice(0, index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = sourceText.indexOf("\n", index);
  return {
    line,
    column: index - lineStart + 1,
    excerpt: sourceText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
  };
}

/** Find literal truecolor SGR fragments, exempting only the exact derivation modules. */
export function collectTruecolorExtinctionFindingsFromFiles(
  files: readonly PaintedSurfaceSourceFile[],
): TruecolorExtinctionFinding[] {
  const findings: TruecolorExtinctionFinding[] = [];
  for (const file of files) {
    const relativePath = repoPath(file.relativePath);
    if (DERIVATION_MODULES.has(relativePath)) continue;

    for (const match of file.sourceText.matchAll(TRUECOLOR_ESCAPE)) {
      const index = match.index;
      const location = locationAt(file.sourceText, index);
      findings.push({
        relativePath,
        ...location,
        layer: match[0].startsWith("38") ? "foreground" : "background",
      });
    }
  }
  return findings;
}

/** Sweep the live painted-surface source trees. */
export function collectTruecolorExtinctionFindings(
  repoRoot: string,
): TruecolorExtinctionFinding[] {
  return collectTruecolorExtinctionFindingsFromFiles(readPaintedSurfaceSourceFiles(repoRoot));
}

/** Actionable repo-invariant failure text: every offence carries its source location. */
export function formatTruecolorExtinctionFailure(
  findings: readonly TruecolorExtinctionFinding[],
): string {
  if (findings.length === 0) return "";
  return [
    "ADR 0137 forbids literal ANSI truecolor escapes on painted surfaces:",
    ...findings.map(
      (finding) =>
        `- ${finding.relativePath}:${finding.line}:${finding.column} (${finding.layer}) ${finding.excerpt}`,
    ),
    "Derive paint through @reddb-io/brand-tokens; only its exact derivation modules may construct truecolor sequences.",
  ].join("\n");
}
