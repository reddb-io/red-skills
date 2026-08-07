import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_WORKFLOW_PATH,
  VENDORED_RELEASE_BUNDLE_PATH,
  generateReleaseWorkflows,
  renderReleaseWorkflow,
} from "../src/workflow-generator.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "workflows");
const ENGINE_VERSION = "3.9.0";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release workflow generator", () => {
  for (const trigger of ["version-pr", "auto"] as const) {
    for (const execution of ["pinned", "vendored"] as const) {
      it(`pins the ${trigger} ${execution} workflow golden file`, () => {
        const generated = renderReleaseWorkflow({
          trigger,
          execution,
          engineVersion: ENGINE_VERSION,
        });
        const suffix = execution === "pinned" ? "" : "-vendored";
        const golden = readFileSync(join(FIXTURES, `${trigger}${suffix}.yml`), "utf8");

        expect(generated).toBe(golden);
      });
    }
  }

  it("uses only the default token, explicit least privilege, and the canonical pinned npx form", () => {
    const versionPullRequest = renderReleaseWorkflow({
      trigger: "version-pr",
      execution: "pinned",
      engineVersion: ENGINE_VERSION,
    });
    const auto = renderReleaseWorkflow({
      trigger: "auto",
      execution: "pinned",
      engineVersion: ENGINE_VERSION,
    });

    for (const source of [versionPullRequest, auto]) {
      const workflow = parse(source) as {
        permissions: Record<string, never>;
        jobs: Record<string, { permissions: Record<string, string> }>;
      };
      expect(workflow.permissions).toEqual({});
      expect(Object.values(workflow.jobs).every((job) => job.permissions !== undefined)).toBe(true);
      expect(source).toContain(
        `npx -y -p @reddb-io/red-skills@${ENGINE_VERSION} red-skills-release run`,
      );
      expect(source).toContain("GITHUB_TOKEN: ${{ github.token }}");
      expect(source.toLowerCase()).not.toContain("pat");
      expect(source).toContain("red-skills-release[bot]");
    }

    expect(versionPullRequest).toContain("pull-requests: write");
    expect(auto).not.toContain("pull-requests: write");
  });

  it("runs the vendored file with the same least-privilege workflow", () => {
    const source = renderReleaseWorkflow({
      trigger: "version-pr",
      execution: "vendored",
      engineVersion: ENGINE_VERSION,
    });
    const workflow = parse(source) as {
      permissions: Record<string, never>;
      jobs: Record<string, { permissions: Record<string, string> }>;
    };

    expect(workflow.permissions).toEqual({});
    expect(Object.values(workflow.jobs).every((job) => job.permissions !== undefined)).toBe(true);
    expect(source).toContain(`node ${VENDORED_RELEASE_BUNDLE_PATH} run`);
    expect(source).not.toContain("npx");
  });

  it("floors the pin at the version that introduced the binary", () => {
    // The generator stamps the version the repo is AT, which is one behind the
    // feature the first time it runs: a repo on 3.8.0 generated a workflow
    // invoking `red-skills-release`, a binary 3.8.0 does not contain, and the
    // release died with `red-skills-release: not found`. An instruction may not
    // point at its own precondition.
    const repository = fixtureRepository("version-pr", "pinned");
    generateReleaseWorkflows({ repoRoot: repository, engineVersion: "3.8.0" });
    const text = readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8");
    expect(text).toContain("@reddb-io/red-skills@3.9.0 red-skills-release run");
    expect(text).not.toContain("@reddb-io/red-skills@3.8.0");
  });

  it("reads the trigger from config, refreshes only the pin, and then becomes a no-op", () => {
    const repository = fixtureRepository("version-pr", "pinned");

    const first = generateReleaseWorkflows({ repoRoot: repository, engineVersion: "3.9.0" });
    const firstBytes = readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8");
    expect(first).toMatchObject({ changed: true, trigger: "version-pr", engineVersion: "3.9.0" });

    const refreshed = generateReleaseWorkflows({ repoRoot: repository, engineVersion: "3.9.1" });
    const refreshedBytes = readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8");
    expect(refreshed).toMatchObject({ changed: true, trigger: "version-pr", engineVersion: "3.9.1" });
    expect(refreshedBytes).toBe(firstBytes.replaceAll("@3.9.0", "@3.9.1"));

    const repeated = generateReleaseWorkflows({ repoRoot: repository, engineVersion: "3.9.1" });
    expect(repeated).toMatchObject({ changed: false, trigger: "version-pr", engineVersion: "3.9.1" });
    expect(readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8")).toBe(refreshedBytes);
  });

  it("emits, refreshes, and deterministically pins the vendored single-file engine", () => {
    const repository = fixtureRepository("auto", "vendored");
    const sourceBundle = join(repository, "release-source.bundle.mjs");
    writeStaticBundle(sourceBundle, "3.8.0", "first");

    const first = generateReleaseWorkflows({
      repoRoot: repository,
      engineVersion: "3.8.0",
      engineBundlePath: sourceBundle,
    });
    const emittedBundle = join(repository, VENDORED_RELEASE_BUNDLE_PATH);
    const firstBytes = readFileSync(emittedBundle);
    expect(first).toMatchObject({
      changed: true,
      trigger: "auto",
      execution: "vendored",
      engineVersion: "3.8.0",
      bundlePath: emittedBundle,
    });
    expect(firstBytes).toEqual(readFileSync(sourceBundle));
    expect(readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8")).toContain(
      `node ${VENDORED_RELEASE_BUNDLE_PATH} run`,
    );
    expect(runBundle(emittedBundle, "--version")).toBe("red-skills-release 3.8.0 first\n");
    expect(runBundle(emittedBundle, "--help")).toContain("Usage: red-skills-release");

    writeStaticBundle(sourceBundle, "3.8.1", "second");
    const refreshed = generateReleaseWorkflows({
      repoRoot: repository,
      engineVersion: "3.8.1",
      engineBundlePath: sourceBundle,
    });
    const refreshedBytes = readFileSync(emittedBundle);
    expect(refreshed).toMatchObject({ changed: true, engineVersion: "3.8.1" });
    expect(refreshedBytes).toEqual(readFileSync(sourceBundle));
    expect(refreshedBytes).not.toEqual(firstBytes);
    expect(runBundle(emittedBundle, "--version")).toBe("red-skills-release 3.8.1 second\n");

    const repeated = generateReleaseWorkflows({
      repoRoot: repository,
      engineVersion: "3.8.1",
      engineBundlePath: sourceBundle,
    });
    expect(repeated).toMatchObject({ changed: false, engineVersion: "3.8.1" });
    expect(readFileSync(emittedBundle)).toEqual(refreshedBytes);
  });

  it("refuses a vendored bundle whose static version does not match before writing", () => {
    const repository = fixtureRepository("auto", "vendored");
    const sourceBundle = join(repository, "release-source.bundle.mjs");
    writeStaticBundle(sourceBundle, "3.8.0", "stale");

    expect(() =>
      generateReleaseWorkflows({
        repoRoot: repository,
        engineVersion: "3.8.1",
        engineBundlePath: sourceBundle,
      }),
    ).toThrow("vendored release bundle reports 3.8.0, expected 3.8.1");
    expect(existsSync(join(repository, RELEASE_WORKFLOW_PATH))).toBe(false);
    expect(existsSync(join(repository, VENDORED_RELEASE_BUNDLE_PATH))).toBe(false);
  });
});

function fixtureRepository(
  trigger: "version-pr" | "auto",
  execution: "pinned" | "vendored",
): string {
  const repository = mkdtempSync(join(tmpdir(), "release-workflow-"));
  temporaryDirectories.push(repository);
  mkdirSync(join(repository, ".red"));
  writeFileSync(join(repository, "package.json"), '{"name":"fixture","version":"1.2.3"}\n');
  writeFileSync(
    join(repository, ".red", "config.yaml"),
    `release:\n  scheme: semver\n  trigger: ${trigger}\n  execution: ${execution}\n  version_surfaces:\n    - path: package.json\n      format: npm\n`,
  );
  return repository;
}

function writeStaticBundle(path: string, version: string, sha: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node\nconst arg = process.argv[2];\nif (arg === "--version") process.stdout.write("red-skills-release ${version} ${sha}\\n");\nelse if (arg === "--help") process.stdout.write("Usage: red-skills-release <command>\\n");\n`,
  );
}

function runBundle(path: string, argument: "--version" | "--help"): string {
  const result = spawnSync(process.execPath, [path, argument], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
