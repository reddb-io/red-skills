// shipped-primitive-guard — the ratchet that keeps a safety primitive REACHABLE
// in the shipped binary, not merely implemented (issue #2800).
//
// The gh quota backoff was written correctly, tested thoroughly, and never ran.
// Both call boundaries took a bypass branch unless a `quotaBackoff` option was
// present, and the only file in the whole tree that populated one was a test.
// The suite injected the option, exercised the retry, and passed — so a green
// gate reported that quota handling worked while a live drain hit `0/5000` and
// died with no wait, no retry, and no `quota-wait` activity.
//
// **AN OPT-IN SAFETY PRIMITIVE WITH NO NON-TEST ENABLER IS DEAD CODE WITH A
// PASSING TEST.** That is the "fix guards only one path" class of the #567
// super-audit, aggravated: the test does not merely miss the defect, it supplies
// positive evidence against it.
//
// The invariant is therefore about the ENABLER, not the definition. A reference
// to `withGhQuotaBackoff` from a bypass branch proves nothing — the branch is
// what was never taken. Each entry names the symbol whose non-test caller proves
// the primitive is live for the shipped binary, so wiring it back to opt-in
// fails here rather than during the next quota window.
//
// Two failure shapes, both violations:
//
//  1. TEST-ONLY. The enabler is referenced, but every referencing file is a test.
//     This is the #2800 shape exactly.
//  2. UNREFERENCED. Nothing outside the defining module names the enabler at all,
//     so the primitive is unreachable from anywhere.
//
// Prose is not an enabler: comments are stripped before matching, so a header
// explaining the wiring never stands in for the wiring.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stripComments } from "./extinct-source-guard.js";

/** A safety primitive that must be reachable in the shipped binary. */
export interface ShippedPrimitive {
  /** Stable slug — the name the failure carries. */
  id: string;
  /** What the primitive protects against, in one noun phrase. */
  what: string;
  /** Repo-relative module that DEFINES it. Its own text never counts as a caller. */
  definedIn: string;
  /**
   * The ENABLER reference: a non-test file matching this proves the primitive
   * runs for real. Never point this at the primitive's own entry point when a
   * bypass branch can reference it without taking it — name the symbol that
   * makes the protection unconditional.
   */
  enabler: RegExp;
  /** What breaks in production while nothing enables it — read by a triaging human. */
  consequence: string;
}

/**
 * The declared primitives. Keep this list SHORT: an entry belongs here when the
 * primitive is a SAFETY behavior (a retry, a bound, a refusal) whose absence is
 * silent — the class where a passing test is actively misleading.
 */
