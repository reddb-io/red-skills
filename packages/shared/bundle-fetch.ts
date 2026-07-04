/**
 * bundle-fetch.ts — pure-with-injected-IO resolver for per-plugin built bundles.
 *
 * ADR 0034 ("Dynamic dist fetch") generalises the memory bootstrap (ADR 0029):
 * every plugin builds to a single `<plugin>.bundle.min.mjs` that ships as a
 * GitHub Release asset instead of living in the git tree. An installed plugin
 * resolves its bundle for the installed version, fetching it from the release
 * into a local cache the first time it is needed and verifying a published
 * sha256 checksum.
 *
 * This module holds ZERO real IO: every side effect (download, file read/write,
 * existence check, hashing) is injected via {@link BundleIO}. The launcher
 * (`entrypoint-cli.ts`) wires these to node built-ins (`fetch`, `node:fs`,
 * `node:crypto`); the test wires them to in-memory fakes. That keeps the fetch
 * logic deterministic and unit-testable with no real network.
 */

/** The checksum manifest published alongside each bundle on the release. */
import { type ReleaseChannel, channelReleaseRef } from "./channel.js";

export interface BundleManifest {
  plugin: string;
  version: string;
  /** hex sha256 of the `<plugin>.bundle.min.mjs` asset bytes. */
  sha256: string;
}

export interface ResolveBundleInput {
  plugin: string;
  version: string;
  cacheDir: string;
  /** Release channel; absent = `stable` (version-pinned, pre-ADR 0058). */
  channel?: ReleaseChannel;
  /** `owner/name` GitHub repo that publishes the release; unused by resolve. */
  repo?: string;
}

export interface EnsureBundleInput {
  plugin: string;
  version: string;
  /** `owner/name` GitHub repo that publishes the release. */
  repo: string;
  cacheDir: string;
  /** Release channel; absent = `stable` (version-pinned, pre-ADR 0058). */
  channel?: ReleaseChannel;
}

/** Injected IO surface. All async; all errors surface as BundleFetchError. */
export interface BundleIO {
  download(url: string): Promise<Uint8Array>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  sha256(bytes: Uint8Array): string;
  verifyBundleSignature(input: {
    artifact: Uint8Array;
    signature: Uint8Array;
    repo: string;
    ref: string;
    assetName: string;
  }): Promise<void>;
}

export type BundleFetchFailure =
  | "network"
  | "asset-missing"
  | "checksum-mismatch"
  | "manifest-invalid"
  | "signature-invalid";

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
 * `stable` (or no channel) keys by version (`<plugin>-<version>.bundle.min.mjs`)
 * — unchanged from pre-ADR 0058. `canary` keys by the channel literal
 * (`<plugin>-canary.bundle.min.mjs`) since the floating tag has no stable
 * version; checksum re-verification in {@link ensureBundle} refreshes it when
 * the canary tag moves.
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

/** GitHub release-asset URL: `…/releases/download/v<version>/<name>`. */
export function assetUrl(repo: string, version: string, name: string): string {
  return assetUrlForRef(repo, `v${version}`, name);
}

