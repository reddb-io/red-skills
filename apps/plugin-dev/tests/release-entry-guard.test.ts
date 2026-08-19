import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { releaseEntryVerdict, run } from "../../../scripts/require-release-entry.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

// PR #3497, merged on 2026-08-08 UTC: the responsive dashboard table shipped
// without entering the release queue.
const DASHBOARD_TABLE_DIFF = [
  "apps/redskilled/README.md",
  "apps/redskilled/src/dashboard-command.ts",
  "apps/redskilled/src/dashboard-tui.ts",
  "apps/redskilled/tests/dashboard-command.test.ts",
  "apps/redskilled/tests/dashboard-tui.test.ts",
  "packages/redskilled-render/dashboard-table.ts",
  "packages/redskilled-render/dashboard.ts",
  "packages/redskilled-render/index.ts",
  "packages/redskilled-render/tests/render.test.ts",
];

// PR #3500, merged on 2026-08-08: the healthy-statusline repair also shipped
// without entering the release queue.
const STATUSLINE_FIX_DIFF = [
  "apps/plugin-dev/src/core/file-size-guard.ts",
  "apps/redskilled/src/daemon/tunables.ts",
  "apps/redskilled/src/statusline-deaths.ts",
  "apps/redskilled/src/statusline-payload.ts",
  "apps/redskilled/tests/early-worker-death.test.ts",
  "apps/redskilled/tests/statusline-deaths.test.ts",
  "apps/redskilled/tests/statusline-local-project.test.ts",
  "apps/vscode-extension-redskilled/tests/fixtures.ts",
  "packages/redskilled-render/line.ts",
  "packages/redskilled-render/payload.ts",
  "packages/redskilled-render/tests/render.test.ts",
];

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("release-entry PR gate (#3508)", () => {
  it.each([
    ["responsive dashboard table PR #3497", DASHBOARD_TABLE_DIFF],
    ["healthy statusline PR #3500", STATUSLINE_FIX_DIFF],
  ])("refuses the missed 2026-08-08 regression: %s", (_name, files) => {
    const verdict = releaseEntryVerdict(files);

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(".changeset/<descriptive-name>.md");
    expect(verdict.message).toContain("pnpm changeset");
  });

  it("accepts an apps/packages change that carries a release entry", () => {
    expect(releaseEntryVerdict([
      "apps/redskilled/src/dashboard-tui.ts",
      ".changeset/responsive-dashboard-table.md",
    ])).toMatchObject({ ok: true, kind: "release-entry-present" });
  });

  it.each([
    ["docs-only", ["docs/operations.md", "README.md"], "documentation-only"],
    [".red-only", [".red/contexts/dev/CONTEXT.md", ".red/adr/0139-release-standard.md"], ".red-only"],
    ["workflow-only", [".github/workflows/red-workspace-ci.yml"], "workflow-only"],
  ])("passes and states the %s exemption", (_name, files, exemption) => {
    expect(releaseEntryVerdict(files)).toMatchObject({
      ok: true,
      kind: "exempt",
      message: expect.stringContaining(exemption),
    });
  });

  it("diffs explicit revisions, independent of the checked-out branch", () => {
    const root = mkdtempSync(join(tmpdir(), "release-entry-guard-"));
    fixtures.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

    git("init", "-q");
    git("config", "user.name", "Release Guard Test");
    git("config", "user.email", "release-guard@example.invalid");
    writeFileSync(join(root, "README.md"), "base\n");
    git("add", "README.md");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");

    git("checkout", "-qb", "feature");
    execFileSync("mkdir", ["-p", join(root, "apps", "demo")]);
    writeFileSync(join(root, "apps", "demo", "index.ts"), "export const value = 1;\n");
    git("add", "apps/demo/index.ts");
    git("commit", "-qm", "feature");
    const head = git("rev-parse", "HEAD");

    git("checkout", "-q", "--detach", base);
    const errors: string[] = [];
    expect(run(["--root", root, "--base", base, "--head", head], {
      log: () => undefined,
      error: (message) => errors.push(message),
    })).toBe(1);
    expect(errors.join("\n")).toContain(".changeset/<descriptive-name>.md");
  });

  it("is wired into the PR-context scope job with event SHAs", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/red-workspace-ci.yml"), "utf8");
    const scopeJob = workflow.slice(workflow.indexOf("  scope:"), workflow.indexOf("  workflow-security:"));

    expect(scopeJob).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    expect(scopeJob).toContain('node scripts/require-release-entry.mjs --base "$BASE_SHA" --head "$HEAD_SHA"');
  });
});
