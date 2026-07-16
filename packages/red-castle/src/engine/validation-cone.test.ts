import { describe, expect, it } from "vitest";
import {
  computeValidationScope,
  expandReverseDependencyCone,
  scopesForValidationScope,
  type PackageLayout,
  type WorkspaceGraph,
} from "./validation-cone.js";

const layout: PackageLayout = {
  hasPackage(scope) {
    return [".", "packages/core", "apps/dev", "apps/docs", "packages/red-castle"].includes(scope);
  },
};

const graph: WorkspaceGraph = {
  packages: [
    { dir: "packages/core", dependsOn: [] },
    { dir: "apps/dev", dependsOn: ["packages/core", "packages/red-castle"] },
    { dir: "apps/docs", dependsOn: ["apps/dev"] },
    { dir: "packages/red-castle", dependsOn: [] },
  ],
};

describe("castle validation cone", () => {
  it("expands package-scoped diffs through reverse-dependent BFS only", () => {
    expect(expandReverseDependencyCone(["packages/core"], graph)).toEqual([
      "apps/dev",
      "apps/docs",
      "packages/core",
    ]);
  });

  it("does not escalate package-scoped castle or shared changes to whole workspace", () => {
    expect(computeValidationScope(["packages/red-castle/src/engine/gate-executor.ts"], layout, graph)).toEqual({
      type: "cone",
      triggerPackages: ["packages/red-castle"],
      packages: ["apps/dev", "apps/docs", "packages/red-castle"],
    });

    expect(computeValidationScope(["packages/core/src/index.ts"], layout, graph).type).toBe("cone");
  });

  it("escalates only root-trigger files to whole workspace", () => {
    const scope = computeValidationScope(["pnpm-lock.yaml"], layout, graph);
    expect(scope).toEqual({ type: "whole-workspace", triggerFile: "pnpm-lock.yaml" });
    expect(scopesForValidationScope(scope)).toEqual(["."]);
  });
});
