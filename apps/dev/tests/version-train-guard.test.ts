/**
 * The version-train invariant: every workspace carries ONE product version, is
 * written by a release train that will carry it forward, and is named under the
 * `@reddb-io` scope (issue #3082).
 *
 * The live-tree assertions are the ratchet; the fixtures are the proof it has
 * teeth. A suite that only asserts "the tree is aligned today" cannot tell an
 * aligned tree from a check that never fires — and alignment today is exactly
 * what the herdr plugin had before it drifted eleven patch releases on its own.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTRA_VERSION_ROOTS,
  SCOPE_EXEMPTIONS,
  VERSION_ANCHOR,
  collectWorkspaceManifests,
  describeVersionTrainFailures,
  findCoverageGaps,
  findScopeViolations,
  findVersionDrift,
  readAnchorVersion,
  readChangesetCoverage,
  readVersionBearingFiles,
  readWorkspaceGlobs,
  type WorkspaceManifest,
} from "../src/core/version-train-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function manifest(overrides: Partial<WorkspaceManifest> & { name: string }): WorkspaceManifest {
  return {
    relativePath: `apps/${overrides.name.replace("@reddb-io/", "")}/package.json`,
    version: "3.3.9",
    isPrivate: true,
    ...overrides,
  };
}

describe("version-train discovery (#3082)", () => {
  it("derives the package set from the pnpm workspace, not from a hand-kept array", () => {
    const globs = readWorkspaceGlobs(REPO_ROOT);

    expect(globs).toContain("apps/*");
    expect(globs).toContain("packages/*");
  });

  it("sweeps the plugin definitions too — they are on the train but not in the workspace", () => {
    expect(EXTRA_VERSION_ROOTS.map((root) => root.glob)).toContain("plugins/*");
    for (const root of EXTRA_VERSION_ROOTS) expect(root.why.trim().length).toBeGreaterThan(20);
  });

  it("finds the root, every app, every package and every plugin", () => {
    const paths = collectWorkspaceManifests(REPO_ROOT).map((found) => found.relativePath);

    expect(paths).toContain("package.json");
    expect(paths).toContain("apps/dev/package.json");
    expect(paths).toContain("packages/shared/package.json");
    expect(paths).toContain("plugins/dev/package.json");
    // The two surfaces the defect was measured on.
    expect(paths).toContain("apps/vscode-extension-red-skills/package.json");
    expect(paths).toContain("apps/herdr-plugin-red-skills/package.json");
  });
});

describe("version-train detection", () => {
  it("flags a manifest behind the product version", () => {
    const drift = findVersionDrift([manifest({ name: "@reddb-io/stale", version: "0.1.0" })], "3.3.9");

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ name: "@reddb-io/stale", version: "0.1.0" });
  });

  it("flags a manifest no train writes — the herdr-plugin failure, exactly", () => {
    const gaps = findCoverageGaps([manifest({ name: "@reddb-io/orphan" })], {
      fixedNames: ["@reddb-io/dev"],
      ignoredNames: [],
      versionBearingFiles: ["package.json"],
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0].name).toBe("@reddb-io/orphan");
  });

  it("counts a package as covered by the fixed group OR by the sync script", () => {
    const both = [
      manifest({ name: "@reddb-io/bumped" }),
      manifest({ name: "@reddb-io/written", relativePath: "plugins/written/package.json" }),
    ];

    expect(
      findCoverageGaps(both, {
        fixedNames: ["@reddb-io/bumped"],
        ignoredNames: [],
        versionBearingFiles: ["plugins/written/package.json"],
      }),
    ).toEqual([]);
  });

  it("treats `ignore` as the opposite of coverage — an aligned-today ignored package still fails", () => {
    const gaps = findCoverageGaps([manifest({ name: "@reddb-io/ignored" })], {
      fixedNames: [],
      ignoredNames: ["@reddb-io/ignored"],
      versionBearingFiles: [],
    });

    expect(gaps).toHaveLength(1);
  });

  it("flags an unscoped workspace, and honours a stated exemption", () => {
    const packages = [manifest({ name: "rogue" }), manifest({ name: "@reddb-io/fine" })];

    expect(findScopeViolations(packages)).toEqual([
      { relativePath: "apps/rogue/package.json", name: "rogue" },
    ]);
    expect(findScopeViolations(packages, [{ name: "rogue", why: "stated" }])).toEqual([]);
  });

  it("names the file, the package and the repair in its failure message", () => {
    const message = describeVersionTrainFailures(
      "3.3.9",
      [{ relativePath: "apps/x/package.json", name: "@reddb-io/x", version: "0.1.0" }],
      [{ relativePath: "apps/y/package.json", name: "@reddb-io/y" }],
      [{ relativePath: "apps/z/package.json", name: "z" }],
    );

    expect(message).toContain("apps/x/package.json");
    expect(message).toContain("pnpm version:sync");
    expect(message).toContain("VERSION_BEARING_FILES");
    expect(message).toContain("SCOPE_EXEMPTIONS");
  });
});

describe("the exemptions are stated, not assumed", () => {
  it("gives every scope exemption a reason", () => {
    for (const exemption of SCOPE_EXEMPTIONS) {
      expect(exemption.why.trim().length, `${exemption.name} states no reason`).toBeGreaterThan(20);
    }
  });

  it("exempts only PRIVATE packages — a published one must carry the scope npm enforces", () => {
    const byName = new Map(collectWorkspaceManifests(REPO_ROOT).map((found) => [found.name, found]));
    for (const exemption of SCOPE_EXEMPTIONS) {
      const found = byName.get(exemption.name);
      expect(found, `${exemption.name} is exempted but is not a workspace`).toBeDefined();
      expect(found!.isPrivate, `${exemption.name} is published and cannot skip the scope`).toBe(true);
    }
  });
});

describe("the live tree", () => {
  it("carries the product version in every workspace manifest", () => {
    const manifests = collectWorkspaceManifests(REPO_ROOT);
    const anchorVersion = readAnchorVersion(REPO_ROOT);
    const drift = findVersionDrift(manifests, anchorVersion);

    expect(drift, describeVersionTrainFailures(anchorVersion, drift, [], [])).toEqual([]);
  });

  it("puts every workspace on a release train that will carry it forward", async () => {
    const manifests = collectWorkspaceManifests(REPO_ROOT);
    const changesets = readChangesetCoverage(REPO_ROOT);
    const gaps = findCoverageGaps(manifests, {
      ...changesets,
      versionBearingFiles: await readVersionBearingFiles(REPO_ROOT),
    });

    expect(gaps, describeVersionTrainFailures("", [], gaps, [])).toEqual([]);
  });

  it("writes the marketplace-visible surfaces through the sync script", async () => {
    const files = await readVersionBearingFiles(REPO_ROOT);

    // The field the VS Code marketplace and the .vsix show.
    expect(files).toContain("apps/vscode-extension-red-skills/package.json");
    // The herdr plugin's own manifest — the version herdr installs by.
    expect(files).toContain("apps/herdr-plugin-red-skills/herdr-plugin.toml");
  });

  it("keeps the anchor a fixed-group member, so changesets writes it first", () => {
    const manifests = collectWorkspaceManifests(REPO_ROOT);
    const anchor = manifests.find((found) => found.relativePath === VERSION_ANCHOR);

    expect(anchor, `the anchor ${VERSION_ANCHOR} is not a discovered workspace`).toBeDefined();
    expect(readChangesetCoverage(REPO_ROOT).fixedNames).toContain(anchor!.name);
  });

  it("leaves nothing in changesets `ignore` — an ignored package is one off the train", () => {
    expect(readChangesetCoverage(REPO_ROOT).ignoredNames).toEqual([]);
  });

  it("names every workspace under the @reddb-io scope", () => {
    const violations = findScopeViolations(collectWorkspaceManifests(REPO_ROOT));

    expect(violations, describeVersionTrainFailures("", [], [], violations)).toEqual([]);
  });

  it("runs in every gate cone — the version train spans the whole repo", () => {
    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name)).toContain("invariants:version-train");
  });
});
