import { describe, expect, it } from "vitest";
import { computeCiScope } from "../../../scripts/ci-affected-scope.mjs";
import {
  computeValidationScope,
  formatValidationScope,
  gateScopes,
  isRootTrigger,
  scopeNeedsWholeSuite,
  scopesForValidationScope,
  type ValidationScope,
  type WorkspaceGraph,
  type WorkspacePackage,
} from "../src/core/validation-scope.js";
import {
  runFeedback,
  type Exec,
  type ExecResult,
  type PackageLayout,
} from "../src/core/feedback.js";

// ---- helpers ----

function fakeLayout(packages: readonly string[]): PackageLayout {
  const set = new Set(packages);
  return {
    hasPackage: (dir) => set.has(dir),
    hasScript: () => true,
  };
}

function fakeGraph(pkgs: WorkspacePackage[]): WorkspaceGraph {
  return { packages: pkgs };
}

/**
 * Build a WorkspaceGraph from a simple adjacency description: each entry is
 * `[dir, ...dependsOn]`. All dirs that appear (as keys or deps) are included.
 */
function graph(...entries: [string, ...string[]][]): WorkspaceGraph {
  const packages: WorkspacePackage[] = entries.map(([dir, ...deps]) => ({
    dir,
    dependsOn: deps,
  }));
  return fakeGraph(packages);
}

// ---- isRootTrigger ----

describe("isRootTrigger", () => {
  it("matches the lockfile", () => {
    expect(isRootTrigger("pnpm-lock.yaml")).toBe(true);
    expect(isRootTrigger("./pnpm-lock.yaml")).toBe(true);
  });

  it("matches root-level tsconfig and turbo", () => {
    expect(isRootTrigger("tsconfig.json")).toBe(true);
    expect(isRootTrigger("tsconfig.base.json")).toBe(true);
    expect(isRootTrigger("turbo.json")).toBe(true);
  });

  it("matches root package.json and workspace manifest", () => {
    expect(isRootTrigger("package.json")).toBe(true);
    expect(isRootTrigger("pnpm-workspace.yaml")).toBe(true);
  });

  it("matches .github/** CI configs", () => {
    expect(isRootTrigger(".github/workflows/ci.yml")).toBe(true);
    expect(isRootTrigger(".github/CODEOWNERS")).toBe(true);
  });

  it("does NOT trigger on package-level tsconfig.json", () => {
    expect(isRootTrigger("apps/dev/tsconfig.json")).toBe(false);
    expect(isRootTrigger("packages/leaf/package.json")).toBe(false);
  });

  it("does NOT trigger on normal source files", () => {
    expect(isRootTrigger("apps/dev/src/index.ts")).toBe(false);
    expect(isRootTrigger("README.md")).toBe(false);
  });
});

// ---- scopeNeedsWholeSuite ----

describe("scopeNeedsWholeSuite", () => {
  it("does not escalate package-local core-module touches through the deleted manifest", () => {
    expect(scopeNeedsWholeSuite(["apps/dev/src/core/process-issue.ts"])).toBe(false);
  });

  it("keeps leaf touches on the scoped package path", () => {
    expect(scopeNeedsWholeSuite(["apps/dev/tests/feedback.test.ts"])).toBe(false);
  });
});

// ---- computeValidationScope — root trigger ----

