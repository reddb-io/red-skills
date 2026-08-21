import { createHash } from "node:crypto";
import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import {
  NPM_PACKAGE,
  companionBundlePlugins,
  packagedBundleRelPath,
  registryPackageUrl,
  resolveBundle,
} from "./bundle-fetch.js";
import {
  backgroundSelfUpdate,
  backgroundSelfUpdateWithRetry,
  compareSemver,
  isInRange,
  parseSemver,
  pointerPath,
  resolveActiveVersion,
  resolveActiveVersionDetailed,
  statusPath,
  type SelfUpdateIO,
  selectInRangeUpdate,
} from "./self-update.js";

/** The bundle the dev plugin's warm path anchors on (ADR 0147, #4112). */
const PLUGIN = "redskilled";
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
 * maps a version -> the anchor bundle bytes its `@reddb-io/red-skills@<version>`
 * tarball carries. The fake also stages every companion bundle, read
 * from `companionBundlePlugins` rather than listed here, so adding a companion
 * cannot leave this fixture describing a package the real one no longer is.
 * Every fetch (registry query),
 * materialize (npm install), write, and rename is recorded so tests can assert
 * ordering and that the cache stays untouched on a no-op. There is NO download()
 * and NO signature verify — the transport is npm-only (ADR 0091).
 */
