import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_WORKFLOW_PATH,
  generateReleaseWorkflows,
  renderReleaseWorkflow,
} from "../src/workflow-generator.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "workflows");
const ENGINE_VERSION = "3.8.0";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release workflow generator", () => {
  for (const trigger of ["version-pr", "auto"] as const) {
    it(`pins the ${trigger} workflow golden file`, () => {
      const generated = renderReleaseWorkflow({ trigger, engineVersion: ENGINE_VERSION });
      const golden = readFileSync(join(FIXTURES, `${trigger}.yml`), "utf8");

      expect(generated).toBe(golden);
    });
  }

  it("uses only the default token, explicit least privilege, and the canonical pinned npx form", () => {
    const versionPullRequest = renderReleaseWorkflow({
      trigger: "version-pr",
      engineVersion: ENGINE_VERSION,
    });
    const auto = renderReleaseWorkflow({ trigger: "auto", engineVersion: ENGINE_VERSION });

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

  it("reads the trigger from config, refreshes only the pin, and then becomes a no-op", () => {
    const repository = fixtureRepository("version-pr");

    const first = generateReleaseWorkflows({ repoRoot: repository, engineVersion: "3.8.0" });
    const firstBytes = readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8");
    expect(first).toMatchObject({ changed: true, trigger: "version-pr", engineVersion: "3.8.0" });

    const refreshed = generateReleaseWorkflows({ repoRoot: repository, engineVersion: "3.8.1" });
    const refreshedBytes = readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8");
    expect(refreshed).toMatchObject({ changed: true, trigger: "version-pr", engineVersion: "3.8.1" });
    expect(refreshedBytes).toBe(firstBytes.replaceAll("@3.8.0", "@3.8.1"));

    const repeated = generateReleaseWorkflows({ repoRoot: repository, engineVersion: "3.8.1" });
    expect(repeated).toMatchObject({ changed: false, trigger: "version-pr", engineVersion: "3.8.1" });
    expect(readFileSync(join(repository, RELEASE_WORKFLOW_PATH), "utf8")).toBe(refreshedBytes);
  });
});

function fixtureRepository(trigger: "version-pr" | "auto"): string {
  const repository = mkdtempSync(join(tmpdir(), "release-workflow-"));
  temporaryDirectories.push(repository);
  mkdirSync(join(repository, ".red"));
  writeFileSync(join(repository, "package.json"), '{"name":"fixture","version":"1.2.3"}\n');
  writeFileSync(
    join(repository, ".red", "config.yaml"),
    `release:\n  scheme: semver\n  trigger: ${trigger}\n  execution: pinned\n  version_surfaces:\n    - path: package.json\n      format: npm\n`,
  );
  return repository;
}
