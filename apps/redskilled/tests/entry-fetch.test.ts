// A host that has never cached the bundle had nothing to auto-spawn: the entry
// resolver walked local paths only, so rule 7's "a daemon starts on first use"
// did not hold there — and `/red-setup` answered by telling the operator to run
// `redskilled provision`, the binary that does not exist yet (#2961).
import { mkdtemp, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isResolvedRedskilledEntry, REDSKILLED_BUNDLE_ASSET } from "../src/daemon-entry.js";
import {
  ensureRedskilledEntry,
  redskilledBundleCacheDir,
  resolveRedskilledFetchVersion,
} from "../src/entry-fetch.js";
import type { BundleIO } from "@reddb-io/shared/bundle-fetch.js";

/** Registry metadata shaped like npm's, so version discovery has an answer. */
const REGISTRY_JSON = JSON.stringify({
  "dist-tags": { latest: "3.3.19" },
  versions: { "3.3.17": {}, "3.3.18": {}, "3.3.19": {}, "4.0.0-rc.1": {} },
});

async function bareHost(): Promise<{ env: NodeJS.ProcessEnv; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-entry-fetch-"));
  const cacheDir = join(root, "bundles");
  await mkdir(cacheDir, { recursive: true });
  // No RED_SKILLS_* plugin roots, no repo, no cached bundle: the shape of a
  // machine that has never run any of this.
  return { env: { HOME: root, RED_SKILLS_CACHE_DIR: cacheDir }, cacheDir };
}

/** A fetch that lands the bundle where the resolver already looks.
 *
 * `exists` reports FALSE until `materialize` has run, because `ensureBundle` is
 * cache-first: an IO that claims the bundle is already there short-circuits the
 * fetch, and the test would pass while proving nothing. */
function fetchingIO(cacheDir: string, onFetch: (spec: string) => void): BundleIO {
  let landed = false;
  return {
    async materialize(spec) {
      onFetch(spec);
      landed = true;
      await writeFile(join(cacheDir, REDSKILLED_BUNDLE_ASSET), "// bundle\n", "utf8");
      return cacheDir;
    },
    async readFile() {
      return new Uint8Array(Buffer.from("// bundle\n", "utf8"));
    },
    async writeFile(path, bytes) {
      await writeFile(path, Buffer.from(bytes));
    },
    async exists() {
      return landed;
    },
    sha256() {
      return "";
    },
    async fetchText() {
      return REGISTRY_JSON;
    },
    async rename(from, to) {
      await rename(from, to);
    },
  };
}

describe("the daemon entry resolves on a host that has never cached a bundle", () => {
  it("is unresolved without the fetch rung — the state that dead-ended /red-setup", async () => {
    const { env } = await bareHost();
    // No fetch offered: this is the behaviour that shipped, reproduced.
    const resolution = await ensureRedskilledEntry(
      {},
      { env },
      {
        env,
        bundleIO: {
          async materialize() {
            throw new Error("registry unreachable");
          },
          async readFile() {
            return new Uint8Array();
          },
          async writeFile() {},
          async exists() {
            return false;
          },
          sha256() {
            return "";
          },
          async fetchText() {
            return REGISTRY_JSON;
          },
        },
      },
    );
    expect(isResolvedRedskilledEntry(resolution)).toBe(false);
  });

  it("fetches the published bundle and then resolves", async () => {
    const { env, cacheDir } = await bareHost();
    let fetched = 0;
    const resolution = await ensureRedskilledEntry({}, { env }, { env, bundleIO: fetchingIO(cacheDir, () => { fetched += 1; }) });

    expect(fetched).toBe(1);
    expect(isResolvedRedskilledEntry(resolution)).toBe(true);
  });

  it("prefers a local entry and never fetches over it", async () => {
    const { env, cacheDir } = await bareHost();
    // A checkout's own bundle must win: a developer running from source must not
    // silently get the published one instead of the code in front of them.
    const local = join(cacheDir, REDSKILLED_BUNDLE_ASSET);
    await writeFile(local, "// local bundle\n", "utf8");

    let fetched = 0;
    const resolution = await ensureRedskilledEntry({}, { env }, { env, bundleIO: fetchingIO(cacheDir, () => { fetched += 1; }) });

    expect(fetched).toBe(0);
    expect(isResolvedRedskilledEntry(resolution)).toBe(true);
  });

  it("keeps the caller's diagnostic when the fetch itself cannot run", async () => {
    const { env } = await bareHost();
    const resolution = await ensureRedskilledEntry(
      {},
      { env },
      {
        env,
        bundleIO: {
          async materialize() {
            throw new Error("offline");
          },
          async readFile() {
            return new Uint8Array();
          },
          async writeFile() {},
          async exists() {
            return false;
          },
          sha256() {
            return "";
          },
          async fetchText() {
            return REGISTRY_JSON;
          },
        },
      },
    );
    // Unresolved, and still carrying the resolver's own account of where it
    // looked — more useful to an operator than "npm failed".
    expect(isResolvedRedskilledEntry(resolution)).toBe(false);
  });

  it("caches into the directory the resolver already searches", async () => {
    const { env, cacheDir } = await bareHost();
    expect(redskilledBundleCacheDir(env)).toBe(cacheDir);
  });
});

