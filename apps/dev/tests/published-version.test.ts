import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import {
  PUBLISHED_VERSION_STALE_AFTER_MS,
  publishedVersionRecordPath,
  publishedVersionReport,
  readPublishedBundleVersion,
  readPublishedVersionRecord,
  refreshPublishedBundleVersion,
  resolvePublishedVersion,
  writePublishedVersionRecord,
} from "../src/core/published-version.js";

/**
 * A cache dir AND an empty HOME: the installed-plugin rung reads the operator's
 * plugin cache, so a test that left HOME alone would answer from the developer's
 * own machine instead of its fixture.
 */
function cacheEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "published-version-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { env: { RED_SKILLS_CACHE_DIR: dir, HOME: home } as NodeJS.ProcessEnv, dir };
}

/** Install plugin `version` the way an operator upgrade leaves it on disk. */
function installPlugin(home: string, version: string, agentHome = ".claude"): void {
  mkdirSync(join(home, agentHome, "plugins", "cache", "red-skills", "dev", version, ".claude-plugin"), {
    recursive: true,
  });
}

describe("published version resolution (#2809)", () => {
  it("reports unknown rather than substituting a local value when nothing resolves", () => {
    const observation = resolvePublishedVersion({ nowMs: 1_000 });
    expect(observation).toMatchObject({
      version: null,
      source: "unresolved",
      age_ms: -1,
      stale: true,
      reason: "never-observed",
    });

    // The verdict a surface renders from an unresolved answer: unknown, and NOT
    // a confident `version_skew: 0` derived from a substituted cached value.
    const report = publishedVersionReport("2.87.6", observation);
    expect(report).toMatchObject({
      bundle_latest: "",
      version_unknown: 0,
      published_unknown: 1,
      version_skew: 0,
    });
  });

  it("keeps unknown distinct from a measured match (#2752)", () => {
    const matched = publishedVersionReport(
      "2.87.6",
      resolvePublishedVersion({ fetched: "2.87.6", nowMs: 1_000 }),
    );
    expect(matched).toMatchObject({ published_unknown: 0, version_unknown: 0, version_skew: 0 });

    const unmeasured = publishedVersionReport(
      undefined,
      resolvePublishedVersion({ fetched: "2.87.6", nowMs: 1_000 }),
    );
    expect(unmeasured).toMatchObject({ version_unknown: 1, published_unknown: 0, version_skew: 0 });
  });

  it("carries the staleness of its answer inside the payload", () => {
    const fresh = resolvePublishedVersion({
      record: { version: "2.87.7", observedAtMs: 1_000 },
      nowMs: 1_000 + 60_000,
      staleAfterMs: PUBLISHED_VERSION_STALE_AFTER_MS,
    });
    expect(fresh).toMatchObject({ version: "2.87.7", source: "recorded", age_ms: 60_000, stale: false, reason: "fresh" });

    const agedOut = resolvePublishedVersion({
      record: { version: "2.87.7", observedAtMs: 1_000 },
      nowMs: 1_000 + PUBLISHED_VERSION_STALE_AFTER_MS + 1,
      staleAfterMs: PUBLISHED_VERSION_STALE_AFTER_MS,
    });
    expect(agedOut).toMatchObject({ source: "recorded", stale: true, reason: "aged-out" });

    // A bundle in the cache proves publication, never currency — it can never
    // present as a current answer.
    const cacheOnly = resolvePublishedVersion({ cached: "2.87.5", nowMs: 1_000 });
    expect(cacheOnly).toMatchObject({ version: "2.87.5", source: "bundle-cache", stale: true, reason: "cache-only" });
    expect(publishedVersionReport("2.87.6", cacheOnly).published_version).toMatchObject({
      version: "2.87.5",
      source: "bundle-cache",
      stale: true,
    });
  });

  it("prefers a live registry read over the recorded and cached evidence", () => {
    const observation = resolvePublishedVersion({
      fetched: "2.87.7",
      record: { version: "2.87.5", observedAtMs: 0 },
      cached: "2.87.5",
      nowMs: 1_000,
    });
    expect(observation).toMatchObject({ version: "2.87.7", source: "registry", age_ms: 0, stale: false });
  });

  it("round-trips the recorded registry answer through the shared TOON record", () => {
    const { env, dir } = cacheEnv();
    try {
      writePublishedVersionRecord({ version: "2.87.7", observedAtMs: 12_345 }, env);
      expect(decode(readFileSync(publishedVersionRecordPath(env), "utf8"))).toMatchObject({
        version: "2.87.7",
        observed_at_ms: 12_345,
      });
      expect(readPublishedVersionRecord(env)).toEqual({ version: "2.87.7", observedAtMs: 12_345 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays the recorded registry answer even when the bundle cache lags behind it", () => {
    const { env, dir } = cacheEnv();
    try {
      // The reported outage: the cache lane held 2.87.5 while the registry had
      // already published 2.87.7.
      writeFileSync(join(dir, "dev-2.87.5.bundle.min.mjs"), "", "utf8");
      writePublishedVersionRecord({ version: "2.87.7", observedAtMs: 5_000 }, env);
      expect(readPublishedBundleVersion(env, 5_000)).toMatchObject({
        version: "2.87.7",
        source: "recorded",
        stale: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the newest cached bundle, independent of who is asking", () => {
    const { env, dir } = cacheEnv();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "dev-2.87.5.bundle.min.mjs"), "", "utf8");
      writeFileSync(join(dir, "dev-2.86.0.bundle.min.mjs"), "", "utf8");
      expect(readPublishedBundleVersion(env, 5_000)).toMatchObject({
        version: "2.87.5",
        source: "bundle-cache",
        stale: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts the installed plugin as evidence in its own right (#2924)", () => {
    const installed = resolvePublishedVersion({ installed: "3.0.4", nowMs: 1_000 });
    expect(installed).toMatchObject({
      version: "3.0.4",
      source: "installed-plugin",
      age_ms: -1,
      stale: true,
      reason: "installed-only",
    });

    // Above the bundle cache: an installed plugin is an operator's decision, a
    // cached bundle only a byproduct of having once run that version.
    expect(resolvePublishedVersion({ installed: "3.0.4", cached: "3.0.3", nowMs: 1_000 })).toMatchObject({
      version: "3.0.4",
      source: "installed-plugin",
    });

    // Below a live registry read and below a fresh recorded one.
    expect(
      resolvePublishedVersion({ fetched: "3.0.5", installed: "3.0.4", nowMs: 1_000 }),
    ).toMatchObject({ version: "3.0.5", source: "registry" });
    expect(
      resolvePublishedVersion({
        record: { version: "3.0.5", observedAtMs: 1_000 },
        installed: "3.0.4",
        nowMs: 1_000 + 60_000,
      }),
    ).toMatchObject({ version: "3.0.5", source: "recorded", stale: false });

    // An aged-out record that already proved a NEWER publication keeps the
    // answer — the installed rung adds intent, it must not walk a version back.
    expect(
      resolvePublishedVersion({
        record: { version: "3.0.5", observedAtMs: 0 },
        installed: "3.0.4",
        nowMs: PUBLISHED_VERSION_STALE_AFTER_MS + 1,
      }),
    ).toMatchObject({ version: "3.0.5", source: "recorded", reason: "aged-out" });

    // Nothing at all still answers unknown — never a substituted version (#2809).
    expect(resolvePublishedVersion({ nowMs: 1_000 })).toMatchObject({ version: null, source: "unresolved" });
  });

  it("reads the operator's installed plugin instead of reporting a stale cache-only bundle (#2924)", () => {
    const { env, dir } = cacheEnv();
    try {
      // The observed case: the operator updated the plugin to 3.0.4 while this
      // host's newest cached bundle is still 3.0.3.
      writeFileSync(join(dir, "dev-3.0.3.bundle.min.mjs"), "", "utf8");
      for (const version of ["2.88.0", "3.0.0", "3.0.1", "3.0.3", "3.0.4"]) {
        installPlugin(join(dir, "home"), version);
      }
      expect(readPublishedBundleVersion(env, 5_000)).toMatchObject({
        version: "3.0.4",
        source: "installed-plugin",
        stale: true,
        reason: "installed-only",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees a plugin installed under either agent home", () => {
    const { env, dir } = cacheEnv();
    try {
      installPlugin(join(dir, "home"), "3.0.1", ".claude");
      installPlugin(join(dir, "home"), "3.0.4", ".codex");
      expect(readPublishedBundleVersion(env, 5_000)).toMatchObject({
        version: "3.0.4",
        source: "installed-plugin",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the registry answer it paid for, so later local reads replay it", async () => {
    const { env, dir } = cacheEnv();
    try {
      const refreshed = await refreshPublishedBundleVersion("2.87.6", env, 9_000, async () => "2.87.7");
      expect(refreshed).toMatchObject({ version: "2.87.7", source: "registry", stale: false });
      expect(readPublishedBundleVersion(env, 9_000)).toMatchObject({ version: "2.87.7", source: "recorded" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the answer unknown when the registry read yields nothing", async () => {
    const { env, dir } = cacheEnv();
    try {
      const refreshed = await refreshPublishedBundleVersion("2.87.6", env, 9_000, async () => undefined);
      expect(refreshed).toMatchObject({ version: null, source: "unresolved" });
      expect(readPublishedVersionRecord(env)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
