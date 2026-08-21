import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditComplexityCoverage,
  collectReferencedNames,
  COMPLEXITY_COVERAGE_BASELINE,
  COMPLEXITY_FLOOR,
  CRAP_CEILING,
  crapScore,
  isCovered,
  measureFunctions,
  type MeasuredFunction,
} from "../src/core/complexity-coverage-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = ["apps", "packages"];
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-bundle",
  "generated",
  // Fixtures describe the rule; they are not the tree it judges.
  "fixtures",
]);
const FIXTURES = join(import.meta.dirname, "fixtures", "complexity-coverage");

/** Every TypeScript file under apps/ and packages/, repo-relative, sorted. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Dot-directories are never shipped package source: `.turbo` is build
        // cache, and the worker package's vendored agent-workflow scripts sit
        // behind one. Judging them would put a demolished module's name in the
        // baseline of a live ratchet.
        if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      files.push(relative(ROOT, path).split(sep).join("/"));
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(ROOT, root));
  return files.sort();
}

/**
 * True for a file that is TEST code: it supplies the coverage signal rather than
 * being judged by it. A helper under `tests/` is test code even when its name
 * says nothing — a test that reaches a function through its own helper still
 * names it.
 */
function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.split("/").includes("tests");
}

/** The package a repo-relative path belongs to — `apps/x` or `packages/x`. */
function packageOf(path: string): string | undefined {
  const parts = path.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
}

interface Tree {
  readonly measured: MeasuredFunction[];
  readonly referencedByPackage: Map<string, Set<string>>;
}

/** Measure the live tree once: every source function, and every name its package's tests say. */
function measureTree(): Tree {
  const measured: MeasuredFunction[] = [];
  const referencedByPackage = new Map<string, Set<string>>();
  for (const path of sourceFiles()) {
    const text = readFileSync(join(ROOT, path), "utf8");
    const owner = packageOf(path);
    if (isTestFile(path)) {
      if (!owner) continue;
      const names = referencedByPackage.get(owner) ?? new Set<string>();
      for (const name of collectReferencedNames(text)) names.add(name);
      referencedByPackage.set(owner, names);
      continue;
    }
    measured.push(...measureFunctions(text, path));
  }
  return { measured, referencedByPackage };
}

/** The fixture pair: a branchy exported function, and the test that names it. */
function fixtureFunctions(): MeasuredFunction[] {
  const path = "apps/plugin-dev/tests/fixtures/complexity-coverage/dispatch-router.ts";
  return measureFunctions(readFileSync(join(FIXTURES, "dispatch-router.ts.txt"), "utf8"), path);
}

function fixtureTestNames(): Set<string> {
  return collectReferencedNames(
    readFileSync(join(FIXTURES, "dispatch-router.test.ts.txt"), "utf8"),
  );
}

const NO_REFERENCES = new Map<string, ReadonlySet<string>>();

