// src-test-file-guard — a test file this package never runs is not coverage.
//
// `vitest.config.ts` includes `tests/**/*.test.ts` and the shared-layer suite,
// and nothing else. A `*.test.ts` written under `src/` therefore matches no glob
// in any vitest config in the repo: it is never collected, never executed, and
// never fails. Issue #3021 found three of them here — 385 LOC that had asserted
// nothing since the day they landed, while reading in review exactly like the
// coverage their subjects did have.
//
// This is a PACKAGE-LOCAL layout rule, not a repo-wide invariant, which is why
// it lives in the ordinary suite rather than in `REPO_INVARIANT_SUITES`: the
// same `src/**/*.test.ts` layout is CORRECT in `packages/worker`, whose
// config includes it (`packages/worker/vitest.config.ts:5`). What is wrong
// is a colocated test in a package whose config only collects `tests/`.

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = join(PACKAGE_ROOT, "src");

/** Every `*.test.ts` under `dir`, repo-relative to the package root. */
function collectTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...collectTestFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(relative(PACKAGE_ROOT, full));
  }
  return found;
}

describe("no test file hides under apps/dev/src", () => {
  it("finds no *.test.ts that vitest never collects", () => {
    const stranded = collectTestFiles(SRC_ROOT).sort();
    expect(
      stranded,
      stranded.length === 0
        ? ""
        : `these test files live under apps/dev/src/ and match no include glob in ` +
          `apps/dev/vitest.config.ts, so vitest never runs them:\n` +
          stranded.map((file) => `  - ${file}`).join("\n") +
          `\nMove each into apps/dev/tests/ (repointing its relative imports) or ` +
          `delete it — leaving it here is worse than both, because it reads as ` +
          `coverage that does not exist.`,
    ).toEqual([]);
  });

  it("names the stranded files when there are any", () => {
    // The guard is only useful if its failure is actionable, so prove the
    // collector actually reports a path rather than a bare count.
    const collected = collectTestFiles(join(PACKAGE_ROOT, "tests"));
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.every((file) => file.startsWith(`tests${sep}`))).toBe(true);
  });
});
