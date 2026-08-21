import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditDependencyDirection,
  blankComments,
  collectImportEdges,
  collectImportSpecifiers,
  collectManifestEdges,
  DEPENDENCY_DIRECTION_EXCEPTIONS,
  DEPENDENCY_LAYERS,
  layerOfWorkspace,
  packageNameOf,
  resolveSpecifierWorkspace,
  workspaceOfPath,
  type DependencyEdge,
  type WorkspaceNode,
} from "../src/core/dependency-direction-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import { readWorkspaceGlobs } from "../src/core/version-train-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FIXTURES = join(import.meta.dirname, "fixtures", "dependency-direction");
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-bundle",
  "generated",
  // Fixtures describe the rule; they are not the tree it judges.
  "fixtures",
]);

interface WorkspacePackage extends WorkspaceNode {
  readonly dependencies: readonly string[];
}

/**
 * Every workspace the pnpm globs name, with its declared dependency names. The
 * SET comes from `pnpm-workspace.yaml`, never from a hand-kept list here: a new
 * app or package inherits the direction obligation the moment its manifest lands.
 */
function workspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const glob of readWorkspaceGlobs(ROOT)) {
    if (!glob.endsWith("/*")) continue;
    const parent = glob.slice(0, -2);
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = `${parent}/${entry.name}`;
      let manifest: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      try {
        // package.json is ecosystem JSON — the format pnpm itself owns.
        manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      found.push({
        dir,
        name: manifest.name ?? "",
        dependencies: [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
        ],
      });
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Every TypeScript source under the workspace dirs, repo-relative and sorted. */
function sourceFiles(workspaces: readonly WorkspaceNode[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) walk(path);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      files.push(relative(ROOT, path).split(sep).join("/"));
    }
  };
  for (const node of workspaces) walk(join(ROOT, node.dir));
  return files.sort();
}

/** Every cross-workspace edge in the live tree: manifest dependencies and source imports. */
function liveEdges(workspaces: readonly WorkspacePackage[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const node of workspaces) {
    edges.push(...collectManifestEdges(node.dependencies, node.dir, workspaces));
  }
  for (const path of sourceFiles(workspaces)) {
    edges.push(...collectImportEdges(readFileSync(join(ROOT, path), "utf8"), path, workspaces));
  }
  return edges;
}

const FIXTURE_WORKSPACES: readonly WorkspaceNode[] = [
  { dir: "packages/shared", name: "@reddb-io/shared" },
  { dir: "apps/plugin-dev", name: "@reddb-io/dev" },
  { dir: "apps/plugin-memory", name: "@reddb-io/memory" },
  { dir: "apps/redskilled", name: "@reddb-io/redskilled" },
  { dir: "apps/host-opencode", name: "@reddb-io/red-skills" },
];

function fixtureEdges(fixture: string, standsFor: string): DependencyEdge[] {
  return collectImportEdges(
    readFileSync(join(FIXTURES, fixture), "utf8"),
    standsFor,
    FIXTURE_WORKSPACES,
  );
}

