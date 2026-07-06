import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NPM_PACKAGE,
  packagedBundleRelPath,
  registryPackageUrl,
  resolveBundle,
} from "./bundle-fetch.js";
import {
  backgroundSelfUpdate,
  compareSemver,
  isInRange,
  parseSemver,
  pointerPath,
  resolveActiveVersion,
  type SelfUpdateIO,
  selectInRangeUpdate,
} from "./self-update.js";

const PLUGIN = "dev";
const REPO = "reddb-io/red-skills";
const CACHE = "/cache/bundles";
const INSTALLED = "1.140.0";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
const bundleBytesFor = (version: string) => enc(`export const V = "${version}";`);

const npmSpec = (version: string) => `${NPM_PACKAGE}@${version}`;

/** Registry metadata advertising a set of published versions. */
function registryMetadata(versions: string[]): string {
  const map: Record<string, unknown> = {};
  for (const v of versions) map[v] = {};
  return JSON.stringify({ "dist-tags": { latest: versions[versions.length - 1] }, versions: map });
}

/**
 * In-memory self-update IO backed by a fake npm registry + package store.
 *
 * `registryVersions` are the versions the registry advertises; `packageBundles`
 * maps a version -> the bundle bytes its `@reddb-io/red-skills@<version>` tarball
 * carries. Every fetch (registry query), materialize (npm install), write, and
 * rename is recorded so tests can assert ordering and that the cache stays
 * untouched on a no-op. There is NO download() and NO signature verify — the
 * transport is npm-only (ADR 0091).
 */
function makeIO(opts: {
  files?: Record<string, Uint8Array>;
  registryVersions?: string[];
  packageBundles?: Record<string, Uint8Array>;
  /** when true, the registry query throws a network error. */
  offlineRegistry?: boolean;
}) {
  const files: Record<string, Uint8Array> = { ...(opts.files ?? {}) };
  const bundles = opts.packageBundles ?? {};
  const fetches: string[] = [];
  const materializes: string[] = [];
  const writes: string[] = [];
  const renames: Array<[string, string]> = [];

  const io: SelfUpdateIO = {
    async materialize(spec, stagingDir) {
      materializes.push(spec);
      const version = spec.split("@").pop()!;
      const bytes = bundles[version];
      if (!bytes) throw new Error(`npm ERR! 404 '${spec}' is not in this registry`);
      const root = `${stagingDir}/node_modules/${NPM_PACKAGE}`;
      files[`${root}/${packagedBundleRelPath(PLUGIN)}`] = bytes;
      return root;
    },
    async fetchText(url) {
      fetches.push(url);
      if (opts.offlineRegistry) throw new Error("ECONNREFUSED registry.npmjs.org");
      if (url === registryPackageUrl()) return registryMetadata(opts.registryVersions ?? []);
      throw new Error(`GET ${url} -> 404`);
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
    async rename(from, to) {
      renames.push([from, to]);
      const bytes = files[from];
      if (!bytes) throw new Error(`ENOENT ${from}`);
      files[to] = bytes;
      delete files[from];
    },
  };
  return { io, files, fetches, materializes, writes, renames };
}

describe("semver policy", () => {
  it("parseSemver reads a leading x.y.z, ignoring suffixes", () => {
    expect(parseSemver("1.140.0")).toEqual({ major: 1, minor: 140, patch: 0 });
    expect(parseSemver("2.0.3-rc.1")).toEqual({ major: 2, minor: 0, patch: 3 });
    expect(parseSemver("nope")).toBeNull();
  });

  it("compareSemver orders numerically, not lexically", () => {
    expect(compareSemver("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("1.140.2", "1.140.2")).toBe(0);
    expect(compareSemver("2.0.0", "1.999.0")).toBeGreaterThan(0);
  });

  it("isInRange means same major line", () => {
    expect(isInRange("1.140.0", "1.145.9")).toBe(true);
    expect(isInRange("1.140.0", "2.0.0")).toBe(false);
  });
});

describe("selectInRangeUpdate", () => {
  const base = { installed: INSTALLED, current: INSTALLED, channel: "stable" as const };

  it("accepts a newer same-major candidate", () => {
    expect(selectInRangeUpdate({ ...base, candidate: "1.145.0" })).toBe("1.145.0");
  });

  it("rejects an out-of-range (new major) candidate — operator action only", () => {
    expect(selectInRangeUpdate({ ...base, candidate: "2.0.0" })).toBeNull();
  });

  it("rejects an equal or older candidate", () => {
    expect(selectInRangeUpdate({ ...base, candidate: "1.140.0" })).toBeNull();
    expect(selectInRangeUpdate({ ...base, candidate: "1.139.9" })).toBeNull();
  });

  it("rejects everything on canary (it self-refreshes via checksum)", () => {
    expect(selectInRangeUpdate({ ...base, candidate: "1.145.0", channel: "canary" })).toBeNull();
  });

  it("compares against `current`, not `installed`, so it never re-picks a done update", () => {
    expect(
      selectInRangeUpdate({ installed: INSTALLED, current: "1.145.0", candidate: "1.145.0", channel: "stable" }),
    ).toBeNull();
  });
});

describe("resolveActiveVersion (render/hook path — local reads only)", () => {
  it("returns the installed version when no pointer exists", async () => {
    const { io } = makeIO({});
    await expect(
      resolveActiveVersion(io, { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" }),
    ).resolves.toBe(INSTALLED);
  });

  it("honours a valid in-range pointer whose bundle is cached", async () => {
    const updated = "1.145.0";
    const bundlePath = resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE });
    const { io } = makeIO({
      files: {
        [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: updated })),
        [bundlePath]: bundleBytesFor(updated),
      },
    });
    await expect(
      resolveActiveVersion(io, { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" }),
    ).resolves.toBe(updated);
  });

  it("ignores a pointer whose bundle is missing from the cache", async () => {
    const { io } = makeIO({
      files: { [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: "1.145.0" })) },
    });
    await expect(
      resolveActiveVersion(io, { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" }),
    ).resolves.toBe(INSTALLED);
  });

  it("ignores an out-of-range (different major) pointer", async () => {
    const updated = "2.0.0";
    const { io } = makeIO({
      files: {
        [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: updated })),
        [resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE })]: bundleBytesFor(updated),
      },
    });
    await expect(
      resolveActiveVersion(io, { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" }),
    ).resolves.toBe(INSTALLED);
  });

  it("NEVER fetches — proves the render path does no network IO", async () => {
    const updated = "1.145.0";
    const { io } = makeIO({
      files: {
        [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: updated })),
        [resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE })]: bundleBytesFor(updated),
      },
    });
    // If resolution ever reached the network, these would throw.
    io.fetchText = async () => {
      throw new Error("NO FETCH ALLOWED IN A RENDER/HOOK PATH");
    };
    io.materialize = async () => {
      throw new Error("NO NPM INSTALL ALLOWED IN A RENDER/HOOK PATH");
    };
    await expect(
      resolveActiveVersion(io, { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" }),
    ).resolves.toBe(updated);
  });
});