describe("computeValidationScope — whole-workspace escalation", () => {
  const layout = fakeLayout([".", "apps/dev"]);
  const g = graph(["apps/dev"]);

  it("escalates to whole-workspace on a lockfile change", () => {
    const scope = computeValidationScope(["pnpm-lock.yaml"], layout, g);
    expect(scope.type).toBe("whole-workspace");
    if (scope.type === "whole-workspace") {
      expect(scope.triggerFile).toBe("pnpm-lock.yaml");
    }
  });

  it("escalates to whole-workspace on a .github/ change even when other files are package-local", () => {
    const scope = computeValidationScope(
      ["apps/dev/src/index.ts", ".github/workflows/ci.yml"],
      layout,
      g,
    );
    expect(scope.type).toBe("whole-workspace");
    if (scope.type === "whole-workspace") {
      expect(scope.triggerFile).toBe(".github/workflows/ci.yml");
    }
  });

  it("strips the leading ./ from the trigger file path", () => {
    const scope = computeValidationScope(["./pnpm-lock.yaml"], layout, g);
    expect(scope.type).toBe("whole-workspace");
    if (scope.type === "whole-workspace") {
      expect(scope.triggerFile).toBe("pnpm-lock.yaml");
    }
  });

  it("regression: whole-workspace behaviour preserved for root changes", () => {
    // Root changes must ALWAYS run the full workspace. Any cone expansion that
    // limited the scope to touched packages would under-validate.
    const scope = computeValidationScope(["turbo.json"], layout, g);
    expect(scope.type).toBe("whole-workspace");
    expect(scopesForValidationScope(scope)).toEqual(["."]);
  });

  it("keeps package-local core-module changes in the package cone", () => {
    const scope = computeValidationScope(["apps/dev/src/core/process-issue.ts"], layout, g);
    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["apps/dev"]);
      expect(scope.triggerPackages).toEqual(["apps/dev"]);
    }
    expect(scopesForValidationScope(scope)).toEqual(["apps/dev"]);
  });

  it("does not widen a package cone for a proven version-only root manifest change", () => {
    const scope = computeValidationScope(
      ["package.json", "apps/dev/src/core/go.ts"],
      layout,
      g,
      {
        rootPackageJson: {
          before: JSON.stringify({ name: "red-skills", version: "1.2.3", scripts: { test: "vitest" } }),
          after: JSON.stringify({ name: "red-skills", version: "1.2.4", scripts: { test: "vitest" } }),
        },
      },
    );

    expect(scope.type).toBe("cone");
    expect(scopesForValidationScope(scope)).toEqual(["apps/dev"]);
    expect(scopesForValidationScope(scope)).not.toContain(".");
  });

  it("keeps a root manifest global when version and behavioural content both change", () => {
    const scope = computeValidationScope(
      ["package.json", "apps/dev/src/core/go.ts"],
      layout,
      g,
      {
        rootPackageJson: {
          before: JSON.stringify({ name: "red-skills", version: "1.2.3", dependencies: { a: "1" } }),
          after: JSON.stringify({ name: "red-skills", version: "1.2.4", dependencies: { a: "2" } }),
        },
      },
    );

    expect(scope.type).toBe("whole-workspace");
    expect(scopesForValidationScope(scope)).toEqual(["."]);
  });

  it("keeps a root manifest global when no content comparison proves the change safe", () => {
    const scope = computeValidationScope(["package.json", "apps/dev/src/core/go.ts"], layout, g);
    expect(scope.type).toBe("whole-workspace");
  });
});

// ---- computeValidationScope — cone expansion ----