export const SHIPPED_PRIMITIVES: readonly ShippedPrimitive[] = [
  {
    id: "gh-quota-backoff",
    what: "the bounded wait-and-retry for GitHub primary/secondary rate limits",
    definedIn: "apps/plugin-dev/src/runtime/gh/quota.ts",
    enabler: /\b(?:resolveGhQuotaBackoff|defaultGhQuotaBackoff)\b/,
    consequence:
      "a worker that hits a GitHub rate limit fails immediately instead of waiting for the reset, and the failure reads as a merge/label error rather than as quota",
  },
  {
    id: "redskilled-worker-log-line",
    what: "the Worker's publication of its last log line to the host daemon, on the beat it already keeps",
    definedIn: "apps/redskilled/src/client.ts",
    // Call-shaped, and deliberately: this publisher shipped exported, documented
    // in HOST-NOTES.md as a working feature, and referenced by nothing but its own
    // definition (#3079). A reference is not a call — a default value handed to an
    // option is exactly the shape that reads as wiring and supplies nothing.
    enabler: /\bpublishRedskilledWorkerLogLine\s*\(/,
    consequence:
      "no daemon-side surface can show what an AFK Worker is logging: the herdr plugin and the VS Code extension report a Worker that declared no log path, and `redskilled statusline --verbose` has no second line to print",
  },
  {
    id: "github-spend-report",
    what: "the durable report naming which operation and Worker spent each GitHub budget pool",
    definedIn: "packages/github/attribution.ts",
    // The awaited dispatch is the shipped surface, not merely a constructed
    // ledger. The first implementation created and exported the ledger while no
    // production caller read it, leaving the incident question unanswered.
    enabler: /\bawait runGithubSpend\s*\(/,
    consequence:
      "the host can append GitHub spend observations but no operator surface can answer what spent the GraphQL budget in a window, so attribution survives only as unread local bytes",
  },
];

/** One file that references a primitive's enabler, and whether it is a test. */
export interface ShippedPrimitiveCaller {
  primitiveId: string;
  relativePath: string;
  line: number;
  isTest: boolean;
}

/** A primitive that no shipped code enables, and which shape of gap it is. */
export interface ShippedPrimitiveViolation {
  primitiveId: string;
  kind: "test-only" | "unreferenced";
  /** Test files that reference the enabler — the false confidence, when any. */
  testCallers: readonly string[];
}

/** Where a human edits the inventory, named in the failure message. */
export const SHIPPED_PRIMITIVE_DECLARATION =
  "apps/plugin-dev/src/core/shipped-primitive-guard.ts (SHIPPED_PRIMITIVES)";

export interface ShippedPrimitiveFile {
  relativePath: string;
  sourceText: string;
  isTest: boolean;
}

const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx"]);
const SKIP_DIRS = new Set([".git", ".red", ".turbo", "coverage", "dist", "generated", "node_modules"]);

/**
 * Every caller of every primitive's enabler, excluding each primitive's own
 * defining module. Sorted so a failure names the same file first on every run.
 * PURE.
 */
export function collectShippedPrimitiveCallers(
  files: readonly ShippedPrimitiveFile[],
  primitives: readonly ShippedPrimitive[] = SHIPPED_PRIMITIVES,
): ShippedPrimitiveCaller[] {
  const callers: ShippedPrimitiveCaller[] = [];
  for (const file of files) {
    const lines = stripComments(file.sourceText).split("\n");
    for (const primitive of primitives) {
      if (file.relativePath === primitive.definedIn) continue;
      for (let index = 0; index < lines.length; index += 1) {
        if (!primitive.enabler.test(lines[index]!)) continue;
        callers.push({
          primitiveId: primitive.id,
          relativePath: file.relativePath,
          line: index + 1,
          isTest: file.isTest,
        });
      }
    }
  }
  return callers.sort(
    (a, b) =>
      a.primitiveId.localeCompare(b.primitiveId) ||
      a.relativePath.localeCompare(b.relativePath) ||
      a.line - b.line,
  );
}

/**
 * Every primitive with no non-test enabler, tagged with which gap it is. An
 * empty array is the healthy state. PURE.
 */
export function findShippedPrimitiveViolations(
  callers: readonly ShippedPrimitiveCaller[],
  primitives: readonly ShippedPrimitive[] = SHIPPED_PRIMITIVES,
): ShippedPrimitiveViolation[] {
  const violations: ShippedPrimitiveViolation[] = [];
  for (const primitive of primitives) {
    const own = callers.filter((caller) => caller.primitiveId === primitive.id);
    if (own.some((caller) => !caller.isTest)) continue;
    const testCallers = [...new Set(own.map((caller) => caller.relativePath))];
    violations.push({
      primitiveId: primitive.id,
      kind: testCallers.length > 0 ? "test-only" : "unreferenced",
      testCallers,
    });
  }
  return violations;
}

/**
 * The failure message the invariant assertion carries. A bare array diff names
 * neither the primitive nor what production loses, so a worker reading its own
 * gate output would learn only that something broke. PURE.
 */
export function formatShippedPrimitiveFailureMessage(
  violations: readonly ShippedPrimitiveViolation[],
  primitives: readonly ShippedPrimitive[] = SHIPPED_PRIMITIVES,
): string {
  if (violations.length === 0) return "";
  const byId = new Map(primitives.map((primitive) => [primitive.id, primitive]));
  const lines = violations.map((violation) => {
    const primitive = byId.get(violation.primitiveId);
    const where =
      violation.kind === "test-only"
        ? `enabled ONLY from tests (${violation.testCallers.join(", ")})`
        : "enabled from nowhere";
    return (
      `  - ${violation.primitiveId} — ${primitive?.what ?? "declared primitive"} is ${where}.` +
      `\n      In production: ${primitive?.consequence ?? "the protection does not run"}.` +
      `\n      Enable it from the shipped path (${primitive?.definedIn ?? "its module"} declares the enabler).`
    );
  });
  const plural = violations.length === 1 ? "primitive" : "primitives";
  return [
    `shipped-primitive invariant (#2800): ${violations.length} safety ${plural} with no non-test enabler.`,
    ...lines,
    `An opt-in safety primitive with no shipped caller is dead code with a passing test.` +
      ` Wire it, or drop the entry from ${SHIPPED_PRIMITIVE_DECLARATION} if the primitive is gone.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

/**
 * Every `apps/` and `packages/` source file, tests INCLUDED and flagged. The
 * whole point is to tell a test caller from a shipped one, so a walker that
 * skipped tests could not see the #2800 shape at all.
 */
export function readShippedPrimitiveFiles(root: string): ShippedPrimitiveFile[] {
  const files: ShippedPrimitiveFile[] = [];
  for (const sourceRoot of ["apps", "packages"]) {
    const absoluteRoot = join(root, sourceRoot);
    if (existsSync(absoluteRoot)) collectFiles(root, absoluteRoot, files);
  }
  return files;
}

function collectFiles(root: string, dir: string, out: ShippedPrimitiveFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(root, join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = normalizePath(relative(root, join(dir, entry.name)));
    if (!isScannedSourceFile(relativePath)) continue;
    out.push({
      relativePath,
      sourceText: readFileSync(join(dir, entry.name), "utf8"),
      isTest: isTestPath(relativePath),
    });
  }
}

function isScannedSourceFile(relativePath: string): boolean {
  const base = relativePath.split("/").at(-1) ?? "";
  if (base.endsWith(".d.ts")) return false;
  const dot = base.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(base.slice(dot));
}

/** True for anything a test runner owns — a suite file or a file under a test dir. */
export function isTestPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const base = segments.at(-1) ?? "";
  if (base.includes(".test.") || base.includes(".spec.")) return true;
  return segments.some((segment) => segment === "tests" || segment === "test" || segment === "__tests__");
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
