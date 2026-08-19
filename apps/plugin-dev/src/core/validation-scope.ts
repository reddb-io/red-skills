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
//
// Every changed path is classified explicitly (#2984). Mapping a path to its
// *nearest* package was not enough: a file outside every package — `.changeset/*.md`
// above all — walked up to the root package and returned scope ".", whose `test`
// script is the whole workspace. Since a changeset is mandatory on every slice,
// the cone was computed correctly and then made irrelevant, and each gate run
// degenerated to `pnpm -C <worktree> test`. The classification here is the same
// taxonomy CI already uses (`scripts/ci-affected-scope.mjs`), kept in lockstep by
// `apps/plugin-dev/tests/validation-scope.test.ts`'s parity table — one taxonomy, two
// consumers, never a third.

import { nearestPackageScope, type PackageLayout } from "./feedback.js";

/** A workspace package: its repo-relative dir and the dirs it directly depends on. */
export interface WorkspacePackage {
  /** Repo-relative directory, e.g. "apps/plugin-dev" or "packages/shared". Never ".". */
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

/** Content evidence for root files whose path alone cannot prove blast radius. */
export interface ValidationScopeContentEvidence {
  /** The two endpoints of the `base...branch` diff for the root manifest. */
  rootPackageJson?: {
    before: string;
    after: string;
  };
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
 * Doc lanes that no suite reads — a change here contributes no scope at all.
 * Keep this list short and provable: an entry is a promise that no test asserts
 * the file's content. `.changeset/` is the entry that matters most, because a
 * changeset is mandatory on every slice.
 */
const INERT_PREFIXES = [".changeset/", ".red/tmp/", ".red/researches/"];

/**
 * Packages whose suites assert the content of the repo's doc lanes (the
 * `*-docs.test.ts` contracts, ADR governance, the skill/manifest audits). A docs
 * change runs these packages' tests and nothing else — it affects no type.
 * A repo whose layout declares none of them escalates to whole-workspace rather
 * than under-validating.
 */
const DOC_CONTRACT_PACKAGES = ["apps/plugin-dev"];

/** Doc lanes whose content the doc-contract packages assert. */
const DOC_PREFIXES = [".red/"];

/**
 * Doc lanes that are ALSO inputs to generated artifacts (Codex/Gemini/Pi
 * manifests, Pi package payloads). Same owners as the doc lanes on the gate
 * side — CI additionally re-runs its manifest checks, which the gate does not have.
 */
const MANIFEST_INPUT_PREFIXES = ["plugins/", ".claude-plugin/", ".agents/", "packaging/pi/"];

/** Root-level docs the suite reads (README/CLAUDE/CHANGES are asserted). */
const ROOT_DOC_FILES = new Set(["README.md", "CLAUDE.md", "NOTICE", "LICENSE"]);

/**
 * The verdict for one changed path.
 * - `whole` — global blast radius, or unclassifiable. Runs the whole workspace,
 *   because a wrongly-skipped test costs far more than a needlessly-run one.
 * - `inert` — no suite reads it; contributes no scope.
 * - `scoped` — contributes the named packages to the cone's trigger set.
 */
export type PathClass =
  | { kind: "whole" }
  | { kind: "inert" }
  | { kind: "scoped"; packages: string[] };

function stripDotSlash(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]),
    )
  );
}

/**
 * Prove that two package manifests differ only in their top-level `version`.
 * Parse failures, missing/non-string versions, and an unchanged version all
 * fail closed: path-only evidence must retain whole-workspace validation.
 */
export function isVersionOnlyPackageJsonChange(before: string, after: string): boolean {
  try {
    const left: unknown = JSON.parse(before);
    const right: unknown = JSON.parse(after);
    if (!isJsonObject(left) || !isJsonObject(right)) return false;
    if (typeof left.version !== "string" || typeof right.version !== "string") return false;
    if (left.version === right.version) return false;
    const { version: _leftVersion, ...leftWithoutVersion } = left;
    const { version: _rightVersion, ...rightWithoutVersion } = right;
    return jsonValuesEqual(leftWithoutVersion, rightWithoutVersion);
  } catch {
    return false;
  }
}

/** The doc-contract owners this layout actually declares. */
function docContractPackages(layout: PackageLayout): string[] {
  return DOC_CONTRACT_PACKAGES.filter((dir) => layout.hasPackage(dir));
}

