// version-train-guard — one product version across every workspace, and every
// publishable surface reporting it (issue #3082).
//
// The defect this exists for is not a wrong number, it is an ABSENT LIST. The
// former changesets fixed/ignore lists left packages behind, so the herdr plugin
// drifted entirely on its own and the VS Code extension shipped every
// release stamped `0.1.0` — the field the marketplace reads. Nothing was red.
//
// So the discovery here is DERIVED, never hand-kept: the package set comes from
// the pnpm workspace globs plus the declared extra roots, which means a new app
// inherits the obligation the moment its package.json lands. A hand-kept array
// is exactly the artifact that let the herdr plugin drift.
//
// Three properties are enforced:
//
//   1. Version — every discovered manifest carries the anchor's version.
//   2. Coverage — every manifest is a confirmed Release standard Version
//      surface. Aligned-by-luck is not aligned.
//   3. Scope — every workspace is named `@reddb-io/*`, unless it carries a
//      stated exemption.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/** One discovered workspace manifest. */
export interface WorkspaceManifest {
  /** Repo-relative path of the package.json, POSIX-separated. */
  readonly relativePath: string;
  readonly name: string;
  readonly version: string;
  readonly isPrivate: boolean;
}

/**
 * The root manifest the Release standard reads as the current product version.
 */
export const VERSION_ANCHOR: string = "package.json";

/**
 * Package roots swept in addition to the pnpm workspace globs, each with the
 * reason it is not simply a workspace member.
 *
 * These are NOT an escape hatch for the derivation — they are globs too, so a
 * new plugin inherits the obligation the same way a new app does.
 */
export const EXTRA_VERSION_ROOTS: readonly { readonly glob: string; readonly why: string }[] = [
  {
    glob: "plugins/*",
    why: "plugin definitions ship as Pi packages, not as pnpm workspace members, so the Release standard declares their package manifests as extra Version surfaces",
  },
];

/**
 * The packages allowed to carry a name outside the `@reddb-io/*` scope, each
 * with the reason the scope cannot be spelled literally there.
 *
 * A private package may opt out; a PUBLISHED one may not, because the scope is
 * the ownership claim npm actually enforces.
 */
export const SCOPE_EXEMPTIONS: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: "red-skills",
    why: "the pnpm workspace root is private and unscoped by convention, and `@reddb-io/red-skills` is already apps/opencode-host — the package the docs invoke as `npx -y -p @reddb-io/red-skills@<version>`",
  },
  {
    name: "vscode-extension-red-skills",
    why: "vsce requires `name` to match ^[a-z0-9][a-z0-9-]*$, so a literal scope fails `vsce package`; the marketplace identifier is `${publisher}.${name}` and its publisher IS `reddb-io`, which is the ownership claim in VS Code's namespace",
  },
];

/** A manifest whose version is not the anchor's. */
export interface VersionDrift {
  readonly relativePath: string;
  readonly name: string;
  readonly version: string;
}

/** A manifest no release train writes. */
export interface CoverageGap {
  readonly relativePath: string;
  readonly name: string;
}

/** A manifest named outside the `@reddb-io/*` scope with no stated exemption. */
export interface ScopeViolation {
  readonly relativePath: string;
  readonly name: string;
}

/** The Release standard's confirmed Version surfaces. */
export interface TrainCoverage {
  readonly versionSurfaces: readonly string[];
}

/**
 * The `packages:` globs declared in pnpm-workspace.yaml.
 *
 * Hand-parsed rather than pulled through a YAML dependency: the block is a flat
 * list of quoted globs, and the alternative is a runtime dependency in a module
 * whose entire job is to have no opinions of its own. A missing or empty block
 * THROWS — silently sweeping nothing would make this guard green on a repo it
 * never looked at.
 */