describe("backgroundSelfUpdate (registry discovery + npm materialize)", () => {
  it("in-range newer version: queries the registry, materialises, atomically swaps the pointer", async () => {
    const updated = "1.145.0";
    const { io, files, fetches, materializes, writes, renames } = makeIO({
      registryVersions: ["1.140.0", "1.144.0", updated, "2.0.0"],
      packageBundles: { [updated]: bundleBytesFor(updated) },
    });

    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });

    expect(res).toEqual({ status: "updated", version: updated });
    // Discovery went to the registry URL, never a releases/download URL.
    expect(fetches).toEqual([registryPackageUrl()]);
    expect(fetches.every((u) => !u.includes("releases/download"))).toBe(true);
    // The pinned target package was materialised.
    expect(materializes).toEqual([npmSpec(updated)]);
    // Bundle cached under the target version.
    const bundlePath = resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE });
    expect(files[bundlePath]).toEqual(bundleBytesFor(updated));
    // Pointer now names the update, placed atomically (temp -> rename).
    const ptr = pointerPath(CACHE, PLUGIN);
    expect(JSON.parse(new TextDecoder().decode(files[ptr]))).toEqual({ version: updated });
    expect(renames).toEqual([[`${ptr}.${updated}.tmp`, ptr]]);
    expect(writes).toContain(`${ptr}.${updated}.tmp`);

    // The next boot picks up the swap.
    const nextBoot = await resolveActiveVersion(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      cacheDir: CACHE,
      channel: "stable",
    });
    expect(nextBoot).toBe(updated);
  });

  it("newest published is a different major: cache and pointer untouched", async () => {
    const { io, files, materializes, writes, renames } = makeIO({
      registryVersions: ["2.0.0", "2.1.0"], // no in-range 1.x newer than installed
      packageBundles: { "2.1.0": bundleBytesFor("2.1.0") },
    });

    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });

    expect(res).toEqual({ status: "up-to-date", version: INSTALLED });
    expect(materializes).toEqual([]);
    expect(writes).toEqual([]);
    expect(renames).toEqual([]);
    expect(files[pointerPath(CACHE, PLUGIN)]).toBeUndefined();
  });

  it("already up to date: no materialize, no swap", async () => {
    const { io, materializes, writes, renames } = makeIO({
      registryVersions: [INSTALLED],
      packageBundles: { [INSTALLED]: bundleBytesFor(INSTALLED) },
    });
    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });
    expect(res).toEqual({ status: "up-to-date", version: INSTALLED });
    expect(materializes).toEqual([]);
    expect(writes).toEqual([]);
    expect(renames).toEqual([]);
  });

  it("registry offline: typed error, cache keeps serving, retried later", async () => {
    const { io, files, writes, renames } = makeIO({
      offlineRegistry: true,
      files: { [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: INSTALLED })) },
    });

    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });

    expect(res.status).toBe("error");
    expect(res.error).toMatch(/ECONNREFUSED|network|failed/i);
    expect(writes).toEqual([]);
    expect(renames).toEqual([]);
    expect(files[pointerPath(CACHE, PLUGIN)]).toEqual(enc(JSON.stringify({ version: INSTALLED })));
  });

  it("target package unresolvable: no swap (bad target never adopted)", async () => {
    const updated = "1.145.0";
    const { io, writes, renames } = makeIO({
      registryVersions: ["1.140.0", updated],
      packageBundles: {}, // registry advertises it but npm cannot resolve it
    });
    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });
    expect(res.status).toBe("error");
    expect(renames).toEqual([]);
    expect(writes).not.toContain(pointerPath(CACHE, PLUGIN));
  });

  it("canary channel: skipped entirely (self-refreshes via checksum)", async () => {
    const { io, writes } = makeIO({
      registryVersions: ["1.145.0"],
      packageBundles: { "1.145.0": bundleBytesFor("1.145.0") },
    });
    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "canary",
    });
    expect(res).toEqual({ status: "skipped-channel" });
    expect(writes).toEqual([]);
  });
});
