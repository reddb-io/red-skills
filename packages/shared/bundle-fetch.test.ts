import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BundleFetchError,
  type BundleIO,
  CANARY_DIST_TAG,
  NPM_PACKAGE,
  NPM_REGISTRY_BASE,
  bundleFileName,
  companionBundlePlugins,
  ensureBundle,
  fetchNewestSameMajor,
  fetchPublishedVersionHorizon,
  newestPublished,
  newestSameMajor,
  npmPackageSpec,
  packagedBundleName,
  packagedBundleRelPath,
  parseRegistryVersions,
  registryDistTagVersion,
  registryPackageUrl,
  resolveBundle,
} from "./bundle-fetch.js";

const PLUGIN = "dev";
const CACHE = "/cache/bundles";
const VERSION = "1.140.0";

const enc = (s: string) => new TextEncoder().encode(s);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bundleBytesFor = (v: string) => enc(`export const V = "${v}";`);

/**
 * In-memory npm-transport IO backed by a fake npm package store.
 *
 * `packageBundles[spec][plugin]` are the bundle bytes the package tarball for
 * `spec` carries at `dist/<plugin>.bundle.min.mjs`. `materialize(spec, staging)`
 * "installs" that package by writing its dist files under
 * `<staging>/node_modules/@reddb-io/red-skills/dist/`, mirroring what real npm
 * does, and returns the package root. Every materialize / write is recorded so
 * tests can assert cache-first behaviour (no materialize on a cache hit).
 */
function makeIO(opts: {
  files?: Record<string, Uint8Array>;
  packageBundles?: Record<string, Record<string, Uint8Array>>;
  /** npm dist-tag fixture: tag name -> published package version. */
  distTags?: Record<string, string>;
  /** specs whose materialize should throw a network error. */
  offlineSpecs?: string[];
  /** registry metadata JSON keyed by URL. */
  registry?: Record<string, string>;
}) {
  const files: Record<string, Uint8Array> = { ...(opts.files ?? {}) };
  const packages = opts.packageBundles ?? {};
  const materializes: string[] = [];
  const writes: string[] = [];
  const fetches: string[] = [];

  const io: BundleIO = {
    async materialize(spec, stagingDir) {
      materializes.push(spec);
      if ((opts.offlineSpecs ?? []).includes(spec)) {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      }
      const bundles = packages[spec] ?? packages[resolveDistTagSpec(spec, opts.distTags ?? {})];
      if (!bundles) throw new Error(`npm ERR! 404 '${spec}' is not in this registry`);
      const root = `${stagingDir}/node_modules/${NPM_PACKAGE}`;
      for (const [plugin, bytes] of Object.entries(bundles)) {
        files[`${root}/${packagedBundleRelPath(plugin)}`] = bytes;
      }
      return root;
    },
    async readFile(path) {
      const b = files[path];
      if (!b) throw new Error(`ENOENT ${path}`);
      return b;
    },
    async writeFile(path, bytes) {
      writes.push(path);
      files[path] = bytes;
    },
    async exists(path) {
      return path in files;
    },
    sha256,
    async fetchText(url) {
      fetches.push(url);
      const body = (opts.registry ?? {})[url];
      if (body === undefined) throw new Error(`GET ${url} -> 404`);
      return body;
    },
  };
  return { io, files, materializes, writes, fetches };
}

/** The dev warm path's companion bundles as a fake package's `dist/` entries. */
function packagedCompanions(suffix = ""): Record<string, Uint8Array> {
  return Object.fromEntries(
    companionBundlePlugins(PLUGIN).map((companion) => [companion, bundleBytesFor(`${companion}${suffix}`)]),
  );
}

/** The same companions, already sitting in the cache under their keyed names. */
function cachedCompanions(version = VERSION): Record<string, Uint8Array> {
  return Object.fromEntries(
    companionBundlePlugins(PLUGIN).map((companion) => [
      resolveBundle({ plugin: companion, version, cacheDir: CACHE }),
      bundleBytesFor(companion),
    ]),
  );
}

