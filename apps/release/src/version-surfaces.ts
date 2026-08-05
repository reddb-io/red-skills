import {
  existsSync,
  globSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { VersionScheme } from "./version-core.js";

export type ReleaseTrigger = "version-pr" | "auto";
export type VersionSurfaceFormat = "npm" | "cargo" | "text";

export interface DeclaredVersionSurface {
  readonly path: string;
  readonly format: VersionSurfaceFormat;
}

export interface ReleaseConfig {
  readonly scheme: VersionScheme;
  readonly trigger: ReleaseTrigger;
  readonly prerelease: boolean;
  readonly versionSurfaces: readonly DeclaredVersionSurface[];
  readonly syncCommand?: string;
}

export interface ReleaseConfigReadOptions {
  readonly warn?: (message: string) => void;
}

export interface WriteVersionSurfacesInput {
  readonly repoRoot: string;
  readonly nextVersion: string;
}

export interface WriteVersionSurfacesResult {
  readonly version: string;
  readonly written: readonly string[];
  readonly syncCommandRan: boolean;
}

interface DerivedVersionSurface extends DeclaredVersionSurface {
  readonly packageName: string;
}

/**
 * Release config tombstones follow ADR 0117: unknown keys stay silent for
 * forward compatibility, while every key retired in the future must be added
 * here so stale config becomes loud. The first release has no retired keys.
 */
export const DELETED_RELEASE_CONFIG_KEYS: ReadonlySet<string> = new Set();

/** Read and validate the release contract confirmed by `/red-setup`. */
export function readReleaseConfig(
  repoRoot: string,
  options: ReleaseConfigReadOptions = {},
): ReleaseConfig {
  const configPath = join(resolve(repoRoot), ".red", "config.yaml");
  let document: unknown;
  try {
    document = parse(readFileSync(configPath, "utf8"), { uniqueKeys: true });
  } catch (error) {
    throw new Error(`cannot read release config from .red/config.yaml: ${errorMessage(error)}`);
  }
  if (!isRecord(document)) throw configError("root must be a mapping");

  for (const key of flattenedKeys(document)) {
    if (!configKeyIsRetired(key)) continue;
    options.warn?.(
      `[release:config] warn: \`${key}\` is a RETIRED key — it no longer does anything; remove it from .red/config.yaml`,
    );
  }

  const release = document.release;
  if (!isRecord(release)) throw configError("release must be a mapping");
  const scheme = release.scheme;
  if (scheme !== "semver" && scheme !== "calver") {
    throw configError("release.scheme must be semver or calver");
  }
  const trigger = release.trigger;
  if (trigger !== "version-pr" && trigger !== "auto") {
    throw configError("release.trigger must be version-pr or auto");
  }
  const prerelease = release.prerelease ?? false;
  if (typeof prerelease !== "boolean") {
    throw configError("release.prerelease must be true or false");
  }
  const rawSurfaces = release.version_surfaces;
  if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
    throw configError("release.version_surfaces must be a non-empty sequence");
  }

  const seen = new Set<string>();
  const versionSurfaces = rawSurfaces.map((surface, index): DeclaredVersionSurface => {
    if (!isRecord(surface)) {
      throw configError(`release.version_surfaces[${index}] must be a mapping`);
    }
    const path = normalizedRelativePath(surface.path, `release.version_surfaces[${index}].path`);
    const format = surface.format;
    if (format !== "npm" && format !== "cargo" && format !== "text") {
      throw configError(
        `release.version_surfaces[${index}].format must be npm, cargo, or text`,
      );
    }
    if (seen.has(path)) throw configError(`release.version_surfaces repeats ${path}`);
    seen.add(path);
    return { path, format };
  });

  const syncCommand = release.sync_command;
  if (syncCommand !== undefined && (typeof syncCommand !== "string" || syncCommand.trim() === "")) {
    throw configError("release.sync_command must be a non-empty string");
  }
  return {
    scheme,
    trigger,
    prerelease,
    versionSurfaces,
    ...(typeof syncCommand === "string" ? { syncCommand } : {}),
  };
}

/**
 * Re-derive the real workspace, refuse contract drift, then write one product
 * version to every confirmed surface and invoke the optional repo-owned sync.
 */
export function writeVersionSurfaces(
  input: WriteVersionSurfacesInput,
): WriteVersionSurfacesResult {
  const repoRoot = resolve(input.repoRoot);
  const config = readReleaseConfig(repoRoot);
  const derived = deriveWorkspaceVersionSurfaces(repoRoot);
  assertNoWorkspaceDrift(config.versionSurfaces, derived);

  const pendingWrites = [...config.versionSurfaces]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map((surface) => ({
      ...surface,
      source: renderVersionSurface(repoRoot, surface, input.nextVersion),
    }));

  for (const pending of pendingWrites) {
    writeFileSync(join(repoRoot, pending.path), pending.source);
  }
  if (config.syncCommand !== undefined) {
    runSyncCommand(repoRoot, config.syncCommand, input.nextVersion);
  }
  return {
    version: input.nextVersion,
    written: pendingWrites.map((surface) => surface.path),
    syncCommandRan: config.syncCommand !== undefined,
  };
}