describe("computeValidationScope — cone expansion", () => {
  it("leaf-package change → exact cone (package only when no dependents)", () => {
    // packages/leaf has no dependents in this graph.
    const layout = fakeLayout(["packages/leaf"]);
    const g = graph(["packages/leaf"]);
    const scope = computeValidationScope(["packages/leaf/src/index.ts"], layout, g);

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["packages/leaf"]);
      expect(scope.triggerPackages).toEqual(["packages/leaf"]);
    }
  });

  it("leaf-package change → cone includes direct dependents", () => {
    // apps/dev depends on packages/leaf — changing leaf must run apps/dev too.
    const layout = fakeLayout(["apps/dev", "packages/leaf"]);
    const g = graph(["apps/dev", "packages/leaf"], ["packages/leaf"]);
    // Note: first entry "apps/dev" has no dependsOn; second is packages/leaf.
    // Rebuild to express the dependency properly:
    const g2 = fakeGraph([
      { dir: "apps/dev", dependsOn: ["packages/leaf"] },
      { dir: "packages/leaf", dependsOn: [] },
    ]);
    const scope = computeValidationScope(["packages/leaf/src/utils.ts"], layout, g2);

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["apps/dev", "packages/leaf"]);
      expect(scope.triggerPackages).toEqual(["packages/leaf"]);
    }
  });

  it("leaf-package change → cone includes transitive dependents (BFS)", () => {
    // apps/ui → apps/dev → packages/leaf. Changing leaf must reach apps/ui.
    const layout = fakeLayout(["apps/dev", "apps/ui", "packages/leaf"]);
    const g = fakeGraph([
      { dir: "apps/dev", dependsOn: ["packages/leaf"] },
      { dir: "apps/ui", dependsOn: ["apps/dev"] },
      { dir: "packages/leaf", dependsOn: [] },
    ]);
    const scope = computeValidationScope(["packages/leaf/src/index.ts"], layout, g);

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["apps/dev", "apps/ui", "packages/leaf"]);
      expect(scope.triggerPackages).toEqual(["packages/leaf"]);
    }
  });

  it("multi-package change → union of cones (sorted LC_ALL=C)", () => {
    // apps/dev and packages/leaf are both touched; apps/ui depends on apps/dev.
    const layout = fakeLayout(["apps/dev", "apps/ui", "packages/leaf"]);
    const g = fakeGraph([
      { dir: "apps/dev", dependsOn: [] },
      { dir: "apps/ui", dependsOn: ["apps/dev"] },
      { dir: "packages/leaf", dependsOn: [] },
    ]);
    const scope = computeValidationScope(
      ["apps/dev/src/x.ts", "packages/leaf/src/y.ts"],
      layout,
      g,
    );

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      // apps/dev is triggered directly AND via apps/ui's dependency on apps/dev;
      // packages/leaf is touched directly.
      expect(scope.packages).toEqual(["apps/dev", "apps/ui", "packages/leaf"]);
      expect(scope.triggerPackages.sort()).toEqual(["apps/dev", "packages/leaf"]);
    }
  });

  it("empty changed-file set → empty cone", () => {
    const layout = fakeLayout(["apps/dev"]);
    const g = fakeGraph([{ dir: "apps/dev", dependsOn: [] }]);
    const scope = computeValidationScope([], layout, g);

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual([]);
      expect(scope.triggerPackages).toEqual([]);
    }
  });
});

// ---- computeValidationScope — path classification (#2984) ----

describe("computeValidationScope — the mandatory changeset never widens the cone", () => {
  // A layout shaped like this repo: a root package plus the two packages the
  // acceptance criteria name.
  const layout = fakeLayout([".", "apps/dev", "apps/redskilled", "packages/shared"]);
  const g = fakeGraph([
    { dir: "apps/dev", dependsOn: ["packages/shared"] },
    { dir: "apps/redskilled", dependsOn: ["packages/shared"] },
    { dir: "packages/shared", dependsOn: [] },
  ]);

  it("a slice + its changeset scopes to the slice's cone, not the root", () => {
    const scope = computeValidationScope(
      ["apps/redskilled/src/x.ts", ".changeset/lucky-pandas-shave.md"],
      layout,
      g,
    );

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["apps/redskilled"]);
      expect(scope.triggerPackages).toEqual(["apps/redskilled"]);
    }
    expect(scopesForValidationScope(scope)).toEqual(["apps/redskilled"]);
    expect(scopesForValidationScope(scope)).not.toContain(".");
  });

  it("a changeset-only branch contributes no scope at all", () => {
    const scope = computeValidationScope([".changeset/quiet-moons-wave.md"], layout, g);
    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual([]);
    }
  });

  it("disposable `.red/` lanes are inert too", () => {
    const scope = computeValidationScope(
      ["apps/dev/src/core/x.ts", ".red/tmp/scratch/note.md", ".red/researches/r.md"],
      layout,
      g,
    );
    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.triggerPackages).toEqual(["apps/dev"]);
    }
  });

  it("`.red/adr/*.md` still validates its doc-contract owner (no under-validation)", () => {
    const scope = computeValidationScope([".red/adr/0131-something.md"], layout, g);
    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.triggerPackages).toEqual(["apps/dev"]);
      expect(scope.packages).toEqual(["apps/dev"]);
    }
  });

  it("other `.red/` docs and `plugins/**` map to the same doc-contract owner", () => {
    for (const file of [
      ".red/contexts/dev/CONTEXT.md",
      "plugins/dev/skills/engineering/red-setup/domain.md",
      ".claude-plugin/marketplace.json",
      "README.md",
      "CLAUDE.md",
    ]) {
      const scope = computeValidationScope([file], layout, g);
      expect(scope.type, file).toBe("cone");
      if (scope.type === "cone") expect(scope.triggerPackages, file).toEqual(["apps/dev"]);
    }
  });

  it("`.red/config.yaml` is configuration, not prose — it escalates", () => {
    const scope = computeValidationScope([".red/config.yaml"], layout, g);
    expect(scope.type).toBe("whole-workspace");
    if (scope.type === "whole-workspace") expect(scope.triggerFile).toBe(".red/config.yaml");
  });

  it("an unclassifiable path escalates rather than narrowing", () => {
    for (const file of ["scripts/ci-affected-scope.mjs", "dist/bundle.mjs", "Makefile"]) {
      const scope = computeValidationScope([file], layout, g);
      expect(scope.type, file).toBe("whole-workspace");
    }
  });

  it("a docs change escalates when no doc-contract owner exists in the layout", () => {
    // A repo without apps/dev cannot narrow a docs change honestly.
    const bare = fakeLayout([".", "packages/shared"]);
    const scope = computeValidationScope([".red/adr/0001-x.md"], bare, fakeGraph([]));
    expect(scope.type).toBe("whole-workspace");
  });
});

