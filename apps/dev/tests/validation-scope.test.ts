import { describe, expect, it } from "vitest";
import {
  computeValidationScope,
  formatValidationScope,
  isRootTrigger,
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
    expect(isRootTrigger("packages/shared/package.json")).toBe(false);
  });

  it("does NOT trigger on normal source files", () => {
    expect(isRootTrigger("apps/dev/src/index.ts")).toBe(false);
    expect(isRootTrigger("README.md")).toBe(false);
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
});

// ---- computeValidationScope — cone expansion ----

describe("computeValidationScope — cone expansion", () => {
  it("leaf-package change → exact cone (package only when no dependents)", () => {
    // packages/shared has no dependents in this graph.
    const layout = fakeLayout(["packages/shared"]);
    const g = graph(["packages/shared"]);
    const scope = computeValidationScope(["packages/shared/src/index.ts"], layout, g);

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["packages/shared"]);
      expect(scope.triggerPackages).toEqual(["packages/shared"]);
    }
  });

  it("leaf-package change → cone includes direct dependents", () => {
    // apps/dev depends on packages/shared — changing shared must run apps/dev too.
    const layout = fakeLayout(["apps/dev", "packages/shared"]);
    const g = graph(["apps/dev", "packages/shared"], ["packages/shared"]);
    // Note: first entry "apps/dev" has no dependsOn; second is packages/shared.
    // Rebuild to express the dependency properly:
    const g2 = fakeGraph([
      { dir: "apps/dev", dependsOn: ["packages/shared"] },
      { dir: "packages/shared", dependsOn: [] },
    ]);
    const scope = computeValidationScope(["packages/shared/src/utils.ts"], layout, g2);

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["apps/dev", "packages/shared"]);
      expect(scope.triggerPackages).toEqual(["packages/shared"]);
    }
  });

  it("leaf-package change → cone includes transitive dependents (BFS)", () => {
    // apps/ui → apps/dev → packages/shared. Changing shared must reach apps/ui.
    const layout = fakeLayout(["apps/dev", "apps/ui", "packages/shared"]);
    const g = fakeGraph([
      { dir: "apps/dev", dependsOn: ["packages/shared"] },
      { dir: "apps/ui", dependsOn: ["apps/dev"] },
      { dir: "packages/shared", dependsOn: [] },
    ]);
    const scope = computeValidationScope(["packages/shared/src/index.ts"], layout, g);

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      expect(scope.packages).toEqual(["apps/dev", "apps/ui", "packages/shared"]);
      expect(scope.triggerPackages).toEqual(["packages/shared"]);
    }
  });

  it("multi-package change → union of cones (sorted LC_ALL=C)", () => {
    // apps/dev and packages/shared are both touched; apps/ui depends on apps/dev.
    const layout = fakeLayout(["apps/dev", "apps/ui", "packages/shared"]);
    const g = fakeGraph([
      { dir: "apps/dev", dependsOn: [] },
      { dir: "apps/ui", dependsOn: ["apps/dev"] },
      { dir: "packages/shared", dependsOn: [] },
    ]);
    const scope = computeValidationScope(
      ["apps/dev/src/x.ts", "packages/shared/src/y.ts"],
      layout,
      g,
    );

    expect(scope.type).toBe("cone");
    if (scope.type === "cone") {
      // apps/dev is triggered directly AND via apps/ui's dependency on apps/dev;
      // packages/shared is touched directly.
      expect(scope.packages).toEqual(["apps/dev", "apps/ui", "packages/shared"]);
      expect(scope.triggerPackages.sort()).toEqual(["apps/dev", "packages/shared"]);
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

// ---- scopesForValidationScope ----

describe("scopesForValidationScope", () => {
  it("whole-workspace → ['.']", () => {
    const scope: ValidationScope = { type: "whole-workspace", triggerFile: "turbo.json" };
    expect(scopesForValidationScope(scope)).toEqual(["."]);
  });

  it("cone → the cone package dirs", () => {
    const scope: ValidationScope = {
      type: "cone",
      packages: ["apps/dev", "packages/shared"],
      triggerPackages: ["packages/shared"],
    };
    expect(scopesForValidationScope(scope)).toEqual(["apps/dev", "packages/shared"]);
  });

  it("empty cone → []", () => {
    const scope: ValidationScope = { type: "cone", packages: [], triggerPackages: [] };
    expect(scopesForValidationScope(scope)).toEqual([]);
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
      packages: ["apps/dev", "packages/shared"],
      triggerPackages: ["packages/shared"],
    };
    const result = formatValidationScope(scope);
    expect(result).toContain("scope: cone [`apps/dev`, `packages/shared`]");
    expect(result).toContain("expanded from");
    expect(result).toContain("`packages/shared`");
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
    // Changed file in packages/shared; apps/dev depends on it → cone = both.
    const layout = fakeLayout(["apps/dev", "packages/shared"]);
    const g = fakeGraph([
      { dir: "apps/dev", dependsOn: ["packages/shared"] },
      { dir: "packages/shared", dependsOn: [] },
    ]);
    const changedFiles = ["packages/shared/src/index.ts"];
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

    // Gate must have invoked pnpm for BOTH apps/dev and packages/shared.
    const dirs = new Set(pnpmCalls.map((a) => a[a.indexOf("-C") + 1] ?? ""));
    expect(dirs.has("/wt/apps/dev")).toBe(true);
    expect(dirs.has("/wt/packages/shared")).toBe(true);
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
