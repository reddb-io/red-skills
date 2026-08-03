/**
 * bundle-fetch.ts — pure-with-injected-IO resolver for per-plugin built bundles,
 * distributed over **npm** (ADR 0091, v2 transport cutover).
 *
 * ADR 0034 originally shipped every plugin bundle as a GitHub Release asset,
 * fetched into a version-keyed cache and verified with a hand-rolled Sigstore
 * signature over a checksum manifest. That channel broke: `cosign sign-blob`
 * emits the legacy cosign bundle format the client's `sigstore-js` verify() no
 * longer accepts ("invalid bundle"), and the self-update lane polled a
 * `releases/download/v1/` release that never existed (eternal 404). There was no
 * working installed base to preserve, so ADR 0091 **deletes** that channel: the
 * bundles now ship inside a single npm package `@reddb-io/red-skills`, resolved
 * at the exact pinned version via npm's own cache and shasum/provenance
 * integrity. No GitHub-release download, no client-side signature verification.
 *
 * This module holds ZERO real IO: every side effect (npm materialisation, file
 * read/write, existence check, registry query) is injected via {@link BundleIO}.
 * The launcher (`entrypoint-cli.ts`) wires these to node built-ins (`npm`,
 * `node:fs`, `fetch`); the test wires them to in-memory fakes. That keeps
 * resolution deterministic and unit-testable with no real network.
 */

import { type ReleaseChannel } from "./channel.js";

/** The single npm package that carries every plugin's built bundle. */
export const NPM_PACKAGE = "@reddb-io/red-skills";

/** Public npm registry base (self-update version discovery reads from here). */
export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

/** The npm dist-tag the `canary` channel tracks (replaces the floating GH tag). */
export const CANARY_DIST_TAG = "canary";

export interface ResolveBundleInput {
  plugin: string;
  version: string;
  cacheDir: string;
  /** Release channel; absent = `stable` (version-pinned). */
  channel?: ReleaseChannel;
  /** Unused by resolve; kept for signature compatibility with callers. */
  repo?: string;
}

export interface EnsureBundleInput {
  plugin: string;
  version: string;
  /** `owner/name` GitHub repo — retained for call-site compatibility; unused. */
  repo?: string;
  cacheDir: string;
  /** Release channel; absent = `stable` (version-pinned). */
  channel?: ReleaseChannel;
}

/**
 * Injected IO surface. All async (except `sha256`); all errors surface as a
 * typed {@link BundleFetchError}. There is deliberately NO signature-verify hook
 * and NO raw-URL download hook: integrity is npm's shasum/provenance, and the
 * only network access is a read-only registry query for self-update discovery.
 */