// ---- taxonomy parity with scripts/ci-affected-scope.mjs ----

describe("classification parity — the gate and CI share one taxonomy", () => {
  // Mirrors this repo's real shape closely enough to exercise every rule.
  const ciGraph = [
    { dir: "apps/dev", name: "@reddb-io/dev", dependsOn: ["packages/shared"] },
    { dir: "apps/redskilled", name: "@reddb-io/redskilled", dependsOn: ["packages/shared"] },
    { dir: "packages/shared", name: "@reddb-io/shared", dependsOn: [] },
  ];
  const layout = fakeLayout([".", ...ciGraph.map((p) => p.dir)]);
  const gateGraph = fakeGraph(ciGraph.map(({ dir, dependsOn }) => ({ dir, dependsOn })));

  const PATHS = [
    "apps/redskilled/src/x.ts",
    "packages/shared/src/args.ts",
    "apps/dev/tests/feedback.test.ts",
    ".changeset/lucky-pandas-shave.md",
    ".red/tmp/scratch/note.md",
    ".red/researches/report.md",
    ".red/adr/0131-something.md",
    ".red/contexts/dev/CONTEXT.md",
    ".red/config.yaml",
    "plugins/dev/skills/engineering/red-setup/domain.md",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "README.md",
    "CHANGES.md",
    "package.json",
    "pnpm-lock.yaml",
    "turbo.json",
    ".github/workflows/red-workspace-ci.yml",
    "scripts/ci-affected-scope.mjs",
  ];

  it.each(PATHS)("classifies %s the same way CI does", (file) => {
    const ci = computeCiScope([file], ciGraph);
    const gate = computeValidationScope([file], layout, gateGraph);

    if (ci.mode === "whole-workspace") {
      expect(gate.type).toBe("whole-workspace");
      return;
    }
    expect(gate.type).toBe("cone");
    if (gate.type === "cone") expect(gate.triggerPackages).toEqual(ci.triggerPackages);
  });

  it("agrees on a realistic slice diff (source + changeset + ADR)", () => {
    const files = [
      "apps/redskilled/src/registration.ts",
      "apps/redskilled/tests/registration.test.ts",
      ".changeset/lucky-pandas-shave.md",
    ];
    const ci = computeCiScope(files, ciGraph);
    const gate = computeValidationScope(files, layout, gateGraph);

    expect(ci.mode).toBe("cone");
    expect(gate.type).toBe("cone");
    if (gate.type === "cone") {
      expect(gate.triggerPackages).toEqual(ci.triggerPackages);
      expect(gate.packages).toEqual(ci.testPackages);
      expect(gate.packages).toEqual(["apps/redskilled"]);
    }
  });
});

