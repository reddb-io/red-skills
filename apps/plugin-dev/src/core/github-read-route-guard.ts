// github-read-route-guard — absolute prohibition on raw `gh` I/O.
//
// The destination is cardinal: every GitHub read crosses @reddb-io/github. The
// Every call site must cross one of the shared package's routed doors.

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

export interface GithubReadRouteExemption {
  readonly id: "authentication-bootstrap" | "viewer-identity" | "unsupported-mutation" | "shared-client";
  readonly reason: string;
}

/** Legitimate boundaries are stated here rather than hidden in scanner code. */
export const GITHUB_READ_EXEMPTIONS: readonly GithubReadRouteExemption[] = [
  {
    id: "authentication-bootstrap",
    reason: "gh auth resolves the credential that @reddb-io/github needs, so authentication cannot route through that client itself",
  },
  {
    id: "viewer-identity",
    reason: "viewer identity selects the credential/actor before a routed client exists and therefore remains a tracker bootstrap read",
  },
  {
    id: "unsupported-mutation",
    reason: "writes are excluded from the read inventory and constrained independently by the write ratchet",
  },
  {
    id: "shared-client",
    reason: "calls already issued by createGithubClient are the required route and are not shell-outs for this inventory",
  },
];

export interface GithubReadShelloutBaselineEntry {
  readonly path: string;
  readonly count: number;
  readonly reason: string;
}

/** No grandfathered GitHub reads exist or may be added. */
export const GITHUB_READ_SHELLOUT_BASELINE: readonly GithubReadShelloutBaselineEntry[] = [];

/** Raw mutation inventory. SHRINK ONLY: writes share the routed-client destination. */
export const GITHUB_WRITE_SHELLOUT_BASELINE: readonly GithubReadShelloutBaselineEntry[] = [
];

export interface GithubReadSourceFile {
  readonly relativePath: string;
  readonly sourceText: string;
}

export interface GithubReadShelloutFinding {
  readonly path: string;
  readonly line: number;
  readonly command: string;
  readonly route: string;
  readonly snippet: string;
}

export interface GithubReadRouteReport {
  readonly findings: readonly GithubReadShelloutFinding[];
  readonly baseline: readonly GithubReadShelloutBaselineEntry[];
  readonly exemptions: readonly GithubReadRouteExemption[];
}

const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx"]);
export const GITHUB_ROUTE_SCAN_ROOTS = ["apps", "packages"] as const;
const SKIP_DIRS = new Set(["dist", "generated", "node_modules", "test", "tests", "__tests__", "fixtures"]);
const GUARD_PATH = "apps/plugin-dev/src/core/github-read-route-guard.ts";

const WRITE_COMMANDS = new Set([
  "issue create", "issue edit", "issue close", "issue reopen", "issue comment", "issue develop",
  "pr create", "pr comment", "pr merge", "pr close", "pr edit", "pr ready", "pr update-branch",
  "label create", "release create", "release delete", "run cancel", "run rerun",
]);

function calleeName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