describe("complexity×coverage ratchet — a green suite is not evidence the hard code ran", () => {
  it("holds the live tree to the CRAP ceiling and the shrink-only baseline", () => {
    const { measured, referencedByPackage } = measureTree();
    const findings = auditComplexityCoverage(measured, referencedByPackage, packageOf);
    const rendered = findings.map((f) => `  - ${f.reason}`).join("\n");
    expect(
      findings,
      findings.length === 0
        ? ""
        : `complexity×coverage ratchet: ${findings.length} finding(s).\n${rendered}\n` +
          `Baseline: apps/plugin-dev/src/core/complexity-coverage-guard.ts ` +
          `(COMPLEXITY_COVERAGE_BASELINE); shrink only.`,
    ).toEqual([]);
  });

  it("REFUSES the committed fixture's cyclomatic-heavy uncovered function, naming it and its score", () => {
    const measured = fixtureFunctions();
    const heavy = measured.find((fn) => fn.name === "routeDispatch");
    expect(heavy?.complexity, "the fixture must stay branchy enough to bite").toBeGreaterThan(20);

    const findings = auditComplexityCoverage(measured, NO_REFERENCES, packageOf);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("over-ceiling");
    expect(findings[0]?.name).toBe("routeDispatch");
    expect(findings[0]?.crap).toBe(crapScore(heavy?.complexity ?? 0, false));
    // The finding must NAME the function and its score — a ratchet that only
    // says "somewhere under apps/" sends the next reader hunting.
    expect(findings[0]?.reason).toContain("routeDispatch");
    expect(findings[0]?.reason).toContain(`CRAP ${findings[0]?.crap}`);
    expect(findings[0]?.reason).toContain(`complexity ${heavy?.complexity}`);
    expect(findings[0]?.reason).toContain("no test in its package names it");
  });

  it("ACCEPTS the covered variant of the same fixture", () => {
    const measured = fixtureFunctions();
    const referenced = new Map([["apps/plugin-dev", fixtureTestNames()]]);
    expect(auditComplexityCoverage(measured, referenced, packageOf)).toEqual([]);
  });

  it("scores CRAP by Alberg's formula, with binary coverage", () => {
    expect(crapScore(12, false)).toBe(12 + 144);
    expect(crapScore(12, true)).toBe(12);
  });

  it("counts every branch point and no ordinary statement", () => {
    const [simple] = measureFunctions("export function f(a: number) { return a; }", "a.ts");
    expect(simple?.complexity).toBe(1);
    const [branchy] = measureFunctions(
      "export function f(a: number, b: number) {" +
        " if (a) { } else if (b) { }" +
        " for (const x of []) { while (x) { } }" +
        " try { } catch { }" +
        " const c = a ? b : (a && b) || (a ?? b);" +
        " switch (a) { case 1: return b; default: break; }" +
        " return c; }",
      "a.ts",
    );
    // 1 + if + else-if + for-of + while + catch + ternary + && + || + ?? + case
    expect(branchy?.complexity).toBe(11);
  });

  it("rolls an inner closure's branches UP into the exported function that holds them", () => {
    const [outer] = measureFunctions(
      "export function f(xs: number[]) { return xs.map((x) => (x ? 1 : 2)).filter((x) => x && x); }",
      "a.ts",
    );
    expect(outer?.complexity).toBe(3);
  });

  it("sees a re-exported function as exported, and a private one as not", () => {
    const measured = measureFunctions(
      "function shared() {} function hidden() {} export { shared };",
      "a.ts",
    );
    expect(measured.find((fn) => fn.name === "shared")?.exported).toBe(true);
    expect(measured.find((fn) => fn.name === "hidden")?.exported).toBe(false);
  });

  it("names a class member by its class, and inherits the class's reach", () => {
    const measured = measureFunctions("export class Engine { drain() {} }", "a.ts");
    expect(measured[0]?.name).toBe("Engine.drain");
    expect(measured[0]?.exported).toBe(true);
    expect(isCovered(measured[0] as MeasuredFunction, new Set(["Engine"]))).toBe(true);
    expect(isCovered(measured[0] as MeasuredFunction, new Set(["drain"]))).toBe(true);
    expect(isCovered(measured[0] as MeasuredFunction, new Set(["other"]))).toBe(false);
  });

  it("judges nothing a module does not export", () => {
    const hidden: MeasuredFunction = {
      path: "apps/x/src/a.ts",
      name: "hidden",
      line: 1,
      complexity: 40,
      exported: false,
    };
    expect(auditComplexityCoverage([hidden], NO_REFERENCES, packageOf)).toEqual([]);
  });

  it("judges nothing under the complexity floor, however untested", () => {
    const small: MeasuredFunction = {
      path: "apps/x/src/a.ts",
      name: "small",
      line: 1,
      complexity: COMPLEXITY_FLOOR - 1,
      exported: true,
    };
    expect(auditComplexityCoverage([small], NO_REFERENCES, packageOf)).toEqual([]);
  });

  it("refuses a baselined function that GREW, naming both scores", () => {
    const fn: MeasuredFunction = {
      path: "apps/x/src/a.ts",
      name: "grown",
      line: 9,
      complexity: 30,
      exported: true,
    };
    const findings = auditComplexityCoverage([fn], NO_REFERENCES, packageOf, [
      { path: "apps/x/src/a.ts", name: "grown", crap: 500 },
    ]);
    expect(findings[0]?.kind).toBe("over-baseline");
    expect(findings[0]?.reason).toContain("grew from CRAP 500 to 930");
  });

  it("accepts a baselined function that shrank but is still over the ceiling", () => {
    const fn: MeasuredFunction = {
      path: "apps/x/src/a.ts",
      name: "shrinking",
      line: 9,
      complexity: 20,
      exported: true,
    };
    expect(
      auditComplexityCoverage([fn], NO_REFERENCES, packageOf, [
        { path: "apps/x/src/a.ts", name: "shrinking", crap: 500 },
      ]),
    ).toEqual([]);
  });

  it("demands a baseline entry be DROPPED once its function passes under", () => {
    // An inventory nobody prunes is one nobody trusts: a stale entry re-authorises
    // the untested complexity the work just paid off.
    const fn: MeasuredFunction = {
      path: "apps/x/src/a.ts",
      name: "paid",
      line: 9,
      complexity: 12,
      exported: true,
    };
    const findings = auditComplexityCoverage([fn], new Map([["apps/x", new Set(["paid"])]]), packageOf, [
      { path: "apps/x/src/a.ts", name: "paid", crap: 500 },
    ]);
    expect(findings[0]?.kind).toBe("stale-baseline");
  });

  it("says nothing about a baselined function that is gone", () => {
    expect(
      auditComplexityCoverage([], NO_REFERENCES, packageOf, [
        { path: "apps/x/src/deleted.ts", name: "gone", crap: 500 },
      ]),
    ).toEqual([]);
  });

  it("keeps the baseline shrink-only: every entry is over the ceiling it excuses", () => {
    for (const entry of COMPLEXITY_COVERAGE_BASELINE) {
      expect(entry.crap, `${entry.path} ${entry.name}`).toBeGreaterThan(CRAP_CEILING);
    }
  });
});

describe("promoted into the normal check set", () => {
  it("is declared as a repo-wide invariant, so a cone-scoped gate runs it", () => {
    const suite = REPO_INVARIANT_SUITES.find(
      (entry) => entry.name === "invariants:complexity-coverage",
    );
    expect(suite).toMatchObject({ scope: "apps/plugin-dev", script: "test:invariants" });
    expect(suite?.why).toContain("apps/");
  });

  it("is run by the script that invariant declaration names", () => {
    const manifest = readFileSync(join(ROOT, "apps/plugin-dev/package.json"), "utf8");
    const script = String(JSON.parse(manifest).scripts["test:invariants"]);
    expect(script).toContain("tests/complexity-coverage-guard.test.ts");
  });
});
