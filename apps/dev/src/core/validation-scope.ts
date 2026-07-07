// validation-scope — dependency-cone scoping for the AFK feedback gate (T5, PRD #1013).
//
// The gate must run the full dependency cone of a change, not just the directly
// touched packages: if package A depends on package B and the worker edits B, A
// also needs its tests run (B's change could break A). This module computes the
// cone as a pure function over an injected workspace graph so the decision logic
// is unit-testable without a real pnpm workspace.
//
// Root-config changes (lockfile, workspace manifest, tsconfig, turbo.json,
// .github/**) have global blast radius and escalate to whole-workspace mode
// (scopes = ["."]) so they are never under-validated.

import { type PackageLayout, relevantScopes } from "./feedback.js";

/** A workspace package: its repo-relative dir and the dirs it directly depends on. */
export interface WorkspacePackage {
  /** Repo-relative directory, e.g. "apps/dev" or "packages/shared". Never ".". */
  dir: string;
  /**
   * Repo-relative dirs of workspace packages this package directly depends on
   * (workspace-internal deps only; external npm deps are irrelevant for scoping).
   */
  dependsOn: string[];
}

/**
 * Injected workspace graph — pure interface for testability. The real
 * implementation reads pnpm-workspace.yaml and each package.json to resolve
 * workspace-internal dependency edges.
 */
export interface WorkspaceGraph {
  /** All workspace packages, excluding the workspace root ("."). */
  packages: WorkspacePackage[];
}

/**
 * The computed validation scope — either a filtered cone (touching only the
 * affected packages and their transitive dependents) or whole-workspace (when a
 * root-config change has global blast radius). Recorded in the Envelope so a
 * human reading a blocked:validation park can see exactly what was tested.
 */
export type ValidationScope =
  | {
      type: "cone";
      /**
       * All packages in the scope: directly touched packages plus their
       * transitive dependents. Sorted (LC_ALL=C byte order). Empty when no
       * changed file maps to a package.
       */
      packages: string[];
      /**
       * The subset of packages that changed files mapped to directly (the
       * "why" of the cone). Useful for audit — "we ran A and B because C
       * depends on both; the trigger was C."
       */
      triggerPackages: string[];
    }
  | {
      type: "whole-workspace";
      /**
       * The first changed file that triggered whole-workspace mode. A single
       * example is enough: it identifies the class of change (lockfile,
       * tsconfig, .github/workflow) that caused the escalation.
       */
      triggerFile: string;
    };

// Root-config files whose presence in changedFiles triggers whole-workspace
// validation. Anything outside a package directory has global blast radius
// and must not be under-validated by cone scoping.
const ROOT_TRIGGER_FILES = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".npmrc",
  ".nvmrc",
]);

/**
 * Reviewable manifest of shared/core modules whose changes have cross-cutting
 * blast radius beyond the package cone. Touching any path here escalates the
 * AFK feedback gate to the whole workspace suite.
 */
export const CORE_MODULE_MANIFEST = [
  "apps/dev/src/core",
  "packages/shared",
] as const;

function stripDotSlash(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

function isPathAtOrUnder(file: string, manifestPath: string): boolean {
  return file === manifestPath || file.startsWith(`${manifestPath}/`);
}

/**
 * True when `file` is a root-config change that escalates to whole-workspace
 * validation. Matches root-level known config files and `.github/**` CI configs.
 * A file inside any package directory (contains at least one "/") never triggers
 * unless it is also a .github path.
 */
export function isRootTrigger(file: string): boolean {
  const clean = stripDotSlash(file);
  // GitHub Actions / CI configs — always global blast radius.
  if (clean.startsWith(".github/")) return true;
  // Root-level files only (no directory separator = sits directly at repo root).
  if (!clean.includes("/")) return ROOT_TRIGGER_FILES.has(clean);
  return false;
}

function coreModuleTriggerFile(touchedFiles: readonly string[]): string | undefined {
  for (const file of touchedFiles) {
    const clean = stripDotSlash(file);
    if (CORE_MODULE_MANIFEST.some((manifestPath) => isPathAtOrUnder(clean, manifestPath))) {
      return clean;
    }
  }
  return undefined;
}

/**
 * Pure predicate for whether a changed-file set must run the whole workspace
 * suite because it touches an explicit shared/core module manifest entry.
 */
export function scopeNeedsWholeSuite(touchedFiles: readonly string[]): boolean {
  return coreModuleTriggerFile(touchedFiles) !== undefined;
}

/**
 * Expand a set of directly touched package dirs to the full cone: the touched
 * packages plus every package that transitively depends on them (reverse-dep BFS).
 * Returns the cone sorted LC_ALL=C (byte order).
 */
function expandToCone(touchedDirs: readonly string[], graph: WorkspaceGraph): string[] {
  // Build reverse dep map: dir → list of dirs that depend on it (direct edges only;
  // BFS handles transitivity).
  const reverseDeps = new Map<string, string[]>();
  for (const pkg of graph.packages) {
    for (const dep of pkg.dependsOn) {
      let list = reverseDeps.get(dep);
      if (!list) {
        list = [];
        reverseDeps.set(dep, list);
      }
      list.push(pkg.dir);
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

/**
 * Pure function: given changed files, a package layout, and a workspace graph,
 * compute the validation scope.
 *
 * - Any root-config file in `changedFiles` → `whole-workspace` (global blast
 *   radius; must not under-validate).
 * - All other changes → `cone` (touched packages + their transitive dependents).
 * - Empty changed-file set → `cone` with empty packages (gate runs no-package
 *   skips, matching the current `relevantScopes` fallback).
 */
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

  const coreTrigger = coreModuleTriggerFile(changedFiles);
  if (coreTrigger !== undefined) {
    return { type: "whole-workspace", triggerFile: coreTrigger };
  }

  const touchedDirs = relevantScopes(layout, changedFiles);
  const coneDirs = expandToCone(touchedDirs, graph);

  return {
    type: "cone",
    packages: coneDirs,
    triggerPackages: touchedDirs,
  };
}

/**
 * Resolve the `scopes` array to pass to `runFeedback` from a computed
 * ValidationScope.
 * - `cone` → the cone package dirs (touched packages + transitive dependents).
 * - `whole-workspace` → `["."]` (root scope runs the workspace-wide turbo
 *   commands via `pnpm -C . <script>`; skips the redundant typecheck:workspace
 *   check because root already covers the whole tree).
 */
export function scopesForValidationScope(scope: ValidationScope): string[] {
  if (scope.type === "whole-workspace") return ["."];
  return scope.packages;
}

/**
 * Format a ValidationScope as a human-readable summary line for the Envelope
 * validation section — so a human reading a blocked:validation park immediately
 * sees what was tested without parsing JSONL.
 */
export function formatValidationScope(scope: ValidationScope): string {
  if (scope.type === "whole-workspace") {
    return `scope: whole-workspace (trigger: \`${scope.triggerFile}\`)`;
  }
  if (scope.packages.length === 0) {
    return `scope: cone [] (no package found for changed files)`;
  }
  const pkgs = scope.packages.map((p) => `\`${p}\``).join(", ");
  const triggers = scope.triggerPackages.map((p) => `\`${p}\``).join(", ");
  const extra =
    scope.triggerPackages.length < scope.packages.length
      ? ` — expanded from ${triggers}`
      : "";
  return `scope: cone [${pkgs}]${extra}`;
}