// The self-healing rung ran once, wrote `redskilled-.bundle.min.mjs`, and
// disabled itself: the file no resolver prefers is the file whose existence
// satisfies the cache-first test forever (#3153).
describe("the fetch names a version instead of spelling absent as an empty string", () => {
  it("materialises a VERSIONED filename, never the holed one", async () => {
    const { env, cacheDir } = await bareHost();
    const specs: string[] = [];
    await ensureRedskilledEntry({}, { env }, { env, bundleIO: fetchingIO(cacheDir, (s) => specs.push(s)) });

    // `@reddb-io/red-skills@` with nothing after it is what `version: ""` asked
    // npm for, and `redskilled-.bundle.min.mjs` is what it wrote.
    expect(specs).toEqual(["@reddb-io/red-skills@3.3.19"]);
    const listed = await readdir(cacheDir);
    expect(listed).toContain("redskilled-3.3.19.bundle.min.mjs");
    expect(listed).not.toContain("redskilled-.bundle.min.mjs");
    expect(listed.some((n) => n.startsWith(".staging-redskilled-."))).toBe(false);
  });

  it("takes the version from the dev bundle beside it, without a registry", async () => {
    const { cacheDir } = await bareHost();
    // The daemon bundle and the dev bundle are cut from one npm package, so the
    // neighbour is the right answer AND needs no network to read.
    const version = await resolveRedskilledFetchVersion(
      { listCacheDir: () => ["dev-3.3.17.bundle.min.mjs", "dev-3.3.19.bundle.min.mjs", "rsp-3.3.19.bundle.min.mjs"] },
      cacheDir,
    );
    expect(version).toBe("3.3.19");
  });

  it("skips prereleases when it falls back to the registry", async () => {
    const { cacheDir } = await bareHost();
    const version = await resolveRedskilledFetchVersion(
      { listCacheDir: () => [], bundleIO: fetchingIO(cacheDir, () => {}) },
      cacheDir,
    );
    // 4.0.0-rc.1 is published; it is not a release an operator is moved onto.
    expect(version).toBe("3.3.19");
  });

  it("refuses to fetch at all when no version can be told", async () => {
    const { env, cacheDir } = await bareHost();
    let fetched = 0;
    const io = fetchingIO(cacheDir, () => { fetched += 1; });
    const resolution = await ensureRedskilledEntry(
      {},
      { env },
      {
        env,
        listCacheDir: () => [],
        // Offline: the registry cannot be asked, so the version is unknown —
        // and unknown is not a licence to invent a cache key.
        bundleIO: { ...io, async fetchText() { throw new Error("offline"); } },
      },
    );
    expect(fetched).toBe(0);
    expect(isResolvedRedskilledEntry(resolution)).toBe(false);
  });

  it("still fetches on a host already holding the unversioned entry, and retires it", async () => {
    const { env, cacheDir } = await bareHost();
    // Exactly the state both reported hosts were left in. A fix that only
    // prevents new ones repairs neither.
    await writeFile(join(cacheDir, "redskilled-.bundle.min.mjs"), "// poisoned\n", "utf8");

    let fetched = 0;
    await ensureRedskilledEntry({}, { env }, { env, bundleIO: fetchingIO(cacheDir, () => { fetched += 1; }) });

    expect(fetched).toBe(1);
    const listed = await readdir(cacheDir);
    expect(listed).toContain("redskilled-3.3.19.bundle.min.mjs");
    // Retired out of the `redskilled*.bundle.min.mjs` glob the statusline
    // render command uses (ADR 0130 rule 10) — a quarantine inside the glob is
    // not a quarantine.
    expect(listed).not.toContain("redskilled-.bundle.min.mjs");
    expect(listed).toContain("redskilled-.bundle.min.mjs.unversioned");
  });
});
