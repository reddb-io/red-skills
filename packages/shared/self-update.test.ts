import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bundleAssetName,
  manifestAssetName,
  resolveBundle,
} from "./bundle-fetch.js";
import {
  backgroundSelfUpdate,
  compareSemver,
  inRangeReleaseRef,
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
const manifestJson = (version: string, sha: string) =>
  enc(JSON.stringify({ plugin: PLUGIN, version, sha256: sha }));

/**
 * In-memory self-update IO backed by a fake GitHub release surface.
 *
 * `releaseVersions` are the pinned `v<x>` releases that exist; `latestInRange`
 * is what the floating major-line manifest (`v<major>`) advertises. Every
 * download/write/rename is recorded so tests can assert ordering and that the
 * cache stays untouched on a no-op.
 */
function makeIO(opts: {
  files?: Record<string, Uint8Array>;
  /** version -> its published bundle bytes (pinned `v<version>` release). */
  releaseVersions?: Record<string, Uint8Array>;
  /** version the floating `v<major>` manifest points at; undefined = 404. */
  latestInRange?: string;
  /** major tags whose manifest download should throw a network error. */
  offlineMajors?: string[];
}) {
  const files: Record<string, Uint8Array> = { ...(opts.files ?? {}) };
  const releases = opts.releaseVersions ?? {};
  const downloads: string[] = [];
  const writes: string[] = [];
  const renames: Array<[string, string]> = [];

  const io: SelfUpdateIO = {
    async download(url) {
      downloads.push(url);
      const name = url.split("/").pop()!;
      const ref = url.split("/releases/download/")[1]?.split("/")[0] ?? "";
      if (name === manifestAssetName(PLUGIN)) {
        // Floating major-line tag advertises the newest in-range version.
        if (/^v\d+$/.test(ref)) {
          if (opts.offlineMajors?.includes(ref)) throw new Error("ECONNREFUSED");
          const latest = opts.latestInRange;
          if (!latest) throw new Error("404 Not Found");
          return manifestJson(latest, sha256(releases[latest] ?? enc("missing")));
        }
        // Pinned v<version> manifest.
        const v = ref.replace(/^v/, "");
        const bytes = releases[v];
        if (!bytes) throw new Error("404 Not Found");
        return manifestJson(v, sha256(bytes));
      }
      if (name === bundleAssetName(PLUGIN)) {
        const v = ref.replace(/^v/, "");
        const bytes = releases[v];
        if (!bytes) throw new Error("404 Not Found");
        return bytes;
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
    async rename(from, to) {
      renames.push([from, to]);
      const bytes = files[from];
      if (!bytes) throw new Error(`ENOENT ${from}`);
      files[to] = bytes;
      delete files[from];
    },
  };
  return { io, files, downloads, writes, renames };
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

  it("inRangeReleaseRef is the floating major tag", () => {
    expect(inRangeReleaseRef("1.140.0")).toBe("v1");
    expect(inRangeReleaseRef("2.3.4")).toBe("v2");
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
    // An IO whose download() blows up: if resolution ever fetched, this throws.
    const updated = "1.145.0";
    const { io } = makeIO({
      files: {
        [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: updated })),
        [resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE })]: bundleBytesFor(updated),
      },
    });
    io.download = async () => {
      throw new Error("NO FETCH ALLOWED IN A RENDER/HOOK PATH");
    };
    await expect(
      resolveActiveVersion(io, { plugin: PLUGIN, installedVersion: INSTALLED, cacheDir: CACHE, channel: "stable" }),
    ).resolves.toBe(updated);
  });
});

describe("backgroundSelfUpdate", () => {
  it("in-range newer bundle: fetches, verifies, atomically swaps the pointer", async () => {
    const updated = "1.145.0";
    const { io, files, writes, renames } = makeIO({
      releaseVersions: { [updated]: bundleBytesFor(updated) },
      latestInRange: updated,
    });

    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });

    expect(res).toEqual({ status: "updated", version: updated });
    // Bundle cached under the target version.
    const bundlePath = resolveBundle({ plugin: PLUGIN, version: updated, cacheDir: CACHE });
    expect(files[bundlePath]).toEqual(bundleBytesFor(updated));
    // Pointer now names the update, and it was placed atomically (temp -> rename).
    const ptr = pointerPath(CACHE, PLUGIN);
    expect(JSON.parse(new TextDecoder().decode(files[ptr]))).toEqual({ version: updated });
    expect(renames).toEqual([[`${ptr}.${updated}.tmp`, ptr]]);
    // The temp file was written before the rename; the live pointer is only the rename target.
    expect(writes).toContain(`${ptr}.${updated}.tmp`);

    // The current session is unaffected: resolution before the swap still saw INSTALLED.
    // (Proven by the second boot below picking up the swap.)
    const nextBoot = await resolveActiveVersion(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      cacheDir: CACHE,
      channel: "stable",
    });
    expect(nextBoot).toBe(updated);
  });

  it("out-of-range release: cache and pointer untouched", async () => {
    const major2 = "2.0.0";
    const { io, files, writes, renames } = makeIO({
      releaseVersions: { [major2]: bundleBytesFor(major2) },
      latestInRange: major2, // the major line advertised is a DIFFERENT major
    });

    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });

    expect(res).toEqual({ status: "up-to-date", version: INSTALLED });
    expect(writes).toEqual([]);
    expect(renames).toEqual([]);
    expect(files[pointerPath(CACHE, PLUGIN)]).toBeUndefined();
  });

  it("already up to date: no download of a bundle, no swap", async () => {
    const { io, writes, renames } = makeIO({
      releaseVersions: { [INSTALLED]: bundleBytesFor(INSTALLED) },
      latestInRange: INSTALLED,
    });
    const res = await backgroundSelfUpdate(io, {
      plugin: PLUGIN,
      installedVersion: INSTALLED,
      repo: REPO,
      cacheDir: CACHE,
      channel: "stable",
    });
    expect(res).toEqual({ status: "up-to-date", version: INSTALLED });
    expect(writes).toEqual([]);
    expect(renames).toEqual([]);
  });

  it("network failure: silent typed error, cache keeps serving, retried later", async () => {
    const { io, files, writes, renames } = makeIO({
      offlineMajors: ["v1"],
      // A previously-cached in-range bundle + pointer must keep serving.
      files: {
        [pointerPath(CACHE, PLUGIN)]: enc(JSON.stringify({ version: INSTALLED })),
      },
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
    // Nothing swapped: the existing pointer is intact for the next boot to retry.
    expect(writes).toEqual([]);
    expect(renames).toEqual([]);
    expect(files[pointerPath(CACHE, PLUGIN)]).toEqual(enc(JSON.stringify({ version: INSTALLED })));
  });

  it("checksum mismatch on the target bundle: no swap (bad bundle never adopted)", async () => {
    const updated = "1.145.0";
    const { io, writes, renames } = makeIO({
      releaseVersions: { [updated]: bundleBytesFor(updated) },
      latestInRange: updated,
    });
    // Corrupt the pinned bundle bytes AFTER the manifest hash is computed so the
    // downloaded payload no longer matches its manifest.
    const realDownload = io.download.bind(io);
    io.download = async (url) => {
      const bytes = await realDownload(url);
      return url.endsWith(bundleAssetName(PLUGIN)) ? enc("tampered") : bytes;
    };
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
    const { io, writes } = makeIO({ latestInRange: "1.145.0", releaseVersions: { "1.145.0": bundleBytesFor("1.145.0") } });
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
