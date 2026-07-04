import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assetUrl,
  bundleAssetName,
  bundleFileName,
  BundleFetchError,
  type BundleIO,
  ensureBundle,
  manifestAssetName,
  manifestSignatureAssetName,
  resolveBundle,
} from "./bundle-fetch.js";

const PLUGIN = "dev";
const VERSION = "1.140.0";
const REPO = "reddb-io/red-skills";
const CACHE = "/cache/bundles";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function manifestJson(sha: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ plugin: PLUGIN, version: VERSION, sha256: sha }),
  );
}

/** In-memory IO with download tracking; no real network or disk. */
function makeIO(opts: {
  bundleBytes?: Uint8Array;
  manifestSha?: string;
  signatureBytes?: Uint8Array;
  signatureValid?: boolean;
  files?: Record<string, Uint8Array>;
  /** asset names that should 404. */
  missing?: string[];
  /** force every download to throw a network error. */
  offline?: boolean;
}) {
  const files: Record<string, Uint8Array> = { ...(opts.files ?? {}) };
  const downloads: string[] = [];
  const writes: string[] = [];
  const signatureChecks: string[] = [];

  const io: BundleIO = {
    async download(url) {
      downloads.push(url);
      if (opts.offline) throw new Error("ECONNREFUSED");
      const name = url.split("/").pop()!;
      if (opts.missing?.includes(name)) throw new Error("404 Not Found");
      if (name === manifestAssetName(PLUGIN)) {
        const sha =
          opts.manifestSha ??
          (opts.bundleBytes ? sha256(opts.bundleBytes) : "0".repeat(64));
        return manifestJson(sha);
      }
      if (name === manifestSignatureAssetName(PLUGIN)) {
        return opts.signatureBytes ?? new TextEncoder().encode("sigstore-bundle");
      }
      if (name === bundleAssetName(PLUGIN)) {
        if (!opts.bundleBytes) throw new Error("404 Not Found");
        return opts.bundleBytes;
      }
      throw new Error(`unexpected download ${url}`);
    },
    async readFile(path) {
      const f = files[path];
      if (!f) throw new Error(`ENOENT ${path}`);
      return f;
    },
    async writeFile(path, bytes) {
      writes.push(path);
      files[path] = bytes;
    },
    async exists(path) {
      return path in files;
    },
    sha256,
    async verifyBundleSignature({ artifact, signature }) {
      signatureChecks.push(`${sha256(artifact)}:${new TextDecoder().decode(signature)}`);
      if (opts.signatureValid === false) throw new Error("signature verification failed");
    },
  };
  return { io, files, downloads, writes, signatureChecks };
}

describe("path + url builders", () => {
  it("resolveBundle composes the canonical cache path", () => {
    expect(resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE })).toBe(
      `${CACHE}/${bundleFileName(PLUGIN, VERSION)}`,
    );
    expect(bundleFileName(PLUGIN, VERSION)).toBe("dev-1.140.0.bundle.min.mjs");
  });

  it("assetUrl points at the versioned release download path", () => {
    expect(assetUrl(REPO, VERSION, bundleAssetName(PLUGIN))).toBe(
      "https://github.com/reddb-io/red-skills/releases/download/v1.140.0/dev.bundle.min.mjs",
    );
  });

  it("canary cache name is version-independent so it never collides with stable", () => {
    expect(bundleFileName(PLUGIN, VERSION)).toBe("dev-1.140.0.bundle.min.mjs");
    expect(bundleFileName(PLUGIN, VERSION, "stable")).toBe("dev-1.140.0.bundle.min.mjs");
    expect(bundleFileName(PLUGIN, VERSION, "canary")).toBe("dev-canary.bundle.min.mjs");
  });

  it("resolveBundle honours the channel in the cache path", () => {
    expect(
      resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE, channel: "canary" }),
    ).toBe(`${CACHE}/dev-canary.bundle.min.mjs`);
  });
});