/** GitHub release-asset URL for an arbitrary release ref (tag): `…/releases/download/<ref>/<name>`. */
export function assetUrlForRef(repo: string, ref: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${ref}/${name}`;
}

/** Release asset name for a plugin's bundle. */
export function bundleAssetName(plugin: string): string {
  return `${plugin}.bundle.min.mjs`;
}

/** Release asset name for a plugin's checksum manifest. */
export function manifestAssetName(plugin: string): string {
  return `${plugin}.manifest.json`;
}

/** Release asset name for a plugin's Sigstore bundle over the checksum manifest. */
export function manifestSignatureAssetName(plugin: string): string {
  return `${manifestAssetName(plugin)}.sigstore.json`;
}

/**
 * Ensure the bundle for `plugin@version` exists in `cacheDir` and matches the
 * published sha256; return its local path.
 *
 * - Cache hit (file exists, manifest sha256 matches): no download, returns path.
 * - Cache miss (or checksum drift): download manifest + bundle from the release,
 *   verify checksum, write to cache, return path.
 *
 * Failure modes raise a typed {@link BundleFetchError} and never write a bad
 * bundle to the cache:
 *   - `network`           — manifest/bundle download failed (offline, etc.)
 *   - `asset-missing`     — release asset returned not-found
 *   - `manifest-invalid`  — manifest JSON malformed / wrong shape
 *   - `signature-invalid` — manifest signature missing or unverifiable
 *   - `checksum-mismatch` — downloaded bundle sha256 != manifest sha256
 */
export async function ensureBundle(
  io: BundleIO,
  input: EnsureBundleInput,
): Promise<string> {
  const { plugin, version, repo, cacheDir, channel = "stable" } = input;
  const dest = resolveBundle({ plugin, version, cacheDir, channel });
  const ref = channelReleaseRef(channel, version);

  const signedManifest = await fetchManifestEnvelope(io, repo, plugin, ref);
  const manifest = signedManifest.manifest;

  // Cache hit: verify against the manifest before trusting it.
  if (await io.exists(dest)) {
    try {
      const have = io.sha256(await io.readFile(dest));
      if (have === manifest.sha256.toLowerCase()) {
        await verifyManifestSignature(io, repo, ref, signedManifest);
        return dest;
      }
    } catch {
      // Unreadable cache file falls through to a re-download.
    }
  }

  // Cache miss / drift: download, verify, then write.
  const bundleName = bundleAssetName(plugin);
  let bytes: Uint8Array;
  try {
    bytes = await io.download(assetUrlForRef(repo, ref, bundleName));
  } catch (err) {
    throw classifyDownloadError(err, bundleName);
  }

  const got = io.sha256(bytes);
  if (got !== manifest.sha256.toLowerCase()) {
    throw new BundleFetchError(
      "checksum-mismatch",
      `checksum mismatch for ${bundleName}: ${got} != ${manifest.sha256}`,
    );
  }
  await verifyManifestSignature(io, repo, ref, signedManifest);

  // Only reached on a verified payload — a bad bundle is never cached.
  await io.writeFile(dest, bytes);
  return dest;
}

/**
 * Download + validate a plugin's checksum manifest from an arbitrary release
 * `ref` (a version tag `v<x>` or a floating tag). Exported so the in-range
 * self-update layer (ADR 0084, `self-update.ts`) can read the floating
 * major-line manifest that names the newest compatible version.
 */
export async function fetchManifest(
  io: BundleIO,
  repo: string,
  plugin: string,
  ref: string,
): Promise<BundleManifest> {
  const signedManifest = await fetchManifestEnvelope(io, repo, plugin, ref);
  await verifyManifestSignature(io, repo, ref, signedManifest);
  return signedManifest.manifest;
}

interface SignedManifestEnvelope {
  name: string;
  signatureName: string;
  raw: Uint8Array;
  signature: Uint8Array;
  manifest: BundleManifest;
}

async function fetchManifestEnvelope(
  io: BundleIO,
  repo: string,
  plugin: string,
  ref: string,
): Promise<SignedManifestEnvelope> {
  const name = manifestAssetName(plugin);
  const signatureName = manifestSignatureAssetName(plugin);
  let raw: Uint8Array;
  let signature: Uint8Array;
  try {
    raw = await io.download(assetUrlForRef(repo, ref, name));
  } catch (err) {
    throw classifyDownloadError(err, name);
  }
  try {
    signature = await io.download(assetUrlForRef(repo, ref, signatureName));
  } catch (err) {
    throw new BundleFetchError(
      "signature-invalid",
      `manifest signature ${signatureName} is missing or unavailable`,
      err,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (err) {
    throw new BundleFetchError("manifest-invalid", `manifest ${name} is not valid JSON`, err);
  }
  if (!isManifest(parsed)) {
    throw new BundleFetchError(
      "manifest-invalid",
      `manifest ${name} missing required fields {plugin, version, sha256}`,
    );
  }
  return {
    name,
    signatureName,
    raw,
    signature,
    manifest: { ...parsed, sha256: parsed.sha256.toLowerCase() },
  };
}

async function verifyManifestSignature(
  io: BundleIO,
  repo: string,
  ref: string,
  envelope: SignedManifestEnvelope,
): Promise<void> {
  try {
    await io.verifyBundleSignature({
      artifact: envelope.raw,
      signature: envelope.signature,
      repo,
      ref,
      assetName: envelope.name,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BundleFetchError(
      "signature-invalid",
      `manifest signature ${envelope.signatureName} failed verification: ${msg}`,
      err,
    );
  }
}

function isManifest(value: unknown): value is BundleManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.plugin === "string" &&
    typeof m.version === "string" &&
    typeof m.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(m.sha256)
  );
}

/** Map a download error to a typed asset-missing (404-ish) vs network failure. */
function classifyDownloadError(err: unknown, assetName: string): BundleFetchError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b404\b|not found|missing/i.test(msg)) {
    return new BundleFetchError("asset-missing", `release asset ${assetName} not found: ${msg}`, err);
  }
  return new BundleFetchError("network", `failed to download ${assetName}: ${msg}`, err);
}

/** Minimal POSIX-style join (cache paths only); avoids a node:path import here. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
