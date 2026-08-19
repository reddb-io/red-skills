// published-entry.test.ts — WHICH VERSION a Worker would report (#2808, #2909).
//
// The resolver used to answer with a bundle PATH, and falling back to the
// caller's own bundle is what turned a detectable skew into a wider one. ADR
// 0147 deleted that bundle and ADR 0148 gave the launch to the daemon, so the
// path half is gone; what is pinned here is the half the engine floor and the
// fleet-truth probe still ask — the version, and the refusal to answer it with a
// stale one.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isLocalDevBuild,
  publishedEntryVersion,
  type PublishedEntryLookup,
} from "../src/runtime/published-entry.js";
import { resolvePublishedDevBundleVersion } from "../src/core/bundle-version.js";
import { runFleetTruthProbe } from "../src/core/operational-probes/fleet-truth.js";

const dirs: string[] = [];

// The asking process poses as the stranded project of #2808: an MCP server on a
// plugin-cache bundle OLDER than the release published underneath it.
const STALE = "2.87.5";
const PUBLISHED = "2.87.7";

function stranded(overrides: PublishedEntryLookup = {}): PublishedEntryLookup {
  return {
    installedVersion: STALE,
    env: {},
    resolvePublished: () => PUBLISHED,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "published-entry-"));
  dirs.push(value);
  return value;
}

describe("published entry version (#2808)", () => {
  it("names the published version, not the asking process's own", () => {
    expect(publishedEntryVersion(stranded())).toBe(PUBLISHED);
  });

  it("leaves a local source build reporting its own build, never a cached release", () => {
    expect(isLocalDevBuild("3.4.0-dev.1")).toBe(true);
    expect(publishedEntryVersion(stranded({ installedVersion: "3.4.0-dev.1" }))).toBe("3.4.0-dev.1");
  });

  it("reports the asking bundle when the published version cannot be resolved", () => {
    // Unknown reads as unknown. A stamp that invented a number here would be the
    // silent fallback #2808 is about, wearing a version surface.
    expect(publishedEntryVersion(stranded({ resolvePublished: () => undefined }))).toBe(STALE);
    expect(publishedEntryVersion(stranded({ resolvePublished: () => "not-a-version" }))).toBe(STALE);
  });

  it("reports the asking bundle when the resolver throws rather than propagating", () => {
    expect(
      publishedEntryVersion(stranded({
        resolvePublished: () => {
          throw new Error("registry unreachable");
        },
      })),
    ).toBe(STALE);
  });
});

describe("the prescribed fix clears the finding it is prescribed for (#2808)", () => {
  it("reports the version the boot probe resolves as published", async () => {
    const cache = await root();
    await writeFile(join(cache, `dev-${PUBLISHED}.bundle.min.mjs`), "//published\n", "utf8");
    const env = { RED_SKILLS_CACHE_DIR: cache };

    // The probe's `latestBundleVersion` and the version a Worker reports are ONE
    // function, so a restart cannot land on a version the probe still calls
    // skewed.
    const probePublished = resolvePublishedDevBundleVersion(STALE, env);
    const entryVersion = publishedEntryVersion({
      installedVersion: STALE,
      env,
      resolvePublished: resolvePublishedDevBundleVersion,
    });

    expect(probePublished).toBe(PUBLISHED);
    expect(entryVersion).toBe(probePublished);

    const probe = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: {
        supervisorPid: 4242,
        supervisorPidLive: true,
        nowMs: 10_000,
        heartbeatEpochMs: 9_000,
        heartbeatStaleMs: 300_000,
        bundleVersion: entryVersion,
        latestBundleVersion: probePublished,
      },
    });
    expect(probe.evidence).not.toContain("version_skew");
    expect(probe.verdict).not.toBe("red");
  });
});