function makeIO(opts: {
  files?: Record<string, Uint8Array>;
  registryVersions?: string[];
  packageBundles?: Record<string, Uint8Array>;
  /** when true, the registry query throws a network error. */
  offlineRegistry?: boolean;
  /** number of registry queries to fail before returning metadata. */
  failRegistryFetches?: number;
}) {
  const files: Record<string, Uint8Array> = { ...(opts.files ?? {}) };
  const bundles = opts.packageBundles ?? {};
  const fetches: string[] = [];
  const materializes: string[] = [];
  const writes: string[] = [];
  const renames: Array<[string, string]> = [];

  let remainingFetchFailures = opts.failRegistryFetches ?? 0;

  const io: SelfUpdateIO = {
    async materialize(spec, stagingDir) {
      materializes.push(spec);
      const version = spec.split("@").pop()!;
      const bytes = bundles[version];
      if (!bytes) throw new Error(`npm ERR! 404 '${spec}' is not in this registry`);
      const root = `${stagingDir}/node_modules/${NPM_PACKAGE}`;
      files[`${root}/${packagedBundleRelPath(PLUGIN)}`] = bytes;
      for (const companion of companionBundlePlugins(PLUGIN)) {
        files[`${root}/${packagedBundleRelPath(companion)}`] = bundleBytesFor(`${companion}-${version}`);
      }
      return root;
    },
    async fetchText(url) {
      fetches.push(url);
      if (opts.offlineRegistry || remainingFetchFailures > 0) {
        remainingFetchFailures -= 1;
        throw new Error("ECONNREFUSED registry.npmjs.org");
      }
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
    async readdir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        names.add(rest);
      }
      return [...names];
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

  it("auto-reconciles a pointer that is behind the newest cached lane bundle", async () => {
    const pointed = "1.144.0";
    const laneNewest = "1.145.0";
    const ptr = pointerPath(CACHE, PLUGIN);
    const { io, files, renames } = makeIO({
      files: {
        [ptr]: enc(JSON.stringify({ version: pointed })),
        [resolveBundle({ plugin: PLUGIN, version: pointed, cacheDir: CACHE })]: bundleBytesFor(pointed),
        [resolveBundle({ plugin: PLUGIN, version: laneNewest, cacheDir: CACHE })]: bundleBytesFor(laneNewest),
      },
    });

    const result = await resolveActiveVersionDetailed(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      cacheDir: CACHE,
      channel: "stable",
    });

    expect(result.version).toBe(laneNewest);
    expect(result.reconciled).toEqual({ from: pointed, to: laneNewest });
    expect(result.logNotes.join(" ")).toContain(`reconciled pointer ${pointed} -> ${laneNewest}`);
    expect(JSON.parse(new TextDecoder().decode(files[ptr]))).toEqual({ version: laneNewest });
    expect(renames).toEqual([[`${ptr}.${laneNewest}.tmp`, ptr]]);
  });

  it("surfaces stale failed self-update checks without fetching", async () => {
    const updated = "1.145.0";
    const nowMs = 10 * 60 * 60 * 1000;
    const { io } = makeIO({
      files: {
        [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: updated })),
        [resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE })]: bundleBytesFor(updated),
        [statusPath(CACHE, PLUGIN)]: enc(JSON.stringify({
          lastFailureAtMs: nowMs - 5 * 60 * 60 * 1000,
          lastError: "fetch failed",
          lastStatus: "error",
        })),
      },
    });
    io.fetchText = async () => {
      throw new Error("NO FETCH ALLOWED IN A RENDER/HOOK PATH");
    };

    const result = await resolveActiveVersionDetailed(
      io,
      { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" },
      { nowMs, staleAfterMs: 4 * 60 * 60 * 1000 },
    );

    expect(result.version).toBe(updated);
    expect(result.staleFailure?.lastError).toBe("fetch failed");
    expect(result.logNotes.join(" ")).toContain("self-update stale: last check failed 5h ago");
  });

  it("reports the age of an up-to-date verdict and marks an old success stale", async () => {
    const nowMs = 10 * 60 * 60 * 1000;
    const checkedAtMs = nowMs - 5 * 60 * 60 * 1000;
    const { io } = makeIO({
      files: {
        [statusPath(CACHE, PLUGIN)]: enc(JSON.stringify({
          lastCheckAtMs: checkedAtMs,
          lastSuccessAtMs: checkedAtMs,
          lastStatus: "up-to-date",
        })),
      },
    });

    const result = await resolveActiveVersionDetailed(
      io,
      { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" },
      { nowMs, staleAfterMs: 4 * 60 * 60 * 1000 },
    );

    expect(result.selfUpdateStatus).toEqual({
      status: "up-to-date",
      checkedAtMs,
      ageMs: 5 * 60 * 60 * 1000,
    });
    expect(result.staleSuccess).toEqual({
      status: "up-to-date",
      ageMs: 5 * 60 * 60 * 1000,
    });
    expect(result.logNotes).toContain("self-update up-to-date: checked 5h ago");
    expect(result.logNotes).toContain("self-update stale: last successful check was 5h ago");
  });

  it("writes self-update status as TOON and reads legacy JSON status", async () => {
    const updated = "1.145.0";
    const nowMs = 10 * 60 * 60 * 1000;
    const legacyStatus = {
      lastFailureAtMs: nowMs - 5 * 60 * 60 * 1000,
      lastError: "fetch failed",
      lastStatus: "error",
    };
    const status = statusPath(CACHE, PLUGIN);
    const { io, files } = makeIO({
      files: {
        [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: updated })),
        [resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE })]: bundleBytesFor(updated),
        [status]: enc(JSON.stringify(legacyStatus)),
      },
      registryVersions: [INSTALLED],
    });

    const result = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      repo: REPO,
      installedVersion: INSTALLED,
      cacheDir: CACHE,
      channel: "stable",
    }, { nowMs: () => nowMs });

    expect(result.status).toBe("up-to-date");
    const written = new TextDecoder().decode(files[status]);
    expect(() => JSON.parse(written)).toThrow();
    expect(decode(written)).toEqual({
      lastCheckAtMs: nowMs,
      lastSuccessAtMs: nowMs,
      lastStatus: "up-to-date",
    });
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
    // Anchor and companions ride in the one core package: one materialisation.
    expect(materializes).toEqual([npmSpec(updated)]);
    // Bundle cached under the target version.
    const bundlePath = resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE });
    expect(files[bundlePath]).toEqual(bundleBytesFor(updated));
    // Every companion travels with the update — including the `redskilled`
    // daemon bundle the documented statusLine globs for (#3074).
    for (const companion of companionBundlePlugins(PLUGIN)) {
      const companionPath = resolveBundle({ plugin: companion, version: updated, cacheDir: CACHE });
      expect(files[companionPath], companion).toEqual(bundleBytesFor(`${companion}-${updated}`));
    }
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
    expect(writes).toEqual([statusPath(CACHE, PLUGIN)]);
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
    expect(writes).toEqual([statusPath(CACHE, PLUGIN)]);
    expect(renames).toEqual([]);
  });

  it("a successful check clears a recorded failure so the record cannot rot", async () => {
    const { io, files } = makeIO({
      registryVersions: [INSTALLED],
      packageBundles: { [INSTALLED]: bundleBytesFor(INSTALLED) },
      files: {
        [statusPath(CACHE, PLUGIN)]: enc(
          JSON.stringify({
            lastCheckAtMs: 1,
            lastFailureAtMs: 1,
            lastError: "ECONNREFUSED registry.npmjs.org",
            lastStatus: "error",
          }),
        ),
      },
    });

    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });

    expect(res).toEqual({ status: "up-to-date", version: INSTALLED });
    const record = decode(new TextDecoder().decode(files[statusPath(CACHE, PLUGIN)])) as Record<string, unknown>;
    expect(record.lastStatus).toBe("up-to-date");
    expect(record).not.toHaveProperty("lastFailureAtMs");
    expect(record).not.toHaveProperty("lastError");
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
    expect(writes).toEqual([statusPath(CACHE, PLUGIN)]);
    expect(renames).toEqual([]);
    expect(files[pointerPath(CACHE, PLUGIN)]).toEqual(enc(JSON.stringify({ version: INSTALLED })));
  });

  it("retries a transient registry failure with bounded backoff and then recovers", async () => {
    const updated = "1.145.0";
    const delays: number[] = [];
    const retries: string[] = [];
    const { io, fetches } = makeIO({
      failRegistryFetches: 1,
      registryVersions: [INSTALLED, updated],
      packageBundles: { [updated]: bundleBytesFor(updated) },
    });

    const res = await backgroundSelfUpdateWithRetry(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    }, {
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 40,
      sleep: async (delayMs) => { delays.push(delayMs); },
      onRetry: (event) => { retries.push(`${event.attempt}->${event.nextAttempt}:${event.delayMs}`); },
    });

    expect(res).toEqual({ status: "updated", version: updated, attempts: 2 });
    expect(fetches).toEqual([registryPackageUrl(), registryPackageUrl()]);
    expect(delays).toEqual([10]);
    expect(retries).toEqual(["1->2:10"]);
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
    expect(writes).toContain(statusPath(CACHE, PLUGIN));
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