function resolveDistTagSpec(spec: string, tags: Record<string, string>): string {
  const prefix = `${NPM_PACKAGE}@`;
  if (!spec.startsWith(prefix)) return spec;
  const ref = spec.slice(prefix.length);
  const version = tags[ref];
  return version ? `${NPM_PACKAGE}@${version}` : spec;
}

describe("npm spec + registry URL builders", () => {
  it("pins the exact version on stable and the dist-tag on canary", () => {
    expect(npmPackageSpec(VERSION, "stable")).toBe(`${NPM_PACKAGE}@1.140.0`);
    expect(npmPackageSpec(VERSION)).toBe(`${NPM_PACKAGE}@1.140.0`);
    expect(npmPackageSpec(VERSION, "canary")).toBe(`${NPM_PACKAGE}@${CANARY_DIST_TAG}`);
  });

  it("builds a %2F-escaped registry URL and no releases/download path", () => {
    const url = registryPackageUrl();
    expect(url).toBe(`${NPM_REGISTRY_BASE}/@reddb-io%2Fred-skills`);
    expect(url).not.toContain("releases/download");
  });

  it("names the packaged bundle path inside the tarball", () => {
    expect(packagedBundleName("memory")).toBe("memory.bundle.min.mjs");
    expect(packagedBundleRelPath("memory")).toBe("dist/memory.bundle.min.mjs");
    expect(packagedBundleName("code-nav")).toBe("code-nav.bundle.min.mjs");
    expect(packagedBundleRelPath("code-nav")).toBe("dist/code-nav.bundle.min.mjs");
  });
});

describe("cache filename", () => {
  it("keys stable by version and canary by the channel literal", () => {
    expect(bundleFileName(PLUGIN, VERSION)).toBe("dev-1.140.0.bundle.min.mjs");
    expect(bundleFileName(PLUGIN, VERSION, "canary")).toBe("dev-canary.bundle.min.mjs");
    expect(resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE })).toBe(
      `${CACHE}/dev-1.140.0.bundle.min.mjs`,
    );
  });

  it("treats rsp and redskilled as companions of the dev warm path", () => {
    expect(companionBundlePlugins("dev")).toEqual(["rsp", "redskilled"]);
    expect(companionBundlePlugins("memory")).toEqual([]);
  });
});

