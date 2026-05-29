import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MEMORY_IGNORE_FILENAME,
  SCOPE_PRESETS,
  countCandidates,
  defaultIgnorePatterns,
  formatScopeReport,
  matchesAnyPattern,
  parseMemoryIgnore,
  planScope,
  readMemoryIgnore,
  renderIgnoreFile,
  resolvePreset,
  writeMemoryIgnore,
} from "../src/scope.js";

// This suite imports ONLY ../src/scope.js — no pipeline, no CLI, no prompt.
// AC5: the ignore-pattern logic is exercised in isolation from the interactive flow.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-scope-"));
  roots.push(dir);
  return dir;
}

const SAMPLE_FILES = [
  "src/app.ts",
  "src/app.test.ts",
  "src/util/format.ts",
  "apps/web/main.ts",
  "libs/core/index.ts",
  "libs/core/index.spec.ts",
  "packages/sdk/client.ts",
  "examples/demo.ts",
  "vendor/jquery.min.js",
  "README.md",
];

describe("glob matching (pure)", () => {
  test("matchesAnyPattern handles globstar directory patterns", () => {
    expect(matchesAnyPattern("src/test/foo.ts", ["**/test/**"])).toBe(true);
    expect(matchesAnyPattern("test/foo.ts", ["**/test/**"])).toBe(true);
    expect(matchesAnyPattern("src/app.ts", ["**/test/**"])).toBe(false);
  });

  test("matchesAnyPattern handles extension and brace patterns", () => {
    expect(matchesAnyPattern("src/foo.test.ts", ["**/*.test.*"])).toBe(true);
    expect(matchesAnyPattern("app.min.js", ["**/*.min.js"])).toBe(true);
    expect(matchesAnyPattern("src/main.ts", ["**/*.{ts,tsx}"])).toBe(true);
    expect(matchesAnyPattern("src/main.py", ["**/*.{ts,tsx}"])).toBe(false);
  });

  test("single star does not cross directory boundaries", () => {
    expect(matchesAnyPattern("a/b.ts", ["*.ts"])).toBe(false);
    expect(matchesAnyPattern("b.ts", ["*.ts"])).toBe(true);
  });
});

describe("countCandidates (pure function over a file list + ignore patterns)", () => {
  test("counts files surviving the ignore patterns", () => {
    expect(countCandidates(SAMPLE_FILES, [])).toBe(SAMPLE_FILES.length);
    expect(countCandidates(SAMPLE_FILES, ["**/*.test.*", "**/*.spec.*"])).toBe(
      SAMPLE_FILES.length - 2,
    );
    expect(countCandidates([], ["**/*"])).toBe(0);
  });
});

describe("scope presets", () => {
  test("the four documented presets exist", () => {
    expect(Object.keys(SCOPE_PRESETS).sort()).toEqual(
      ["core", "generate-ignore", "libs", "proceed"].sort(),
    );
  });

  test("resolvePreset defaults to proceed and rejects unknown names", () => {
    expect(resolvePreset(undefined).name).toBe("proceed");
    expect(resolvePreset("core").name).toBe("core");
    expect(() => resolvePreset("nope")).toThrow(/scope/i);
  });

  test("proceed keeps every candidate", () => {
    const plan = planScope(SAMPLE_FILES, "proceed");
    expect(plan.candidates).toBe(SAMPLE_FILES.length);
    expect(plan.ignored).toBe(0);
  });

  test("core excludes tests, examples, vendored and library trees", () => {
    const plan = planScope(SAMPLE_FILES, "core");
    expect(plan.candidates).toBeLessThan(SAMPLE_FILES.length);
    // core keeps app/src code but drops tests/examples/libs/packages/vendor
    expect(plan.candidates).toBe(
      countCandidates(SAMPLE_FILES, SCOPE_PRESETS.core.ignore),
    );
    expect(matchesAnyPattern("libs/core/index.ts", SCOPE_PRESETS.core.ignore)).toBe(true);
    expect(matchesAnyPattern("src/app.ts", SCOPE_PRESETS.core.ignore)).toBe(false);
  });

  test("libs excludes app trees", () => {
    expect(matchesAnyPattern("apps/web/main.ts", SCOPE_PRESETS.libs.ignore)).toBe(true);
    expect(matchesAnyPattern("libs/core/index.ts", SCOPE_PRESETS.libs.ignore)).toBe(false);
  });
});

describe("planScope + formatScopeReport", () => {
  test("planScope layers extra ignore patterns on top of the preset", () => {
    const plan = planScope(SAMPLE_FILES, "proceed", ["**/*.md"]);
    expect(plan.total).toBe(SAMPLE_FILES.length);
    expect(plan.candidates).toBe(SAMPLE_FILES.length - 1); // README.md dropped
    expect(plan.ignore).toContain("**/*.md");
  });

  test("formatScopeReport states the count before processing", () => {
    const report = formatScopeReport(planScope(SAMPLE_FILES, "core"));
    expect(report).toMatch(/candidate/i);
    expect(report).toContain(String(SAMPLE_FILES.length));
    expect(report).toMatch(/core/);
  });
});

describe("ignore-file rendering and parsing (pure)", () => {
  test("defaultIgnorePatterns are non-empty globs", () => {
    const patterns = defaultIgnorePatterns();
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns).toContain("**/node_modules/**");
  });

  test("renderIgnoreFile is human-editable: header comments + one pattern per line", () => {
    const text = renderIgnoreFile(["**/node_modules/**", "**/dist/**"]);
    expect(text).toMatch(/^#/m);
    expect(text).toContain("**/node_modules/**");
    expect(text).toContain("**/dist/**");
  });

  test("parseMemoryIgnore drops comments and blank lines, round-trips render", () => {
    const text = renderIgnoreFile(["**/node_modules/**", "**/dist/**"]);
    expect(parseMemoryIgnore(text)).toEqual(["**/node_modules/**", "**/dist/**"]);
    expect(parseMemoryIgnore("# only a comment\n\n   \n")).toEqual([]);
  });
});

describe("readMemoryIgnore / writeMemoryIgnore (fs shell)", () => {
  test("write then read round-trips the patterns", async () => {
    const root = await tempRoot();
    const path = await writeMemoryIgnore(root, ["**/dist/**", "**/secret/**"]);
    expect(path).toBe(join(root, MEMORY_IGNORE_FILENAME));
    const written = await readFile(path, "utf8");
    expect(written).toMatch(/^#/m); // header preserved for human editing
    expect(await readMemoryIgnore(root)).toEqual(["**/dist/**", "**/secret/**"]);
  });

  test("readMemoryIgnore returns [] when no file exists", async () => {
    const root = await tempRoot();
    expect(await readMemoryIgnore(root)).toEqual([]);
  });

  test("readMemoryIgnore honours hand-edited patterns (human-editable)", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, MEMORY_IGNORE_FILENAME),
      "# edited by a human\n**/generated/**\n\n**/*.snap\n",
      "utf8",
    );
    expect(await readMemoryIgnore(root)).toEqual(["**/generated/**", "**/*.snap"]);
  });
});
