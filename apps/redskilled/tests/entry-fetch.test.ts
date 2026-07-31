// A host that has never cached the bundle had nothing to auto-spawn: the entry
// resolver walked local paths only, so rule 7's "a daemon starts on first use"
// did not hold there — and `/red-setup` answered by telling the operator to run
// `redskilled provision`, the binary that does not exist yet (#2961).
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isResolvedRedskilledEntry, REDSKILLED_BUNDLE_ASSET } from "../src/daemon-entry.js";
import { ensureRedskilledEntry, redskilledBundleCacheDir } from "../src/entry-fetch.js";
import type { BundleIO } from "@reddb-io/shared/bundle-fetch.js";

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
function fetchingIO(cacheDir: string, onFetch: () => void): BundleIO {
  let landed = false;
  return {
    async materialize() {
      onFetch();
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
      return "";
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
            return "";
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
            return "";
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