export function readWorkspaceGlobs(repoRoot: string): string[] {
  const text = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item) {
      globs.push(item[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (line.trim() !== "") break; // the block ended at the next top-level key
  }
  if (globs.length === 0) throw new Error("pnpm-workspace.yaml declares no `packages:` globs");
  return globs;
}

/** Read one package.json into a manifest, or `undefined` when there is none. */
function readManifest(repoRoot: string, relativeDir: string): WorkspaceManifest | undefined {
  const relativePath = relativeDir === "." ? "package.json" : `${relativeDir}/package.json`;
  const absolute = join(repoRoot, relativePath);
  if (!existsSync(absolute)) return undefined;
  // package.json is ecosystem JSON — the format npm, pnpm and every host own.
  const parsed = JSON.parse(readFileSync(absolute, "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
  };
  return {
    relativePath,
    name: parsed.name ?? "",
    version: parsed.version ?? "",
    isPrivate: parsed.private === true,
  };
}

/** Expand one `dir/*` or literal glob into the manifests it names. */
function expandGlob(repoRoot: string, glob: string): WorkspaceManifest[] {
  if (!glob.endsWith("/*")) {
    const manifest = readManifest(repoRoot, glob.replace(/\/$/, ""));
    return manifest ? [manifest] : [];
  }
  const parent = glob.slice(0, -2);
  const absoluteParent = join(repoRoot, parent);
  if (!existsSync(absoluteParent)) return [];
  const out: WorkspaceManifest[] = [];
  for (const entry of readdirSync(absoluteParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const manifest = readManifest(repoRoot, `${parent}/${entry.name}`);
    if (manifest) out.push(manifest);
  }
  return out;
}

/**
 * Every manifest on the version train: the workspace root, the pnpm globs, and
 * the declared extra roots — sorted by path so a failure reads the same twice.
 */
export function collectWorkspaceManifests(
  repoRoot: string,
  globs: readonly string[] = [],
): WorkspaceManifest[] {
  const resolved = globs.length > 0
    ? globs
    : [...readWorkspaceGlobs(repoRoot), ...EXTRA_VERSION_ROOTS.map((root) => root.glob)];
  const byPath = new Map<string, WorkspaceManifest>();
  const root = readManifest(repoRoot, ".");
  if (root) byPath.set(root.relativePath, root);
  for (const glob of resolved) {
    for (const manifest of expandGlob(repoRoot, glob)) byPath.set(manifest.relativePath, manifest);
  }
  return [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** The product version every manifest must carry. PURE-ish: one file read. */
export function readAnchorVersion(repoRoot: string): string {
  const anchorDirectory = VERSION_ANCHOR === "package.json"
    ? "."
    : VERSION_ANCHOR.replace(/\/package\.json$/, "");
  const anchor = readManifest(repoRoot, anchorDirectory);
  if (!anchor || !anchor.version) throw new Error(`no version in the anchor ${VERSION_ANCHOR}`);
  return anchor.version;
}

/** Manifests whose version is not the anchor's. PURE. */
export function findVersionDrift(
  manifests: readonly WorkspaceManifest[],
  anchorVersion: string,
): VersionDrift[] {
  return manifests
    .filter((manifest) => manifest.version !== anchorVersion)
    .map(({ relativePath, name, version }) => ({ relativePath, name, version }));
}

/**
 * Manifests no release train writes. PURE.
 *
 * A package is covered only when its manifest is explicitly confirmed under
 * `release.version_surfaces`; this is the contract the engine writes.
 */
export function findCoverageGaps(
  manifests: readonly WorkspaceManifest[],
  coverage: TrainCoverage,
): CoverageGap[] {
  const written = new Set(coverage.versionSurfaces);
  return manifests
    .filter((manifest) => !written.has(manifest.relativePath))
    .map(({ relativePath, name }) => ({ relativePath, name }));
}

/** Manifests named outside `@reddb-io/*` with no stated exemption. PURE. */
export function findScopeViolations(
  manifests: readonly WorkspaceManifest[],
  exemptions: readonly { readonly name: string; readonly why: string }[] = SCOPE_EXEMPTIONS,
): ScopeViolation[] {
  const exempt = new Set(exemptions.map((exemption) => exemption.name));
  return manifests
    .filter((manifest) => !manifest.name.startsWith("@reddb-io/") && !exempt.has(manifest.name))
    .map(({ relativePath, name }) => ({ relativePath, name }));
}

/** Read the Version surfaces from the same Release standard config the engine owns. */
export function readReleaseCoverage(repoRoot: string): TrainCoverage {
  const document = yaml.load(readFileSync(join(repoRoot, ".red", "config.yaml"), "utf8"));
  if (!isRecord(document) || !isRecord(document.release) ||
      !Array.isArray(document.release.version_surfaces)) {
    throw new Error(".red/config.yaml declares no release.version_surfaces");
  }
  const versionSurfaces = document.release.version_surfaces.map((surface, index) => {
    if (!isRecord(surface) || typeof surface.path !== "string" || surface.path.trim() === "") {
      throw new Error(`release.version_surfaces[${index}] has no path`);
    }
    return surface.path;
  });
  return { versionSurfaces };
}

/** A human-readable report of everything that is off the train. PURE. */
export function describeVersionTrainFailures(
  anchorVersion: string,
  drift: readonly VersionDrift[],
  gaps: readonly CoverageGap[],
  scope: readonly ScopeViolation[],
): string {
  const lines: string[] = [];
  if (drift.length > 0) {
    lines.push(`${drift.length} manifest(s) are not at the product version ${anchorVersion}:`);
    for (const item of drift) lines.push(`  ${item.relativePath} — ${item.name || "(unnamed)"} is at ${item.version}`);
    lines.push("  run the Release standard writer and review release.version_surfaces");
  }
  if (gaps.length > 0) {
    lines.push(`${gaps.length} manifest(s) ride no release train:`);
    for (const item of gaps) lines.push(`  ${item.relativePath} — ${item.name || "(unnamed)"}`);
    lines.push("  add its manifest to release.version_surfaces in .red/config.yaml");
  }
  if (scope.length > 0) {
    lines.push(`${scope.length} workspace(s) are named outside the @reddb-io scope:`);
    for (const item of scope) lines.push(`  ${item.relativePath} — ${item.name || "(unnamed)"}`);
    lines.push("  rename it under @reddb-io/, or state the exemption in SCOPE_EXEMPTIONS with the reason the scope cannot be spelled there");
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