function literal(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function arrayWords(array: ts.ArrayLiteralExpression): string[] {
  return array.elements.map((element) => {
    if (ts.isSpreadElement(element)) return "<dynamic>";
    const value = literal(element as ts.Expression);
    return value ?? "<dynamic>";
  });
}

function shellWords(value: string): string[] {
  return value.trim().split(/\s+/).map((word) => word.replace(/^["']|["'],?$/g, "")).filter(Boolean);
}

function candidateWords(call: ts.CallExpression): string[] | null {
  const name = calleeName(call.expression);
  // An argv handed to the client's write planner IS the required route: the
  // canonical spelling exists so @reddb-io/github decides the rail (#3663).
  if (name === "planGithubWrite") return null;
  const arrays = call.arguments.filter(ts.isArrayLiteralExpression);
  for (const array of arrays) {
    const words = arrayWords(array);
    if (words[0] === "gh") return words.slice(1);
    if (["runGh", "gh", "githubCli"].includes(name) && words.length > 0) return words;
  }
  const first = call.arguments[0] && literal(call.arguments[0]);
  if (first === "gh" && arrays[0]) return arrayWords(arrays[0]);
  if (first?.trim().startsWith("gh ")) return shellWords(first).slice(1);
  return null;
}

function commandPath(words: readonly string[]): string[] {
  const path: string[] = [];
  let index = 0;
  while (index < words.length && words[index]!.startsWith("-")) {
    index += words[index] === "-R" || words[index] === "--repo" || words[index] === "--hostname" ? 2 : 1;
  }
  while (index < words.length && path.length < 2) {
    const word = words[index++]!;
    if (!word.startsWith("-")) path.push(word);
  }
  return path;
}

function apiMutation(words: readonly string[]): boolean {
  const methodAt = words.findIndex((word) => word === "-X" || word === "--method");
  if (methodAt < 0) return false;
  const method = (words[methodAt + 1] ?? "").toUpperCase();
  return method !== "" && method !== "GET" && method !== "HEAD";
}

function exempt(words: readonly string[], path: readonly string[]): boolean {
  const key = path.join(" ");
  if (path[0] === "auth") return true;
  if (key === "api user" || words.some((word) => /\bviewer\b/i.test(word))) return true;
  if (WRITE_COMMANDS.has(key)) return true;
  return path[0] === "api" && apiMutation(words);
}

function writeCommand(words: readonly string[], path: readonly string[]): boolean {
  return WRITE_COMMANDS.has(path.join(" ")) || (path[0] === "api" && apiMutation(words));
}

function replacement(path: readonly string[]): string {
  const key = path.join(" ") || "GitHub read";
  if (["issue view", "pr view", "repo view", "run view", "release view"].includes(key)) {
    return "createGithubClient(...).singleObject(...) through rest-plan + conditional-client";
  }
  return "createGithubClient(...).conditionalRest / singleObject through @reddb-io/github";
}

function collectFile(file: GithubReadSourceFile, kind: "read" | "write"): GithubReadShelloutFinding[] {
  if (file.relativePath === GUARD_PATH) return [];
  const source = ts.createSourceFile(file.relativePath, file.sourceText, ts.ScriptTarget.Latest, true);
  const findings: GithubReadShelloutFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const words = candidateWords(node);
      if (words) {
        const path = commandPath(words);
        const isWrite = writeCommand(words, path);
        const selected = kind === "write" ? isWrite : !isWrite && !exempt(words, path);
        if (path.length > 0 && selected) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          findings.push({
            path: file.relativePath,
            line,
            command: path.join(" "),
            route: kind === "write"
              ? "createGithubClient(...).mutation through @reddb-io/github"
              : replacement(path),
            snippet: node.getText(source).replace(/\s+/g, " ").slice(0, 180),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function collectGithubReadShelloutsFromFiles(
  files: readonly GithubReadSourceFile[],
): GithubReadShelloutFinding[] {
  return files.flatMap((file) => collectFile(file, "read")).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export function collectGithubWriteShelloutsFromFiles(
  files: readonly GithubReadSourceFile[],
): GithubReadShelloutFinding[] {
  return files.flatMap((file) => collectFile(file, "write")).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function readTree(root: string): GithubReadSourceFile[] {
  const files: GithubReadSourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name.includes(".test.") || !SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
      const path = join(directory, entry.name);
      files.push({ relativePath: relative(root, path).replaceAll("\\", "/"), sourceText: readFileSync(path, "utf8") });
    }
  };
  for (const scanRoot of GITHUB_ROUTE_SCAN_ROOTS) walk(join(root, scanRoot));
  return files;
}

export function collectGithubReadRouteReport(root: string): GithubReadRouteReport {
  return {
    findings: collectGithubReadShelloutsFromFiles(readTree(root)),
    baseline: GITHUB_READ_SHELLOUT_BASELINE,
    exemptions: GITHUB_READ_EXEMPTIONS,
  };
}

export function collectGithubWriteRouteReport(root: string): GithubReadRouteReport {
  return {
    findings: collectGithubWriteShelloutsFromFiles(readTree(root)),
    baseline: GITHUB_WRITE_SHELLOUT_BASELINE,
    exemptions: GITHUB_READ_EXEMPTIONS,
  };
}

export function githubReadRouteViolations(report: GithubReadRouteReport): string[] {
  const violations: string[] = [];
  const remaining = new Map<string, number>();
  for (const entry of report.baseline) {
    if (!Number.isInteger(entry.count) || entry.count < 1) violations.push(`baseline ${entry.path} needs a positive count`);
    if (!entry.reason.trim()) violations.push(`baseline ${entry.path} needs a reason`);
    if (remaining.has(entry.path)) violations.push(`duplicate baseline path ${entry.path}`);
    remaining.set(entry.path, Math.max(0, entry.count));
  }
  for (const finding of report.findings) {
    const count = remaining.get(finding.path) ?? 0;
    if (count > 0) remaining.set(finding.path, count - 1);
    else violations.push(`${finding.path}:${finding.line} — ${finding.command} → ${finding.route}`);
  }
  return violations;
}

export const githubWriteRouteViolations = githubReadRouteViolations;

const ROUTING_DOORS =
  "Use createGithubClient, planGithubRestRead, or planGithubWrite from @reddb-io/github.";

export function formatGithubReadRouteFailure(
  report: GithubReadRouteReport,
  violations: readonly string[],
): string {
  if (violations.length === 0) return "";
  return [
    `github-read-routing guard: ${report.findings.length} raw GitHub read shell-out(s) found.`,
    ROUTING_DOORS,
    ...violations.map((violation) => `  - ${violation}`),
  ].join("\n");
}

export function formatGithubWriteRouteFailure(
  report: GithubReadRouteReport,
  violations: readonly string[],
): string {
  if (violations.length === 0) return "";
  return [
    `github-write-routing guard: ${report.findings.length} raw GitHub write shell-out(s) found.`,
    ROUTING_DOORS,
    ...violations.map((violation) => `  - ${violation}`),
  ].join("\n");
}