/**
 * Classify one changed path against the shared taxonomy. Pure: `layout` is only
 * consulted to resolve a path's owning package (and to confirm a doc-contract
 * owner exists), never to read the filesystem.
 *
 * Order matters — `.red/adr/` is checked before the inert prefixes so an ADR is
 * never mistaken for disposable `.red/` scratch, and `.red/config.yaml` is
 * checked before the docs discount because it is configuration the runtimes
 * read, not prose.
 */
export function classifyChangedPath(file: string, layout: PackageLayout): PathClass {
  const clean = stripDotSlash(file);
  const docOwners = docContractPackages(layout);
  // A docs change with no owner package in this layout cannot be narrowed
  // honestly — run everything rather than validate nothing.
  const docScoped = (): PathClass =>
    docOwners.length > 0 ? { kind: "scoped", packages: docOwners } : { kind: "whole" };

  // Known root-config files and `.github/**` — global blast radius, checked
  // first so nothing below can discount them.
  if (isRootTrigger(clean)) return { kind: "whole" };

  if (clean.startsWith(".red/adr/")) return docScoped();
  if (INERT_PREFIXES.some((p) => clean.startsWith(p))) return { kind: "inert" };
  if (MANIFEST_INPUT_PREFIXES.some((p) => clean.startsWith(p))) return docScoped();
  if (DOC_PREFIXES.some((p) => clean.startsWith(p))) {
    if (clean === ".red/config.yaml") return { kind: "whole" };
    return docScoped();
  }

  if (!clean.includes("/")) {
    if (ROOT_DOC_FILES.has(clean)) return docScoped();
    // Every other root file (package.json, lockfile, turbo.json, tsconfig, …)
    // has global blast radius.
    return { kind: "whole" };
  }

  const dir = nearestPackageScope(layout, clean);
  if (dir !== undefined && dir !== ".") return { kind: "scoped", packages: [dir] };

  // scripts/**, .github/**, dist/**, anything unrecognised: unclassifiable.
  return { kind: "whole" };
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
  void touchedFiles;
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
 * compute the validation scope. Every path is classified by
 * {@link classifyChangedPath}; the first `whole` verdict wins outright.
 *
 * - Any root-config or unclassifiable file → `whole-workspace` (global blast
 *   radius; must not under-validate).
 * - `inert` files (`.changeset/**` above all) contribute NO scope, so the
 *   mandatory changeset never drags the root package into the cone (#2984).
 * - All other changes → `cone` (touched packages + their transitive dependents).
 * - Empty changed-file set → `cone` with empty packages (gate runs no-package
 *   skips; the caller already terminal-fails a no-diff branch before this).
 */
export function computeValidationScope(
  changedFiles: readonly string[],
  layout: PackageLayout,
  graph: WorkspaceGraph,
  contentEvidence: ValidationScopeContentEvidence = {},
): ValidationScope {
  const coreTrigger = coreModuleTriggerFile(changedFiles);
  if (coreTrigger !== undefined) {
    return { type: "whole-workspace", triggerFile: coreTrigger };
  }

  const touched = new Set<string>();
  const versionOnlyRootManifest =
    contentEvidence.rootPackageJson !== undefined &&
    isVersionOnlyPackageJsonChange(
      contentEvidence.rootPackageJson.before,
      contentEvidence.rootPackageJson.after,
    );
  for (const raw of changedFiles) {
    if (raw === "") continue;
    const file = stripDotSlash(raw);
    // `package.json` remains a root trigger by default. It is discounted only
    // when the diff endpoints prove that the top-level version is the sole
    // semantic change; any missing or mixed evidence falls through to `whole`.
    if (file === "package.json" && versionOnlyRootManifest) continue;
    const verdict = classifyChangedPath(file, layout);
    if (verdict.kind === "whole") return { type: "whole-workspace", triggerFile: file };
    if (verdict.kind === "inert") continue;
    for (const pkg of verdict.packages) touched.add(pkg);
  }

  const touchedDirs = [...touched].sort();
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
 * The classified scope list for a gate path that has no workspace graph to
 * expand a cone with — `gate_run` and reconcile's pre-land / post-merge gates.
 * Same taxonomy as {@link computeValidationScope}, so the mandatory changeset
 * does not drag the root package (and with it the whole-workspace suite) into
 * these gates either (#2984). Prefer `computeValidationScope` wherever a graph
 * IS available: this resolves the trigger packages only, never their dependents.
 */
export function gateScopes(
  layout: PackageLayout,
  changedFiles: readonly string[],
  contentEvidence: ValidationScopeContentEvidence = {},
): string[] {
  return scopesForValidationScope(
    computeValidationScope(changedFiles, layout, { packages: [] }, contentEvidence),
  );
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