describe("ensureBundle", () => {
  it("cache hit: existing bundle whose sha matches the manifest => no download", async () => {
    const bundle = new TextEncoder().encode("export const x = 1;");
    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    const { io, downloads, writes, signatureChecks } = makeIO({
      bundleBytes: bundle,
      files: { [dest]: bundle },
    });

    const path = await ensureBundle(io, {
      plugin: PLUGIN,
      version: VERSION,
      repo: REPO,
      cacheDir: CACHE,
    });

    expect(path).toBe(dest);
    // The manifest and its signature are fetched to verify; the bundle is never downloaded.
    expect(downloads).toEqual([
      assetUrl(REPO, VERSION, manifestAssetName(PLUGIN)),
      assetUrl(REPO, VERSION, manifestSignatureAssetName(PLUGIN)),
    ]);
    expect(signatureChecks).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it("cache miss: downloads, verifies checksum, writes to cache", async () => {
    const bundle = new TextEncoder().encode("export const y = 2;");
    const { io, files, downloads, writes, signatureChecks } = makeIO({ bundleBytes: bundle });

    const path = await ensureBundle(io, {
      plugin: PLUGIN,
      version: VERSION,
      repo: REPO,
      cacheDir: CACHE,
    });

    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    expect(path).toBe(dest);
    expect(files[dest]).toEqual(bundle);
    expect(writes).toEqual([dest]);
    expect(downloads).toContain(assetUrl(REPO, VERSION, bundleAssetName(PLUGIN)));
    expect(downloads).toContain(assetUrl(REPO, VERSION, manifestSignatureAssetName(PLUGIN)));
    expect(signatureChecks).toHaveLength(1);
  });

  it("canary: fetches from the floating canary tag and writes the canary cache file", async () => {
    const bundle = new TextEncoder().encode("export const c = 3;");
    const { io, files, downloads, writes } = makeIO({ bundleBytes: bundle });

    const path = await ensureBundle(io, {
      plugin: PLUGIN,
      version: VERSION,
      repo: REPO,
      cacheDir: CACHE,
      channel: "canary",
    });

    const dest = resolveBundle({
      plugin: PLUGIN,
      version: VERSION,
      cacheDir: CACHE,
      channel: "canary",
    });
    expect(path).toBe(dest);
    expect(files[dest]).toEqual(bundle);
    expect(writes).toEqual([dest]);
    // Every download targets the `canary` tag, never the version-pinned tag.
    expect(downloads.length).toBeGreaterThan(0);
    for (const url of downloads) {
      expect(url).toContain("/releases/download/canary/");
      expect(url).not.toContain(`/v${VERSION}/`);
    }
  });

  it("checksum mismatch: throws and does NOT write to cache", async () => {
    const bundle = new TextEncoder().encode("tampered");
    const { io, files, writes, signatureChecks } = makeIO({
      bundleBytes: bundle,
      manifestSha: "a".repeat(64), // manifest claims a different hash
    });

    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, repo: REPO, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "checksum-mismatch" });

    expect(files[dest]).toBeUndefined();
    expect(writes).toEqual([]);
    expect(signatureChecks).toEqual([]);
  });

  it("missing signature: rejects and does NOT write to cache", async () => {
    const bundle = new TextEncoder().encode("export const unsigned = true;");
    const { io, files, writes } = makeIO({
      bundleBytes: bundle,
      missing: [manifestSignatureAssetName(PLUGIN)],
    });

    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, repo: REPO, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "signature-invalid" });

    expect(files[dest]).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("tampered signature: rejects and does NOT write to cache", async () => {
    const bundle = new TextEncoder().encode("export const signed = true;");
    const { io, files, writes } = makeIO({ bundleBytes: bundle, signatureValid: false });

    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, repo: REPO, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "signature-invalid" });

    expect(files[dest]).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("missing asset: bundle 404 => asset-missing error", async () => {
    const { io } = makeIO({
      // manifest resolves, bundle asset is missing
      manifestSha: "b".repeat(64),
      missing: [bundleAssetName(PLUGIN)],
    });

    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, repo: REPO, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "asset-missing" });
  });

  it("offline: manifest download fails => network error", async () => {
    const { io } = makeIO({ offline: true });

    const err = await ensureBundle(io, {
      plugin: PLUGIN,
      version: VERSION,
      repo: REPO,
      cacheDir: CACHE,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(BundleFetchError);
    expect((err as BundleFetchError).kind).toBe("network");
  });

  it("invalid manifest: malformed JSON => manifest-invalid error", async () => {
    const { io } = makeIO({ bundleBytes: new Uint8Array([1, 2, 3]) });
    // Override download to return junk for the manifest.
    const orig = io.download.bind(io);
    io.download = async (url) => {
      if (url.endsWith(manifestAssetName(PLUGIN))) {
        return new TextEncoder().encode("{ not json");
      }
      return orig(url);
    };

    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, repo: REPO, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "manifest-invalid" });
  });
});
