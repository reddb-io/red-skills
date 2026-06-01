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
  files?: Record<string, Uint8Array>;
  /** asset names that should 404. */
  missing?: string[];
  /** force every download to throw a network error. */
  offline?: boolean;
}) {
  const files: Record<string, Uint8Array> = { ...(opts.files ?? {}) };
  const downloads: string[] = [];
  const writes: string[] = [];

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
  };
  return { io, files, downloads, writes };
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
});

describe("ensureBundle", () => {
  it("cache hit: existing bundle whose sha matches the manifest => no download", async () => {
    const bundle = new TextEncoder().encode("export const x = 1;");
    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    const { io, downloads, writes } = makeIO({
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
    // Only the manifest is fetched to verify; the bundle is never downloaded.
    expect(downloads).toEqual([assetUrl(REPO, VERSION, manifestAssetName(PLUGIN))]);
    expect(writes).toEqual([]);
  });

  it("cache miss: downloads, verifies checksum, writes to cache", async () => {
    const bundle = new TextEncoder().encode("export const y = 2;");
    const { io, files, downloads, writes } = makeIO({ bundleBytes: bundle });

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
  });

  it("checksum mismatch: throws and does NOT write to cache", async () => {
    const bundle = new TextEncoder().encode("tampered");
    const { io, files, writes } = makeIO({
      bundleBytes: bundle,
      manifestSha: "a".repeat(64), // manifest claims a different hash
    });

    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, repo: REPO, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "checksum-mismatch" });

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
