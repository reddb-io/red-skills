/**
 * Repo-lint: retired execution-unit noun "attempt" must not appear in living source.
 *
 * Exempted by the issue #2430 spec:
 *   - `data-attempt-status` HTML attribute (envelope wire format, intentionally frozen)
 *   - `AttemptStatus` / `CastleAttemptStatus` type names (refer to that attribute)
 *   - `attempt_number` / `attemptNumber` count fields
 *   - `attemptCount` (learning-debt repetition counter)
 *   - Historical `.red/adr/` files
 *   - Plain comments / prose that reference the old term for context
 *
 * When this test fails, either:
 *   (a) a new file was added that still uses the retired noun — rename it, or
 *   (b) the exemption list below needs updating with a newly approved exception.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test, expect } from "vitest";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

// Banned patterns: identifiers and import paths that use the retired noun as
// the execution-unit noun (not as a verb, count, or envelope attribute).
const BANNED: readonly RegExp[] = [
  // Module paths
  /from\s+["'].*attempt-outcome/,
  /from\s+["'].*attempt-reader/,
  /from\s+["'].*post-attempt-format/,
  /from\s+["'].*attempt-writer/,
  // Type and function identifiers
  /\bAttemptOutcome\b(?!Status)/,
  /\brecordReasoningAttempt\b/,
  /\bReasoningAttemptPayload\b/,
  /\bRunAttempt\b|\brunAttempt\b/,
  /\bAttemptLearning\b/,
  /\bRejectedAttemptLearning\b/,
  /\bbuildAttemptLearning/,
  /\bapplyAttemptLearning/,
  /\bwriteAttemptLearning/,
  /\bparseAttemptLearning/,
  // NodeType literal as execution-unit (JSON / TS const)
  /node_type\s*[:=]\s*["']attempt["']/,
  /["']attempt["']\s*as\s+NodeType/,
];

// Extensions of living source files to scan.
const LIVE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Paths that are excluded from the scan (historical or intentionally frozen).
const EXCLUDED_PREFIXES = [
  ".red/adr/",
  "node_modules/",
  "dist/",
  ".git/",
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(REPO_ROOT, abs);
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(abs)));
    } else if (entry.isFile() && LIVE_EXTENSIONS.has(`.${entry.name.split(".").pop()}`)) {
      files.push(abs);
    }
  }
  return files;
}

test("retired execution-unit noun 'attempt' is absent from living TypeScript source", async () => {
  const files = await collectSourceFiles(REPO_ROOT);

  const violations: Array<{ file: string; line: number; text: string; pattern: string }> = [];

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const src = await readFile(file, "utf8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of BANNED) {
        if (pattern.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim(), pattern: String(pattern) });
        }
      }
    }
  }

  if (violations.length > 0) {
    const report = violations
      .map((v) => `${v.file}:${v.line} — ${v.text}\n  matched: ${v.pattern}`)
      .join("\n");
    expect.fail(`${violations.length} violation(s) of retired vocabulary rule:\n\n${report}`);
  }
}, 30_000);