export function deriveWorkspaceVersionSurfaces(repoRoot: string): readonly DerivedVersionSurface[] {
  const root = resolve(repoRoot);
  const surfaces = [
    ...deriveNpmVersionSurfaces(root),
    ...deriveCargoVersionSurfaces(root),
  ];
  return surfaces.sort((left, right) => comparePaths(left.path, right.path));
}

function deriveNpmVersionSurfaces(repoRoot: string): DerivedVersionSurface[] {
  const rootManifestPath = join(repoRoot, "package.json");
  if (!existsSync(rootManifestPath)) return [];
  const rootManifest = readJsonRecord(rootManifestPath, "package.json");
  const patterns = npmWorkspacePatterns(rootManifest);
  const paths = new Set<string>(["package.json"]);
  for (const pattern of patterns) {
    for (const path of workspaceManifestPaths(repoRoot, pattern, "package.json")) paths.add(path);
  }

  const surfaces: DerivedVersionSurface[] = [];
  for (const path of [...paths].sort()) {
    const manifest = readJsonRecord(join(repoRoot, path), path);
    if (typeof manifest.version !== "string") continue;
    const packageName = typeof manifest.name === "string" && manifest.name !== ""
      ? manifest.name
      : path;
    surfaces.push({ path, format: "npm", packageName });
  }
  return surfaces;
}

function deriveCargoVersionSurfaces(repoRoot: string): DerivedVersionSurface[] {
  const rootManifestPath = join(repoRoot, "Cargo.toml");
  if (!existsSync(rootManifestPath)) return [];
  const rootSource = readFileSync(rootManifestPath, "utf8");
  const paths = new Set<string>(["Cargo.toml"]);
  for (const pattern of cargoWorkspaceMembers(rootSource)) {
    for (const path of workspaceManifestPaths(repoRoot, pattern, "Cargo.toml")) paths.add(path);
  }

  const surfaces: DerivedVersionSurface[] = [];
  for (const path of [...paths].sort()) {
    const source = path === "Cargo.toml" ? rootSource : readFileSync(join(repoRoot, path), "utf8");
    if (!cargoManifestCarriesVersion(source)) continue;
    surfaces.push({ path, format: "cargo", packageName: cargoPackageName(source) ?? path });
  }
  return surfaces;
}

function assertNoWorkspaceDrift(
  declared: readonly DeclaredVersionSurface[],
  derived: readonly DerivedVersionSurface[],
): void {
  const declaredStandard = new Map(
    declared
      .filter((surface) => surface.format === "npm" || surface.format === "cargo")
      .map((surface) => [surface.path, surface.format]),
  );
  for (const surface of derived) {
    if (declaredStandard.get(surface.path) === surface.format) continue;
    throw new Error(
      `version surface drift: orphan package ${surface.packageName} (${surface.path}) is absent from release.version_surfaces`,
    );
  }
}

function renderVersionSurface(
  repoRoot: string,
  surface: DeclaredVersionSurface,
  nextVersion: string,
): string {
  const absolutePath = join(repoRoot, surface.path);
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`cannot read version surface ${surface.path}: ${errorMessage(error)}`);
  }
  if (surface.format === "text") return `${nextVersion}\n`;
  if (surface.format === "npm") return renderNpmManifest(surface.path, source, nextVersion);
  return renderCargoManifest(surface.path, source, nextVersion);
}

function renderNpmManifest(path: string, source: string, nextVersion: string): string {
  let manifest: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) throw new Error("manifest must be an object");
    manifest = value;
  } catch (error) {
    throw new Error(`cannot parse npm version surface ${path}: ${errorMessage(error)}`);
  }
  if (typeof manifest.version !== "string") {
    throw new Error(`npm version surface ${path} has no string version`);
  }
  manifest.version = nextVersion;
  const indentation = /^([\t ]+)"/m.exec(source)?.[1] ?? "  ";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(manifest, null, indentation).replaceAll("\n", newline)}${newline}`;
}

function renderCargoManifest(path: string, source: string, nextVersion: string): string {
  let changed = false;
  const rendered = replaceCargoSectionVersion(source, "package", nextVersion, () => {
    changed = true;
  });
  const withWorkspace = replaceCargoSectionVersion(
    rendered,
    "workspace.package",
    nextVersion,
    () => { changed = true; },
  );
  if (!changed) throw new Error(`Cargo version surface ${path} has no string version`);
  return withWorkspace;
}