describe("dependency-direction ratchet — the layering the workspace graph implies", () => {
  it("holds the live tree to the declared stack", () => {
    const workspaces = workspacePackages();
    const findings = auditDependencyDirection(liveEdges(workspaces), workspaces);
    const rendered = findings.map((f) => `  - ${f.reason}`).join("\n");
    expect(
      findings,
      findings.length === 0
        ? ""
        : `dependency-direction ratchet: ${findings.length} finding(s).\n${rendered}\n` +
          `Table: apps/plugin-dev/src/core/dependency-direction-guard.ts (DEPENDENCY_LAYERS); ` +
          `exceptions shrink only.`,
    ).toEqual([]);
  });

  it("REFUSES the committed fixture that reaches UP from shared into a runtime, naming both ends and the rule", () => {
    const edges = fixtureEdges("shared-reaches-runtime.ts.txt", "packages/shared/src/telemetry-bridge.ts");
    const findings = auditDependencyDirection(edges, FIXTURE_WORKSPACES, DEPENDENCY_LAYERS, []);

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.kind === "wrong-direction")).toBe(true);
    // Both ends, by name, in every finding: a ratchet that says only "somewhere
    // under packages/" sends the next reader hunting.
    for (const finding of findings) {
      expect(finding.fromWorkspace).toBe("packages/shared");
      expect(finding.toWorkspace).toBe("apps/plugin-dev");
      expect(finding.reason).toContain("packages/shared (layer shared, rank 1)");
      expect(finding.reason).toContain("apps/plugin-dev (layer runtime, rank 5)");
      expect(finding.reason).toContain("STRICTLY LOWER layer");
      expect(finding.reason).toContain("reaches upward");
    }
    expect(findings.map((f) => f.reason.includes('"@reddb-io/dev"'))).toContain(true);
    expect(findings.map((f) => f.line)).toEqual([10, 11]);
  });

  it("REFUSES a sideways reach into a sibling runtime while ACCEPTING the same file's reach down to the daemon", () => {
    const edges = fixtureEdges("runtime-reaches-sideways.ts.txt", "apps/host-opencode/src/probe.ts");
    expect(edges).toHaveLength(2);

    const findings = auditDependencyDirection(edges, FIXTURE_WORKSPACES, DEPENDENCY_LAYERS, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.toWorkspace).toBe("apps/plugin-memory");
    expect(findings[0]?.reason).toContain("reaches sideways");
    expect(findings[0]?.reason).toContain("the same layer");
  });

  it("takes a declared exception off the fixture's sideways reach, and demands it back once the edge is gone", () => {
    const exception = [
      {
        from: "apps/host-opencode/src/probe.ts",
        to: "apps/plugin-memory",
        why: "fixture",
      },
    ];
    const edges = fixtureEdges("runtime-reaches-sideways.ts.txt", "apps/host-opencode/src/probe.ts");
    expect(auditDependencyDirection(edges, FIXTURE_WORKSPACES, DEPENDENCY_LAYERS, exception)).toEqual([]);

    const stale = auditDependencyDirection([], FIXTURE_WORKSPACES, DEPENDENCY_LAYERS, exception);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.kind).toBe("stale-exception");
    expect(stale[0]?.reason).toContain("shrink-only");
  });

  it("refuses a workspace no layer claims, so a new package must state its rank", () => {
    const workspaces: WorkspaceNode[] = [{ dir: "vendor/thing", name: "@reddb-io/thing" }];
    const findings = auditDependencyDirection([], workspaces, DEPENDENCY_LAYERS, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("unlayered-workspace");
    expect(findings[0]?.reason).toContain("no layer claims it");
  });

  it("claims a NEW app for the runtime layer without a table edit, and a new package for nothing", () => {
    expect(layerOfWorkspace("apps/not-written-yet")?.id).toBe("runtime");
    expect(layerOfWorkspace("benchmarks/not-written-yet")?.id).toBe("benchmark");
    expect(layerOfWorkspace("packages/not-written-yet")).toBeUndefined();
    // A named member outranks its root claim: the daemon is an app that sits below every runtime.
    expect(layerOfWorkspace("apps/redskilled")?.id).toBe("daemon");
  });

  it("keeps the stack a strict order: one rank per layer, ascending, each with a stated meaning", () => {
    const ranks = DEPENDENCY_LAYERS.map((layer) => layer.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(new Set(DEPENDENCY_LAYERS.map((layer) => layer.id)).size).toBe(DEPENDENCY_LAYERS.length);
    for (const layer of DEPENDENCY_LAYERS) expect(layer.means.length).toBeGreaterThan(20);
    // No workspace may sit in two layers at once.
    const members = DEPENDENCY_LAYERS.flatMap((layer) => layer.workspaces);
    expect(new Set(members).size).toBe(members.length);
  });

  it("declares every exception with a repair, and none for an edge that is legal anyway", () => {
    const workspaces = workspacePackages();
    for (const entry of DEPENDENCY_DIRECTION_EXCEPTIONS) {
      expect(entry.why.length, `${entry.from} -> ${entry.to}`).toBeGreaterThan(40);
      const from = layerOfWorkspace(workspaceOfPath(entry.from, workspaces) ?? "");
      const to = layerOfWorkspace(entry.to);
      expect(from, entry.from).toBeDefined();
      expect(to, entry.to).toBeDefined();
      expect((from?.rank ?? 0) > (to?.rank ?? 0), `${entry.from} -> ${entry.to} is legal`).toBe(false);
    }
  });
});