describe("ensureBundle (npm transport)", () => {
  it("is cache-first: a present cached bundle never invokes npm", async () => {
    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    const { io, materializes } = makeIO({
      files: { [dest]: bundleBytesFor(VERSION), ...cachedCompanions() },
    });
    const path = await ensureBundle(io, { plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    expect(path).toBe(dest);
    expect(materializes).toEqual([]);
  });

  it("cache miss: materialises the pinned npm package and copies its bundle into cache", async () => {
    const spec = npmPackageSpec(VERSION);
    const bytes = bundleBytesFor(VERSION);
    const { io, files, materializes } = makeIO({
      packageBundles: { [spec]: { [PLUGIN]: bytes, ...packagedCompanions() } },
    });
    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    const path = await ensureBundle(io, { plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    expect(path).toBe(dest);
    expect(materializes).toEqual([spec]);
    expect(files[dest]).toEqual(bytes);
    for (const companion of companionBundlePlugins(PLUGIN)) {
      const companionDest = resolveBundle({ plugin: companion, version: VERSION, cacheDir: CACHE });
      expect(files[companionDest], companion).toEqual(bundleBytesFor(companion));
    }
  });

  it("warms every companion when the dev bundle is cached but a companion is missing", async () => {
    const spec = npmPackageSpec(VERSION);
    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    const devBytes = bundleBytesFor(VERSION);
    const { io, files, materializes } = makeIO({
      files: { [dest]: devBytes },
      packageBundles: { [spec]: { [PLUGIN]: devBytes, ...packagedCompanions() } },
    });
    const path = await ensureBundle(io, { plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    expect(path).toBe(dest);
    expect(materializes).toEqual([spec]);
    expect(files[dest]).toEqual(devBytes);
    for (const companion of companionBundlePlugins(PLUGIN)) {
      const companionDest = resolveBundle({ plugin: companion, version: VERSION, cacheDir: CACHE });
      expect(files[companionDest], companion).toEqual(bundleBytesFor(companion));
    }
  });

  /**
   * The daemon bundle is what the documented `statusLine` globs (#3074), so a
   * warm that skipped it left the render command resolving nothing at all.
   */
  it("warms the redskilled daemon bundle the statusLine command globs for", async () => {
    const spec = npmPackageSpec(VERSION);
    const devBytes = bundleBytesFor(VERSION);
    const { io, files } = makeIO({
      packageBundles: { [spec]: { [PLUGIN]: devBytes, ...packagedCompanions() } },
    });
    await ensureBundle(io, { plugin: PLUGIN, version: VERSION, cacheDir: CACHE });
    expect(files[`${CACHE}/redskilled-${VERSION}.bundle.min.mjs`]).toEqual(bundleBytesFor("redskilled"));
  });

  it("canary resolves the dist-tag to a published stable version and writes the canary cache file", async () => {
    const spec = npmPackageSpec(VERSION, "canary");
    const published = "1.146.0";
    const publishedSpec = npmPackageSpec(published);
    const bytes = bundleBytesFor(published);
    const { io, files, materializes } = makeIO({
      distTags: { canary: published },
      packageBundles: { [publishedSpec]: { [PLUGIN]: bytes, ...packagedCompanions("-canary") } },
    });
    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE, channel: "canary" });
    const path = await ensureBundle(io, {
      plugin: PLUGIN,
      version: VERSION,
      cacheDir: CACHE,
      channel: "canary",
    });
    expect(path).toBe(`${CACHE}/dev-canary.bundle.min.mjs`);
    expect(materializes).toEqual([spec]);
    expect(files[dest]).toEqual(bytes);
    for (const companion of companionBundlePlugins(PLUGIN)) {
      expect(files[`${CACHE}/${companion}-canary.bundle.min.mjs`], companion).toEqual(
        bundleBytesFor(`${companion}-canary`),
      );
    }
  });

  it("canary refreshes a stale channel cache from the current dist-tag", async () => {
    const spec = npmPackageSpec(VERSION, "canary");
    const published = "1.146.0";
    const publishedSpec = npmPackageSpec(published);
    const dest = resolveBundle({ plugin: PLUGIN, version: VERSION, cacheDir: CACHE, channel: "canary" });
    const bytes = bundleBytesFor(published);
    const { io, files, materializes } = makeIO({
      files: { [dest]: bundleBytesFor("old-canary") },
      distTags: { canary: published },
      packageBundles: { [publishedSpec]: { [PLUGIN]: bytes, ...packagedCompanions("-canary") } },
    });
    const path = await ensureBundle(io, {
      plugin: PLUGIN,
      version: VERSION,
      cacheDir: CACHE,
      channel: "canary",
    });
    expect(path).toBe(dest);
    expect(materializes).toEqual([spec]);
    expect(files[dest]).toEqual(bytes);
    for (const companion of companionBundlePlugins(PLUGIN)) {
      expect(files[`${CACHE}/${companion}-canary.bundle.min.mjs`], companion).toEqual(
        bundleBytesFor(`${companion}-canary`),
      );
    }
  });

  it("classifies an unresolvable package as package-missing and never writes cache", async () => {
    const { io, writes } = makeIO({ packageBundles: {} });
    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "package-missing" });
    expect(writes).toEqual([]);
  });

  it("classifies a network failure as network", async () => {
    const spec = npmPackageSpec(VERSION);
    const { io } = makeIO({
      packageBundles: { [spec]: { [PLUGIN]: bundleBytesFor(VERSION), rsp: bundleBytesFor("rsp") } },
      offlineSpecs: [spec],
    });
    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "network" });
  });

  it("raises bundle-missing when the resolved package lacks the plugin bundle", async () => {
    const spec = npmPackageSpec(VERSION);
    const { io } = makeIO({ packageBundles: { [spec]: { memory: bundleBytesFor(VERSION) } } });
    await expect(
      ensureBundle(io, { plugin: PLUGIN, version: VERSION, cacheDir: CACHE }),
    ).rejects.toMatchObject({ name: "BundleFetchError", kind: "bundle-missing" });
  });
});