function replaceCargoSectionVersion(
  source: string,
  section: string,
  nextVersion: string,
  onChange: () => void,
): string {
  const bounds = cargoSectionBounds(source, section);
  if (bounds === undefined) return source;
  const body = source.slice(bounds.start, bounds.end);
  const replaced = body.replace(
    /^(\s*version\s*=\s*)(["'])([^"'\r\n]+)\2/m,
    (_match, prefix: string, quote: string) => {
      onChange();
      return `${prefix}${quote}${nextVersion}${quote}`;
    },
  );
  return `${source.slice(0, bounds.start)}${replaced}${source.slice(bounds.end)}`;
}

function runSyncCommand(repoRoot: string, command: string, nextVersion: string): void {
  const result = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, RED_RELEASE_VERSION: nextVersion },
  });
  if (result.error !== undefined) {
    throw new Error(`release sync command failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`;
    throw new Error(`release sync command failed: ${detail}`);
  }
}

function npmWorkspacePatterns(manifest: Record<string, unknown>): readonly string[] {
  const workspaces = manifest.workspaces;
  if (isStringArray(workspaces)) return workspaces;
  if (isRecord(workspaces) && isStringArray(workspaces.packages)) return workspaces.packages;
  return [];
}

function cargoWorkspaceMembers(source: string): readonly string[] {
  const bounds = cargoSectionBounds(source, "workspace");
  if (bounds === undefined) return [];
  const body = source.slice(bounds.start, bounds.end);
  const match = /(?:^|\n)\s*members\s*=\s*\[([\s\S]*?)\]/m.exec(body);
  if (match === null) return [];
  const members: string[] = [];
  for (const item of match[1]!.matchAll(/["']([^"']+)["']/g)) members.push(item[1]!);
  return members;
}

function workspaceManifestPaths(
  repoRoot: string,
  pattern: string,
  manifest: "package.json" | "Cargo.toml",
): readonly string[] {
  if (pattern.startsWith("!")) return [];
  const normalized = pattern.replaceAll("\\", "/").replace(/\/$/, "");
  return globSync(`${normalized}/${manifest}`, {
    cwd: repoRoot,
    exclude: ["**/node_modules/**", "**/target/**"],
  }).map((path) => path.replaceAll(sep, "/"));
}

function cargoManifestCarriesVersion(source: string): boolean {
  return cargoSectionHasStringVersion(source, "package") ||
    cargoSectionHasStringVersion(source, "workspace.package");
}

function cargoSectionHasStringVersion(source: string, section: string): boolean {
  const bounds = cargoSectionBounds(source, section);
  if (bounds === undefined) return false;
  return /^\s*version\s*=\s*["'][^"'\r\n]+["']/m.test(source.slice(bounds.start, bounds.end));
}

function cargoPackageName(source: string): string | undefined {
  const bounds = cargoSectionBounds(source, "package");
  if (bounds === undefined) return undefined;
  return /^\s*name\s*=\s*["']([^"'\r\n]+)["']/m.exec(
    source.slice(bounds.start, bounds.end),
  )?.[1];
}

function cargoSectionBounds(
  source: string,
  section: string,
): { readonly start: number; readonly end: number } | undefined {
  const header = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*(?:#.*)?$`, "m").exec(source);
  if (header === null || header.index === undefined) return undefined;
  const start = header.index + header[0].length;
  const nextHeader = /^\s*\[[^\]]+\]\s*(?:#.*)?$/m.exec(source.slice(start));
  return { start, end: nextHeader === null ? source.length : start + nextHeader.index };
}

function readJsonRecord(path: string, displayPath: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) throw new Error("manifest must be an object");
    return value;
  } catch (error) {
    throw new Error(`cannot parse workspace manifest ${displayPath}: ${errorMessage(error)}`);
  }
}

function normalizedRelativePath(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${key} must be a non-empty string`);
  }
  if (isAbsolute(value)) throw configError(`${key} must be relative to the repository`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const resolved = resolve("/repo", normalized);
  if (relative("/repo", resolved).startsWith("..")) {
    throw configError(`${key} must stay inside the repository`);
  }
  return normalized;
}

function flattenedKeys(value: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [name, child] of Object.entries(value)) {
    const key = prefix === "" ? name : `${prefix}.${name}`;
    keys.push(key);
    if (isRecord(child)) keys.push(...flattenedKeys(child, key));
  }
  return keys;
}

function configKeyIsRetired(key: string): boolean {
  if (DELETED_RELEASE_CONFIG_KEYS.has(key)) return true;
  for (const deleted of DELETED_RELEASE_CONFIG_KEYS) {
    if (key.startsWith(`${deleted}.`)) return true;
  }
  return false;
}

function configError(message: string): Error {
  return new Error(`invalid release config: ${message}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
