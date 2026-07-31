// published-entry.test.ts — WHICH BUNDLE a project's Worker runs (#2808, #2909).
//
// The resolver used to answer for a launch; ADR 0130 Amendment 4 removed the
// per-project process, and the question survived it — a REGISTRATION states what
// to run, and it needs the same published-first resolution and the same loud
// refusal. Falling back to the caller's own bundle is what turned a detectable
// skew into a wider one.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PUBLISHED_ENTRY_UNRESOLVED,
  PUBLISHED_VERSION_UNRESOLVED,
  PublishedEntryError,
  publishedBundleArgv,
  publishedEntryVersion,
  resolveDevScriptPath,
  resolvePublishedEntry,
  type PublishedEntryLookup,
} from "../src/runtime/published-entry.js";
import { resolvePublishedDevBundleVersion } from "../src/core/bundle-version.js";
import { runFleetTruthProbe } from "../src/core/operational-probes/fleet-truth.js";

const dirs: string[] = [];

// The resolving process poses as the stranded project of #2808: an MCP server on
// a plugin-cache bundle OLDER than the release published underneath it.
const STALE = "2.87.5";
const PUBLISHED = "2.87.7";
const CACHE = "/cache/red-skills/bundles";
const CALLER = "/plugin-cache/dist/castle-mcp.bundle.min.mjs";
const publishedBundle = join(CACHE, `dev-${PUBLISHED}.bundle.min.mjs`);

function stranded(overrides: PublishedEntryLookup = {}): PublishedEntryLookup {
  return {
    callerEntry: CALLER,
    execPath: "/usr/bin/node",
    installedVersion: STALE,
    env: { RED_SKILLS_CACHE_DIR: CACHE },
    resolvePublished: () => PUBLISHED,
    exists: (path) => path === publishedBundle,
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

describe("published entry resolution (#2808)", () => {
  it("names the published bundle, not the resolving process's own", () => {
    const entry = resolvePublishedEntry(stranded());

    expect(entry.command).toBe("/usr/bin/node");
    expect(entry.args[0]).toBe(publishedBundle);
    expect(entry.args.join(" ")).not.toContain("castle-mcp");
    expect(entry.args.join(" ")).not.toContain(STALE);
    expect(entry.version).toBe(PUBLISHED);
    expect(entry.source).toBe("bundle-cache");
    expect(publishedEntryVersion(stranded())).toBe(PUBLISHED);
  });

  it("hands a registration the same answer as a bare argv head", () => {
    // One resolver, two callers: a registration that named a different bundle
    // from the one this project publishes is how a release strands a project.
    expect(publishedBundleArgv(stranded())).toEqual(["/usr/bin/node", publishedBundle]);
  });

  it("falls forward to a version-pinned dispatch when the published bundle is cached nowhere", () => {
    const entry = resolvePublishedEntry(stranded({ exists: () => false }));

    expect(entry.version).toBe(PUBLISHED);
    expect(entry.source).toBe("pinned-dispatch");
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "-p", `@reddb-io/red-skills@${PUBLISHED}`, "red-skills-dev"]);
  });

  it("runs the caller's own entry when it is already at the published version", () => {
    const entry = resolvePublishedEntry(stranded({
      installedVersion: PUBLISHED,
      exists: () => false,
    }));

    expect(entry.source).toBe("caller-entry");
    expect(entry.version).toBe(PUBLISHED);
    expect(entry.args[0]).toBe(join("/plugin-cache/dist", "dev.bundle.min.mjs"));
  });

  it("leaves a local source build running its own bundle, never a cached release", () => {
    const entry = resolvePublishedEntry(stranded({
      installedVersion: "0.0.0-dev",
      callerEntry: "/repo/apps/dev/dist/cli.js",
    }));

    expect(entry.source).toBe("local-build");
    expect(entry.version).toBe("0.0.0-dev");
    expect(entry.args[0]).toBe("/repo/apps/dev/dist/cli.js");
  });
});

describe("published-version failures are loud (#2808)", () => {
  it("names the resolving bundle it refused to fall back to", () => {
    try {
      resolvePublishedEntry(stranded({ resolvePublished: () => undefined }));
      expect.unreachable("resolution must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PublishedEntryError);
      const failure = error as PublishedEntryError;
      expect(failure.code).toBe(PUBLISHED_VERSION_UNRESOLVED);
      expect(failure.message).toContain(STALE);
      expect(failure.message).toContain("caller's own bundle");
    }
  });

  it("refuses loudly, listing what it probed, when no entry runs the published version", () => {
    try {
      resolvePublishedEntry(stranded({
        exists: () => false,
        env: { RED_SKILLS_CACHE_DIR: CACHE, RED_SKILLS_NO_PINNED_DISPATCH: "1" },
      }));
      expect.unreachable("resolution must throw");
    } catch (error) {
      const failure = error as PublishedEntryError;
      expect(failure.code).toBe(PUBLISHED_ENTRY_UNRESOLVED);
      expect(failure.searched).toContain(publishedBundle);
    }
  });
});

describe("the dev bundle beside an MCP bundle (#2677)", () => {
  it("redirects the shipped castle-mcp bundle to its sibling dev bundle", () => {
    expect(resolveDevScriptPath(join("dist", "castle-mcp.bundle.min.mjs")))
      .toBe(join("dist", "dev.bundle.min.mjs"));
  });

  it("redirects a cache-keyed castle-mcp bundle to the dev bundle of the same version", () => {
    expect(resolveDevScriptPath(join("cache", "castle-mcp-2.76.1.bundle.min.mjs")))
      .toBe(join("cache", "dev-2.76.1.bundle.min.mjs"));
  });

  it("leaves an entry that already routes worker subcommands untouched", () => {
    const devBundle = join("dist", "dev.bundle.min.mjs");
    expect(resolveDevScriptPath(devBundle)).toBe(devBundle);
    const shim = join("node_modules", ".bin", "red-skills-dev");
    expect(resolveDevScriptPath(shim)).toBe(shim);
  });
});

describe("the prescribed fix clears the finding it is prescribed for (#2808)", () => {
  it("reports the version the boot probe resolves as published", async () => {
    const cache = await root();
    await writeFile(join(cache, `dev-${PUBLISHED}.bundle.min.mjs`), "//published\n", "utf8");
    const env = { RED_SKILLS_CACHE_DIR: cache };

    // The probe's `latestBundleVersion` and the registration's target version are
    // one function, so a re-registration cannot land on a version the probe still
    // calls skewed.
    const probePublished = resolvePublishedDevBundleVersion(STALE, env);
    const entryVersion = resolvePublishedEntry({
      ...stranded(),
      env,
      resolvePublished: resolvePublishedDevBundleVersion,
      exists: () => false,
    }).version;

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