describe("registry version discovery", () => {
  const metadata = JSON.stringify({
    "dist-tags": { latest: "1.145.2", canary: "1.146.0" },
    versions: {
      "1.140.0": {},
      "1.145.2": {},
      "1.144.0": {},
      "1.146.0": {},
      "2.0.0": {},
      "0.9.0": {},
    },
  });

  it("parses the published-version list", () => {
    expect(parseRegistryVersions(metadata).sort()).toEqual(
      ["0.9.0", "1.140.0", "1.144.0", "1.145.2", "1.146.0", "2.0.0"].sort(),
    );
    expect(parseRegistryVersions("not json")).toEqual([]);
  });

  it("reads a dist-tag version", () => {
    expect(registryDistTagVersion(metadata, "latest")).toBe("1.145.2");
    expect(registryDistTagVersion(metadata, "canary")).toBe("1.146.0");
    expect(registryDistTagVersion(metadata, "missing")).toBeUndefined();
  });

  it("picks the newest SAME-major version, never crossing a major", () => {
    expect(newestSameMajor(parseRegistryVersions(metadata), "1.140.0")).toBe("1.146.0");
    // 2.x is out of range for a 1.x install — never selected.
    expect(newestSameMajor(["2.0.0", "2.1.0"], "1.140.0")).toBeNull();
    expect(newestSameMajor([], "1.140.0")).toBeNull();
  });

  it("fetchNewestSameMajor queries the registry URL (never a releases/download URL)", async () => {
    const url = registryPackageUrl();
    const { io, fetches } = makeIO({ registry: { [url]: metadata } });
    const newest = await fetchNewestSameMajor(io, "1.140.0");
    expect(newest).toBe("1.146.0");
    expect(fetches).toEqual([url]);
    expect(fetches.every((u) => !u.includes("releases/download"))).toBe(true);
  });

  it("picks the newest version published at ALL, ignoring prereleases", () => {
    expect(newestPublished(parseRegistryVersions(metadata))).toBe("2.0.0");
    // A prerelease is not a major an operator is asked to cross to.
    expect(newestPublished(["1.0.0", "2.0.0-rc.1"])).toBe("1.0.0");
    expect(newestPublished([])).toBeNull();
  });

  it("answers both version questions from ONE registry read", async () => {
    const url = registryPackageUrl();
    const { io, fetches } = makeIO({ registry: { [url]: metadata } });

    // Two answers that must describe the same instant: a second read could see a
    // release land between them and report a gap that never existed.
    expect(await fetchPublishedVersionHorizon(io, "1.140.0")).toEqual({
      sameMajor: "1.146.0",
      newest: "2.0.0",
    });
    expect(fetches).toEqual([url]);
  });
});

describe("transport invariant: no client fetch path builds a releases/download URL", () => {
  it("the client only ever asks for an npm spec or the registry URL", () => {
    // The npm spec + registry URL are the ONLY things the client asks for.
    expect(npmPackageSpec(VERSION)).not.toContain("releases/download");
    expect(registryPackageUrl()).not.toContain("releases/download");
    // BundleFetchError carries no GitHub-release failure kinds anymore.
    const err = new BundleFetchError("package-missing", "x");
    expect(["npm-unavailable", "package-missing", "bundle-missing", "network"]).toContain(err.kind);
  });
});