// ---- scopesForValidationScope ----

describe("scopesForValidationScope", () => {
  it("whole-workspace → ['.']", () => {
    const scope: ValidationScope = { type: "whole-workspace", triggerFile: "turbo.json" };
    expect(scopesForValidationScope(scope)).toEqual(["."]);
  });

  it("cone → the cone package dirs", () => {
    const scope: ValidationScope = {
      type: "cone",
      packages: ["apps/dev", "packages/leaf"],
      triggerPackages: ["packages/leaf"],
    };
    expect(scopesForValidationScope(scope)).toEqual(["apps/dev", "packages/leaf"]);
  });

  it("empty cone → []", () => {
    const scope: ValidationScope = { type: "cone", packages: [], triggerPackages: [] };
    expect(scopesForValidationScope(scope)).toEqual([]);
  });
});

// ---- gateScopes — the graph-less gate paths (gate_run, reconcile) ----

describe("gateScopes", () => {
  const layout = fakeLayout([".", "apps/dev", "apps/redskilled"]);

  it("classifies the changeset away on a graph-less gate path too", () => {
    expect(gateScopes(layout, ["apps/redskilled/src/x.ts", ".changeset/y.md"])).toEqual([
      "apps/redskilled",
    ]);
  });

  it("still escalates a root change to the whole workspace", () => {
    expect(gateScopes(layout, ["pnpm-lock.yaml", "apps/dev/src/x.ts"])).toEqual(["."]);
  });

  it("resolves trigger packages only — no dependents, having no graph to expand", () => {
    expect(gateScopes(layout, ["apps/dev/src/x.ts"])).toEqual(["apps/dev"]);
  });
});

// ---- formatValidationScope ----

describe("formatValidationScope", () => {
  it("formats a whole-workspace scope", () => {
    const scope: ValidationScope = { type: "whole-workspace", triggerFile: "pnpm-lock.yaml" };
    expect(formatValidationScope(scope)).toBe("scope: whole-workspace (trigger: `pnpm-lock.yaml`)");
  });

  it("formats a simple cone (no expansion)", () => {
    const scope: ValidationScope = {
      type: "cone",
      packages: ["apps/dev"],
      triggerPackages: ["apps/dev"],
    };
    expect(formatValidationScope(scope)).toBe("scope: cone [`apps/dev`]");
  });

  it("formats an expanded cone (trigger ≠ cone)", () => {
    const scope: ValidationScope = {
      type: "cone",
      packages: ["apps/dev", "packages/leaf"],
      triggerPackages: ["packages/leaf"],
    };
    const result = formatValidationScope(scope);
    expect(result).toContain("scope: cone [`apps/dev`, `packages/leaf`]");
    expect(result).toContain("expanded from");
    expect(result).toContain("`packages/leaf`");
  });

  it("formats an empty cone", () => {
    const scope: ValidationScope = { type: "cone", packages: [], triggerPackages: [] };
    expect(formatValidationScope(scope)).toContain("no package found");
  });
});

// ---- gate integration: runFeedback respects the cone scopes ----

