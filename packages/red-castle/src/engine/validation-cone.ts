import { ROOT_TRIGGER_FILES } from "./gate-constants.js";

export interface PackageLayout {
  hasPackage: (scope: string) => boolean;
}

export interface WorkspacePackage {
  dir: string;
  dependsOn: readonly string[];
}

export interface WorkspaceGraph {
  packages: readonly WorkspacePackage[];
}

export type ValidationScope =
  | {
      type: "cone";
      packages: string[];
      triggerPackages: string[];
    }
  | {
      type: "whole-workspace";
      triggerFile: string;
    };

function stripDotSlash(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

export function isRootTrigger(file: string): boolean {
  const clean = stripDotSlash(file);
  if (clean.startsWith(".github/")) return true;
  if (clean.includes("/")) return false;
  return (ROOT_TRIGGER_FILES as readonly string[]).includes(clean);
}

export function nearestPackageScope(layout: PackageLayout, file: string): string | undefined {
  if (file === "") return undefined;
  const clean = stripDotSlash(file);
  let dir = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : ".";

  while (dir !== "" && dir !== "." && dir !== "/") {
    if (layout.hasPackage(dir)) return dir;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
  }

  return layout.hasPackage(".") ? "." : undefined;
}

export function relevantScopes(layout: PackageLayout, changedFiles: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const file of changedFiles) {
    const scope = nearestPackageScope(layout, file);
    if (scope !== undefined) seen.add(scope);
  }
  if (seen.size === 0 && layout.hasPackage(".")) seen.add(".");
  return [...seen].sort();
}

export function expandReverseDependencyCone(
  touchedDirs: readonly string[],
  graph: WorkspaceGraph,
): string[] {
  const reverseDeps = new Map<string, string[]>();
  for (const pkg of graph.packages) {
    for (const dep of pkg.dependsOn) {
      const dependents = reverseDeps.get(dep) ?? [];
      dependents.push(pkg.dir);
      reverseDeps.set(dep, dependents);
    }
  }

  const cone = new Set(touchedDirs);
  const queue = [...touchedDirs];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    for (const dependent of reverseDeps.get(dir) ?? []) {
      if (!cone.has(dependent)) {
        cone.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return [...cone].sort();
}

export function computeValidationScope(
  changedFiles: readonly string[],
  layout: PackageLayout,
  graph: WorkspaceGraph,
): ValidationScope {
  for (const file of changedFiles) {
    if (isRootTrigger(file)) {
      return { type: "whole-workspace", triggerFile: stripDotSlash(file) };
    }
  }

  const triggerPackages = relevantScopes(layout, changedFiles);
  return {
    type: "cone",
    packages: expandReverseDependencyCone(triggerPackages, graph),
    triggerPackages,
  };
}

export function scopesForValidationScope(scope: ValidationScope): string[] {
  return scope.type === "whole-workspace" ? ["."] : scope.packages;
}