export interface BundleIO {
  /**
   * Materialise the npm package `spec` (`@reddb-io/red-skills@<pin>`) into
   * `stagingDir` using npm's own cache, and return the installed package root
   * directory (the folder that contains `dist/<plugin>.bundle.min.mjs`). Honours
   * npm's local cache-first behaviour, so a warm cache does no network IO.
   */
  materialize(spec: string, stagingDir: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  sha256(bytes: Uint8Array): string;
  /** Read-only registry GET (self-update version discovery only). */
  fetchText(url: string): Promise<string>;
}

export type BundleFetchFailure =
  | "npm-unavailable"
  | "package-missing"
  | "bundle-missing"
  | "network";

/** Typed, diagnosable failure — never a bare throw. */
export class BundleFetchError extends Error {
  readonly kind: BundleFetchFailure;
  readonly cause?: unknown;
  constructor(kind: BundleFetchFailure, message: string, cause?: unknown) {
    super(message);
    this.name = "BundleFetchError";
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Canonical cache filename for a plugin bundle.
 *
 * `stable` (or no channel) keys by version (`<plugin>-<version>.bundle.min.mjs`).
 * `canary` keys by the channel literal (`<plugin>-canary.bundle.min.mjs`) since
 * the dist-tag floats; {@link ensureBundle} refreshes that cache entry on every
 * canary resolution so the file follows npm's current dist-tag pointer.
 */
export function bundleFileName(
  plugin: string,
  version: string,
  channel: ReleaseChannel = "stable",
): string {
  const key = channel === "canary" ? "canary" : version;
  return `${plugin}-${key}.bundle.min.mjs`;
}

/** The local cache path a bundle resolves to (no IO). */
export function resolveBundle(input: ResolveBundleInput): string {
  const { plugin, version, cacheDir, channel } = input;
  return joinPath(cacheDir, bundleFileName(plugin, version, channel));
}

/**
 * Bundles that ship under another plugin's warm path.
 *
 * **A companion is a bundle nothing asks for by name.** `red-fetch.mjs <plugin>
 * <version>` is invoked for `dev` and `code-nav` only, so any other bundle a
 * host resolves from the shared cache must be warmed by the plugin it ships
 * beside or it never lands there at all.
 *
 * `rsp` is part of the dev plugin surface: the PATH shim and shell hooks resolve
 * it from the shared bundle cache, but no SessionStart hook invokes
 * `red-fetch.mjs rsp <version>` directly.
 *
 * `redskilled` is the same shape and the failure was worse (#3074). The
 * documented Claude Code `statusLine` globs
 * `~/.cache/red-skills/bundles/redskilled*.bundle.min.mjs` for the daemon that
 * renders the Worker rows (ADR 0130 rule 10), and the render path is
 * cached-first by contract — it must do no network and no resolution work (ADR
 * 0084). Nothing wrote that file: the only copy on a host provisioned through
 * `npx` lived inside the npx cache, so the glob resolved nothing, the daemon was
 * never contacted, and the operator read a blank region as "no Workers". Warming
 * `dev` warms the daemon bundle from the SAME npm package materialization, so
 * the artifact the render command needs is already on disk when it looks.
 */
export function companionBundlePlugins(plugin: string): readonly string[] {
  return plugin === "dev" ? ["rsp", "redskilled"] : [];
}

/** Bundle filename inside the npm package tarball's `dist/`. */
export function packagedBundleName(plugin: string): string {
  return `${plugin}.bundle.min.mjs`;
}

/** `dist/<plugin>.bundle.min.mjs` — the bundle's path inside the package root. */
export function packagedBundleRelPath(plugin: string): string {
  return joinPath("dist", packagedBundleName(plugin));
}

/**
 * The npm package spec the client resolves for a channel + version. `stable`
 * pins the exact version (`@reddb-io/red-skills@2.0.0`); `canary` follows the
 * `canary` dist-tag (`@reddb-io/red-skills@canary`). This is the ONLY thing the
 * client ever asks npm for — no release tags, no `releases/download/` URLs.
 */
export function npmPackageSpec(
  version: string,
  channel: ReleaseChannel = "stable",
): string {
  const ref = channel === "canary" ? CANARY_DIST_TAG : version;
  return `${NPM_PACKAGE}@${ref}`;
}

/** Registry metadata URL for the package (scoped name is `%2F`-escaped). */
export function registryPackageUrl(pkg: string = NPM_PACKAGE): string {
  return `${NPM_REGISTRY_BASE}/${pkg.replace("/", "%2F")}`;
}

/**
 * Ensure the bundle for `plugin@version` exists in `cacheDir`; return its local
 * path. Cache-first: a cache hit returns immediately with no npm invocation.
 *
 * Cache miss: materialise `@reddb-io/red-skills@<pin>` via npm (npm verifies the
 * tarball shasum itself), copy the packaged `dist/<plugin>.bundle.min.mjs` into
 * the cache, return it. The canary channel deliberately skips the cache hit and
 * refreshes from `@reddb-io/red-skills@canary` every time because its npm
 * dist-tag is the moving pointer. Integrity comes from npm; there is no
 * client-side signature step.
 *
 * Failure modes raise a typed {@link BundleFetchError} and never write a partial
 * bundle to the cache:
 *   - `npm-unavailable` — the npm CLI could not be invoked
 *   - `package-missing` — npm could not resolve the pinned package/version
 *   - `bundle-missing`  — the package resolved but has no bundle for `plugin`
 *   - `network`         — registry/materialisation network failure
 */
export async function ensureBundle(
  io: BundleIO,
  input: EnsureBundleInput,
): Promise<string> {
  const { plugin, version, cacheDir, channel = "stable" } = input;
  const dest = resolveBundle({ plugin, version, cacheDir, channel });
  const companionPlugins = companionBundlePlugins(plugin);
  const companionDests = companionPlugins.map((companion) =>
    resolveBundle({ plugin: companion, version, cacheDir, channel }),
  );

  // Stable is cache-first; canary is a floating npm dist-tag and must refresh.
  if (
    channel !== "canary" &&
    (await io.exists(dest)) &&
    (await allExist(io, companionDests))
  ) {
    return dest;
  }

  const spec = npmPackageSpec(version, channel);
  const stagingDir = joinPath(
    cacheDir,
    `.staging-${plugin}-${channel === "canary" ? "canary" : version}`,
  );

  let pkgRoot: string;
  try {
    pkgRoot = await io.materialize(spec, stagingDir);
  } catch (err) {
    throw classifyMaterializeError(err, spec);
  }

  for (const bundlePlugin of [plugin, ...companionPlugins]) {
    const srcRel = packagedBundleRelPath(bundlePlugin);
    const src = joinPath(pkgRoot, srcRel);
    if (!(await io.exists(src))) {
      throw new BundleFetchError("bundle-missing", `npm package ${spec} has no ${srcRel}`);
    }
    const bundleDest =
      bundlePlugin === plugin
        ? dest
        : resolveBundle({ plugin: bundlePlugin, version, cacheDir, channel });
    await io.writeFile(bundleDest, await io.readFile(src));
  }
  return dest;
}

async function allExist(io: Pick<BundleIO, "exists">, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if (!(await io.exists(path))) return false;
  }
  return true;
}

/**
 * Query the npm registry and return the newest published version whose major
 * matches `installed` (same-major, ADR 0084 compatible range), or `null`. Reads
 * the registry `versions` map — it never constructs a GitHub release URL. Used
 * by the in-range self-update layer (`self-update.ts`).
 */
export async function fetchNewestSameMajor(
  io: Pick<BundleIO, "fetchText">,
  installed: string,
  pkg: string = NPM_PACKAGE,
): Promise<string | null> {
  let text: string;
  try {
    text = await io.fetchText(registryPackageUrl(pkg));
  } catch (err) {
    throw classifyMaterializeError(err, pkg);
  }
  return newestSameMajor(parseRegistryVersions(text), installed);
}

/**
 * The two version questions one registry read answers.
 *
 * They travel together because a caller that asked twice could see a release
 * land between the reads and report a major gap that existed at no instant.
 */
export interface PublishedVersionHorizon {
  /** Newest version sharing the installed major — the only in-range candidate. */
  readonly sameMajor: string | null;
  /** Newest version published at all, across every major. */
  readonly newest: string | null;
}

/**
 * Both answers, from ONE registry read: what may be adopted in range, and what
 * exists beyond it. A consumer that must *report* a major boundary rather than
 * cross it needs the second number, and it is not derivable from the first.
 */
export async function fetchPublishedVersionHorizon(
  io: Pick<BundleIO, "fetchText">,
  installed: string,
  pkg: string = NPM_PACKAGE,
): Promise<PublishedVersionHorizon> {
  let text: string;
  try {
    text = await io.fetchText(registryPackageUrl(pkg));
  } catch (err) {
    throw classifyMaterializeError(err, pkg);
  }
  const versions = parseRegistryVersions(text);
  return { sameMajor: newestSameMajor(versions, installed), newest: newestPublished(versions) };
}

/** Parse the published-version list out of registry package metadata JSON. */
export function parseRegistryVersions(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const versions = (parsed as { versions?: unknown }).versions;
  if (typeof versions !== "object" || versions === null) return [];
  return Object.keys(versions as Record<string, unknown>);
}

/** The version a dist-tag points at in registry metadata, or undefined. */
export function registryDistTagVersion(
  text: string,
  tag: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const tags = (parsed as { "dist-tags"?: Record<string, unknown> })["dist-tags"];
  const v = tags?.[tag];
  return typeof v === "string" ? v : undefined;
}

/** Newest same-major version from a list, or null when none match. */
export function newestSameMajor(
  versions: readonly string[],
  installed: string,
): string | null {
  const target = majorOf(installed);
  if (target === null) return null;
  let best: string | null = null;
  for (const v of versions) {
    if (majorOf(v) !== target) continue;
    if (best === null || compareVersion(v, best) > 0) best = v;
  }
  return best;
}

/**
 * Newest STABLE version from a list, whatever its major, or null.
 *
 * Prereleases are skipped: they are published, but they are not a release an
 * operator is asked to move a machine onto, and announcing `4.0.0-rc.1` as the
 * major beyond a 3.x install would put a standing notice on every host for as
 * long as a release candidate exists.
 */
export function newestPublished(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    const trimmed = String(v).trim();
    if (majorOf(trimmed) === null || /^\d+\.\d+\.\d+[-+]/.test(trimmed)) continue;
    if (best === null || compareVersion(trimmed, best) > 0) best = trimmed;
  }
  return best;
}

function majorOf(version: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  return m ? Number(m[1]) : null;
}

function compareVersion(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a.trim());
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b.trim());
  if (!pa || !pb) return 0;
  return (
    Number(pa[1]) - Number(pb[1]) ||
    Number(pa[2]) - Number(pb[2]) ||
    Number(pa[3]) - Number(pb[3])
  );
}

/** Map an npm/registry error to a typed package-missing vs network failure. */
function classifyMaterializeError(err: unknown, spec: string): BundleFetchError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|command not found|spawn npm/i.test(msg)) {
    return new BundleFetchError("npm-unavailable", `npm is unavailable while resolving ${spec}: ${msg}`, err);
  }
  if (/\b404\b|E404|not found|no matching version|notarget/i.test(msg)) {
    return new BundleFetchError("package-missing", `npm could not resolve ${spec}: ${msg}`, err);
  }
  return new BundleFetchError("network", `failed to resolve ${spec}: ${msg}`, err);
}

/** Minimal POSIX-style join (cache paths only); avoids a node:path import here. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