describe("gate integration — runFeedback runs the cone", () => {
  /**
   * Simulate a fakeExec that records which package dirs were targeted by pnpm.
   * Returns an object with the accumulated argv list for inspection.
   */
  function trackingExec(): { exec: Exec; pnpmCalls: string[][] } {
    const pnpmCalls: string[][] = [];
    const exec: Exec = async (args) => {
      pnpmCalls.push(args);
      return { code: 0, stdout: "ok", stderr: "" } satisfies ExecResult;
    };
    return { exec, pnpmCalls };
  }

  it("passes cone packages as pnpm -C targets", async () => {
    // Changed file in packages/leaf; apps/dev depends on it → cone = both.
    const layout = fakeLayout(["apps/dev", "packages/leaf"]);
    const g = fakeGraph([
      { dir: "apps/dev", dependsOn: ["packages/leaf"] },
      { dir: "packages/leaf", dependsOn: [] },
    ]);
    const changedFiles = ["packages/leaf/src/index.ts"];
    const scope = computeValidationScope(changedFiles, layout, g);
    const scopes = scopesForValidationScope(scope);

    const { exec, pnpmCalls } = trackingExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes,
      layout,
      now: () => 0,
      validationScope: scope,
    });

    expect(result.ok).toBe(true);
    expect(result.validationScope).toBe(scope);

    // Gate must have invoked pnpm for BOTH apps/dev and packages/leaf.
    const dirs = new Set(pnpmCalls.map((a) => a[a.indexOf("-C") + 1] ?? ""));
    expect(dirs.has("/wt/apps/dev")).toBe(true);
    expect(dirs.has("/wt/packages/leaf")).toBe(true);
  });

  it("whole-workspace trigger passes ['.'] as the only scope", async () => {
    const layout = fakeLayout([".", "apps/dev"]);
    const g = fakeGraph([{ dir: "apps/dev", dependsOn: [] }]);
    const changedFiles = ["pnpm-lock.yaml"];
    const scope = computeValidationScope(changedFiles, layout, g);

    expect(scope.type).toBe("whole-workspace");
    const scopes = scopesForValidationScope(scope);
    expect(scopes).toEqual(["."]);

    const { exec, pnpmCalls } = trackingExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes,
      layout,
      now: () => 0,
      validationScope: scope,
    });

    expect(result.ok).toBe(true);
    expect(result.validationScope?.type).toBe("whole-workspace");

    // All pnpm calls must target the workspace root ("/wt"), never a sub-package.
    const dirs = pnpmCalls.map((a) => a[a.indexOf("-C") + 1] ?? "");
    expect(dirs.every((d) => d === "/wt")).toBe(true);
  });

  it("a branch that carries a changeset runs the cone's `pnpm -C` line, not the root's", async () => {
    // The regression #2984 names: source + the mandatory changeset. The gate
    // command the worker actually runs must target the slice's package.
    const layout = fakeLayout([".", "apps/dev", "apps/redskilled", "packages/shared"]);
    const g = fakeGraph([
      { dir: "apps/dev", dependsOn: ["packages/shared"] },
      { dir: "apps/redskilled", dependsOn: ["packages/shared"] },
      { dir: "packages/shared", dependsOn: [] },
    ]);
    const changedFiles = ["apps/redskilled/src/x.ts", ".changeset/lucky-pandas-shave.md"];
    const scope = computeValidationScope(changedFiles, layout, g);
    const scopes = scopesForValidationScope(scope);

    const { exec, pnpmCalls } = trackingExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes,
      layout,
      now: () => 0,
      validationScope: scope,
    });

    expect(result.ok).toBe(true);

    // The command line the worker actually runs — what a human also reads off
    // the envelope — targets the slice's package.
    const commands = pnpmCalls.map((a) => a.join(" "));
    expect(commands).toContain("pnpm -C /wt/apps/redskilled test");
    // The whole-workspace suite is exactly what #2984 was paying for. It is gone.
    expect(commands).not.toContain("pnpm -C /wt test");
    for (const script of ["test", "lint", "build"]) {
      expect(commands, script).not.toContain(`pnpm -C /wt/apps/dev ${script}`);
    }
    // Two repo-wide sweeps survive the narrowing on purpose: the cross-package
    // typecheck and apps/dev's repo-invariant suite (#2762).
    expect(commands).toContain("pnpm -C /wt typecheck");
    expect(commands).toContain("pnpm -C /wt/apps/dev test:invariants");

    const recorded = result.checks.map((c) => c.record.command).filter((c): c is string => !!c);
    expect(recorded).toContain("pnpm -C /wt/apps/redskilled test");
    expect(recorded).not.toContain("pnpm -C /wt test");
  });

  it("validationScope is undefined in result when not provided (backwards compat)", async () => {
    const layout = fakeLayout(["apps/dev"]);
    const { exec } = trackingExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/dev"],
      layout,
      now: () => 0,
    });
    expect(result.validationScope).toBeUndefined();
  });
});
