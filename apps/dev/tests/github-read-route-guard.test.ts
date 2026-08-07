import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GITHUB_READ_EXEMPTIONS,
  GITHUB_READ_SHELLOUT_BASELINE,
  collectGithubReadRouteReport,
  collectGithubReadShelloutsFromFiles,
  formatGithubReadRouteFailure,
  githubReadRouteViolations,
} from "../src/core/github-read-route-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("GitHub reads route through @reddb-io/github (#3451)", () => {
  it("holds the live tree to the declared shrink-only baseline", () => {
    const report = collectGithubReadRouteReport(ROOT);
    const violations = githubReadRouteViolations(report);

    expect(violations, formatGithubReadRouteFailure(report, violations)).toEqual([]);
    expect(report.findings.length).toBeLessThanOrEqual(
      GITHUB_READ_SHELLOUT_BASELINE.reduce((sum, entry) => sum + entry.count, 0),
    );
    expect(formatGithubReadRouteFailure(report, ["probe"])).toContain(
      `${report.findings.length} GitHub read shell-out(s) remain`,
    );
  });

  it("declares every exemption with its reason", () => {
    expect(GITHUB_READ_EXEMPTIONS.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "authentication-bootstrap",
      "viewer-identity",
      "unsupported-mutation",
      "shared-client",
    ]));
    for (const exemption of GITHUB_READ_EXEMPTIONS) expect(exemption.reason.trim()).not.toBe("");
    for (const entry of GITHUB_READ_SHELLOUT_BASELINE) expect(entry.reason.trim()).not.toBe("");
  });

  it("rejects a new gh read with the file, line, and replacement route", () => {
    const findings = collectGithubReadShelloutsFromFiles([
      {
        relativePath: "apps/dev/src/new-poller.ts",
        sourceText: `\nexport async function poll(exec: any) {\n  return exec(["gh", "pr", "view", "42", "--json", "state"]);\n}\n`,
      },
    ]);
    const report = { findings, baseline: [], exemptions: GITHUB_READ_EXEMPTIONS };
    const violations = githubReadRouteViolations(report);
    const failure = formatGithubReadRouteFailure(report, violations);

    expect(violations).toHaveLength(1);
    expect(failure).toContain("apps/dev/src/new-poller.ts:3");
    expect(failure).toContain("createGithubClient");
    expect(failure).toContain("conditionalRest / singleObject");
  });

  it("does not classify authentication or a mutation as a read", () => {
    expect(collectGithubReadShelloutsFromFiles([
      {
        relativePath: "apps/dev/src/auth-and-write.ts",
        sourceText: `
          await exec(["gh", "auth", "token"]);
          await runGh(ctx, ["pr", "merge", "42", "--merge"]);
          await execTool("gh", ["api", "-X", "PUT", "repos/o/r/pulls/42/update-branch"]);
        `,
      },
    ])).toEqual([]);
  });

  it("runs in every validation cone", () => {
    expect(REPO_INVARIANT_SUITES.find((suite) => suite.name === "invariants:github-read-routing")).toMatchObject({
      scope: "apps/dev",
      script: "test:invariants",
    });
  });
});
