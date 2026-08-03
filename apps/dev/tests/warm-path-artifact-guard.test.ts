// warm-path-artifact-guard — does the file that WARMS know about the companion?
//
// **A fix that ships in the bundle lane cannot repair the lane that fetches
// bundles.** #3074 made `redskilled` a companion of the `dev` warm path by
// editing `companionBundlePlugins` in `packages/shared/bundle-fetch.ts`. Every
// test that read that function went green. The thing that actually runs on a
// host is `plugins/dev/hooks/red-fetch.mjs`, an esbuild bundle of the same
// module CHECKED IN beside the plugin manifest — and it was never rebuilt, so
// it kept answering `["rsp"]` in every published version. The daemon bundle was
// never warmed on any machine, on any release, for the whole life of the fix.
//
// The source and the artifact are two lanes and only one was watched, which is
// the same shape as #3147. This guard watches the second one: the companion set
// the SHIPPED fetcher carries, read out of the shipped bytes.
//
// Rebuild with `pnpm -C apps/dev run bundle:red-fetch` when this fails.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { companionBundlePlugins } from "@reddb-io/shared/bundle-fetch.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The fetcher a host executes: the SessionStart hook's checked-in bundle. */
const SHIPPED_FETCHER = join(REPO_ROOT, "plugins", "dev", "hooks", "red-fetch.mjs");

describe("the shipped warm path knows every bundle it is supposed to warm", () => {
  it("carries each companion of the dev warm path in its own bytes", () => {
    expect(existsSync(SHIPPED_FETCHER), SHIPPED_FETCHER).toBe(true);
    const shipped = readFileSync(SHIPPED_FETCHER, "utf8");

    const missing = companionBundlePlugins("dev").filter((plugin) => !shipped.includes(plugin));

    expect(
      missing,
      `${SHIPPED_FETCHER} does not name ${missing.join(", ")}. The checked-in hook bundle is ` +
        "stale relative to packages/shared/bundle-fetch.ts, so the companion is warmed on no host " +
        "at any version (#3153). Rebuild: pnpm -C apps/dev run bundle:red-fetch",
    ).toEqual([]);
  });

  it("cannot mint an unversioned cache entry either", () => {
    // The shipped fetcher is a bundle of the same module, so it must carry the
    // refusal too — an artifact with the guard missing is an artifact that can
    // still write `<plugin>-.bundle.min.mjs` and latch the host shut.
    const shipped = readFileSync(SHIPPED_FETCHER, "utf8");
    expect(shipped).toContain("invalid-version");
  });
});
