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
// Rebuild with `pnpm -C apps/plugin-dev run bundle:red-fetch` when this fails.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DEV_WARM_BUNDLE, companionBundlePlugins } from "@reddb-io/shared/bundle-fetch.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The fetcher a host executes: the SessionStart hook's checked-in bundle. */
const SHIPPED_FETCHER = join(REPO_ROOT, "plugins", "dev", "hooks", "red-fetch.mjs");

/** The SessionStart hook definitions that name the bundle to warm. */
const HOOK_DEFINITIONS = ["claude.hooks.json", "codex.hooks.json"];

/** Anchor first, then the siblings that ride in the same npm package. */
const WARM_SET = [DEV_WARM_BUNDLE, ...companionBundlePlugins(DEV_WARM_BUNDLE)];

describe("the shipped warm path knows every bundle it is supposed to warm", () => {
  it("carries each bundle of the dev warm path in its own bytes", () => {
    expect(existsSync(SHIPPED_FETCHER), SHIPPED_FETCHER).toBe(true);
    const shipped = readFileSync(SHIPPED_FETCHER, "utf8");

    const missing = WARM_SET.filter((plugin) => !shipped.includes(plugin));

    expect(
      missing,
      `${SHIPPED_FETCHER} does not name ${missing.join(", ")}. The checked-in hook bundle is ` +
        "stale relative to packages/shared/bundle-fetch.ts, so the companion is warmed on no host " +
        "at any version (#3153). Rebuild: pnpm -C apps/plugin-dev run bundle:red-fetch",
    ).toEqual([]);
  });

  /**
   * **A warm path may only name a bundle the release builds.** The dev plugin's
   * hook asked for `dev` for one release past the deletion of the dev runtime
   * bundle, so every session failed `bundle-missing`, the detached self-update
   * wrote that failure into its status file, and the AFK coherence probe read a
   * hours-old updater error as a reason to refuse work (#4112). The hook argv
   * and the release's payload list are two lanes; this pins them together.
   */
  it("fetches a bundle the release actually publishes", async () => {
    // Imported by URL rather than by specifier: the declared payload list is a
    // plain `.mjs` the release workflow reads, and this test wants the same
    // enumeration rather than a restatement of it.
    const { WORKSTATION_PAYLOADS } = (await import(
      pathToFileURL(join(REPO_ROOT, "scripts", "workstation-package-set.mjs")).href
    )) as { WORKSTATION_PAYLOADS: readonly { asset: string }[] };

    const built = new Set(
      WORKSTATION_PAYLOADS.map(
        (payload) => /^dist\/(.+)\.bundle\.min\.mjs$/.exec(payload.asset)?.[1],
      ).filter((name): name is string => Boolean(name)),
    );

    const unpublished = WARM_SET.filter((plugin) => !built.has(plugin));
    expect(
      unpublished,
      `the dev warm path names ${unpublished.join(", ")}, which scripts/workstation-package-set.mjs ` +
        "does not build — a fetch for it can only ever fail `bundle-missing` (#4112)",
    ).toEqual([]);

    for (const hook of HOOK_DEFINITIONS) {
      const path = join(REPO_ROOT, "plugins", "dev", "hooks", hook);
      expect(readFileSync(path, "utf8"), path).toContain(`node \\"$f\\" ${DEV_WARM_BUNDLE} \\"$ver\\"`);
    }
  });

  it("cannot mint an unversioned cache entry either", () => {
    // The shipped fetcher is a bundle of the same module, so it must carry the
    // refusal too — an artifact with the guard missing is an artifact that can
    // still write `<plugin>-.bundle.min.mjs` and latch the host shut.
    const shipped = readFileSync(SHIPPED_FETCHER, "utf8");
    expect(shipped).toContain("invalid-version");
  });
});
