import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOON_PIN_SITES } from "../src/core/toon-version.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readWorkflow(): Promise<string> {
  return readFile(join(ROOT, ".github/workflows/red-toon-watch.yml"), "utf8");
}

function stepBody(workflow: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  expect(start, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);

  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

describe("red-toon-watch workflow contract", () => {
  it("is scheduled, dispatchable, and minimally permissioned for a rolling PR", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("name: red-toon-watch");
    expect(workflow).toContain("  schedule:");
    expect(workflow).toContain("  workflow_dispatch:");
    expect(workflow).toContain("  contents: write");
    expect(workflow).toContain("  pull-requests: write");
    expect(workflow).not.toContain("issues: write");
    expect(workflow).toContain("group: red-toon-watch");
    expect(workflow).toContain("TOON_BUMP_BRANCH: automation/toon-bump");
  });

  it("detects only newer stable release tags before running the S3 bump verb", async () => {
    const resolveRelease = stepBody(await readWorkflow(), "Resolve stable toon release");
    const bump = stepBody(await readWorkflow(), "Run toon bump");

    expect(resolveRelease).toContain("repos/reddb-io/toon/releases/latest");
    expect(resolveRelease).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(resolveRelease).toContain("sort -V");
    expect(resolveRelease).toContain('echo "changed=false"');
    expect(bump).toContain("if: steps.release.outputs.changed == 'true'");
    expect(bump).toContain('pnpm -C apps/plugin-dev dev toon-bump "$TARGET_VERSION"');
    // A full install, never `--lockfile-only`: under CI=true with only a
    // catalog edit, pnpm 11 skips resolution for lockfile-only runs and the
    // bumped version never reaches pnpm-lock.yaml.
    expect(bump).toContain("pnpm install --no-frozen-lockfile");
    expect(bump).not.toMatch(/pnpm install [^\n]*--lockfile-only/);
  });

  it("force-updates one rolling PR with trigger tag and sanitized release notes", async () => {
    const pr = stepBody(await readWorkflow(), "Open or update rolling PR");

    expect(pr).toContain("git push --force-with-lease origin");
    expect(pr).toContain('gh pr list --head "$GITHUB_REPOSITORY_OWNER:$TOON_BUMP_BRANCH"');
    expect(pr).toContain("gh pr edit");
    expect(pr).toContain("gh pr create");
    expect(pr).toContain('trigger tag: `%s`');
    expect(pr).toContain("Toon release notes");
    expect(pr).toContain("SANITIZED_NOTES");
    expect(pr).not.toContain("peter-evans/create-pull-request");
  });

  it("stages every registered pin site, so no bumped file is left out of the commit", async () => {
    const pr = stepBody(await readWorkflow(), "Open or update rolling PR");
    const staged = /git add -- (.+)/.exec(pr)?.[1]?.split(/\s+/) ?? [];

    // An explicit path list silently drops a site the moment one is registered without it, and the
    // bumped-but-unstaged file reads as "already correct" to the very guard meant to catch drift.
    for (const site of new Set(TOON_PIN_SITES.map((site) => site.path))) {
      expect(staged, `red-toon-watch never stages ${site}`).toContain(site);
    }
    expect(staged).toContain("pnpm-workspace.yaml");
    expect(staged).toContain("pnpm-lock.yaml");
  });

  it("regenerates the pi skill mirrors that restate the pin", async () => {
    expect(stepBody(await readWorkflow(), "Run toon bump")).toContain("pnpm pi:packages:build");
    expect(stepBody(await readWorkflow(), "Open or update rolling PR")).toContain("packaging/pi");
  });
});