describe("reading an edge out of source", () => {
  it("finds every shape an import is written in", () => {
    const specifiers = collectImportSpecifiers(
      [
        `import a from "one";`,
        `import type { B } from "two";`,
        `export { c } from "three";`,
        `export * from "four";`,
        `import "five";`,
        `const f = await import("six");`,
        `const g = require("seven");`,
        `import {`,
        `  h,`,
        `} from "eight";`,
      ].join("\n"),
    );
    expect(specifiers.map((s) => s.specifier)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
    ]);
    expect(specifiers[0]?.line).toBe(1);
    expect(specifiers[7]?.line).toBe(8);
  });

  it("reads no edge out of a comment, because an example is documentation", () => {
    expect(
      collectImportSpecifiers(
        `// import x from "commented";\n/* import y from "blocked"; */\nimport z from "real";`,
      ).map((s) => s.specifier),
    ).toEqual(["real"]);
  });

  it("blanks comments without moving a single line", () => {
    const text = `const a = 1; // note\n/* two\n   lines */\nconst b = "/* not a comment */";`;
    const blanked = blankComments(text);
    expect(blanked.split("\n")).toHaveLength(text.split("\n").length);
    expect(blanked).toContain("const a = 1;");
    expect(blanked).not.toContain("note");
    expect(blanked).not.toContain("two");
    // A comment-looking run inside a string literal is a string, not a comment.
    expect(blanked).toContain(`"/* not a comment */"`);
  });

  it("names the package a deep specifier addresses", () => {
    expect(packageNameOf("@reddb-io/shared/args")).toBe("@reddb-io/shared");
    expect(packageNameOf("@reddb-io/shared")).toBe("@reddb-io/shared");
    expect(packageNameOf("node:fs")).toBe("node:fs");
    expect(packageNameOf("typescript/lib/x")).toBe("typescript");
  });

  it("resolves a relative reach that climbs out of its own workspace", () => {
    expect(
      resolveSpecifierWorkspace(
        "../../plugin-dev/src/core/boot.js",
        "apps/rsp/tests/a.test.ts",
        FIXTURE_WORKSPACES,
      ),
    ).toBe("apps/plugin-dev");
    expect(
      resolveSpecifierWorkspace("./sibling.js", "apps/plugin-dev/src/a.ts", FIXTURE_WORKSPACES),
    ).toBe("apps/plugin-dev");
    // Outside the graph entirely: a repo-root script and a node builtin.
    expect(
      resolveSpecifierWorkspace("../../../scripts/x.mjs", "apps/plugin-dev/src/a.ts", FIXTURE_WORKSPACES),
    ).toBeUndefined();
    expect(resolveSpecifierWorkspace("node:fs", "apps/plugin-dev/src/a.ts", FIXTURE_WORKSPACES)).toBeUndefined();
  });

  it("owns a path by the LONGEST workspace dir it sits inside", () => {
    const nested: WorkspaceNode[] = [
      { dir: "packages/a", name: "a" },
      { dir: "packages/a/nested", name: "a-nested" },
    ];
    expect(workspaceOfPath("packages/a/nested/src/x.ts", nested)).toBe("packages/a/nested");
    expect(workspaceOfPath("packages/a/src/x.ts", nested)).toBe("packages/a");
    expect(workspaceOfPath("scripts/x.ts", nested)).toBeUndefined();
  });

  it("writes no edge for an import that stays home or leaves the graph", () => {
    expect(
      collectImportEdges(
        `import a from "./local.js";\nimport b from "node:fs";\nimport c from "vitest";`,
        "packages/shared/src/a.ts",
        FIXTURE_WORKSPACES,
      ),
    ).toEqual([]);
    expect(collectImportEdges(`import a from "@reddb-io/dev";`, "scripts/a.ts", FIXTURE_WORKSPACES)).toEqual([]);
  });

  it("writes a manifest edge only for a workspace dependency", () => {
    const edges = collectManifestEdges(
      ["@reddb-io/dev", "typescript", "@reddb-io/shared"],
      "packages/shared",
      FIXTURE_WORKSPACES,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: "packages/shared/package.json",
      toWorkspace: "apps/plugin-dev",
      kind: "manifest",
      line: 0,
    });
  });
});

describe("promoted into the normal check set", () => {
  it("is declared as a repo-wide invariant, so a cone-scoped gate runs it", () => {
    const suite = REPO_INVARIANT_SUITES.find(
      (entry) => entry.name === "invariants:dependency-direction",
    );
    expect(suite).toMatchObject({ scope: "apps/plugin-dev", script: "test:invariants" });
    expect(suite?.why).toContain("packages/");
  });

  it("is run by the script that invariant declaration names", () => {
    const manifest = readFileSync(join(ROOT, "apps/plugin-dev/package.json"), "utf8");
    const script = String(JSON.parse(manifest).scripts["test:invariants"]);
    expect(script).toContain("tests/dependency-direction-guard.test.ts");
  });
});
