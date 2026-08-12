import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GITHUB_READ_EXEMPTIONS,
  GITHUB_READ_SHELLOUT_BASELINE,
  GITHUB_ROUTE_SCAN_ROOTS,
  GITHUB_WRITE_SHELLOUT_BASELINE,
  collectGithubReadRouteReport,
  collectGithubReadShelloutsFromFiles,
  collectGithubWriteRouteReport,
  collectGithubWriteShelloutsFromFiles,
  formatGithubReadRouteFailure,
  formatGithubWriteRouteFailure,
  githubReadRouteViolations,
  githubWriteRouteViolations,
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

  it("routes the trust and queue cluster entirely through the shared client (#3729)", () => {
    const migrated = new Set([
      "apps/dev/src/runtime/gh/trust.ts",
      "apps/dev/src/runtime/gh/queue.ts",
      "apps/dev/src/runtime/gh/candidates.ts",
    ]);
    const report = collectGithubReadRouteReport(ROOT);

    expect(report.findings.filter((finding) => migrated.has(finding.path))).toEqual([]);
    expect(GITHUB_READ_SHELLOUT_BASELINE.filter((entry) => migrated.has(entry.path))).toEqual([]);
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

  it("holds raw GitHub writes to their own shrink-only baseline", () => {
    const report = collectGithubWriteRouteReport(ROOT);
    const violations = githubWriteRouteViolations(report);

    expect(violations, formatGithubWriteRouteFailure(report, violations)).toEqual([]);
    expect(report.findings.length).toBeLessThanOrEqual(
      GITHUB_WRITE_SHELLOUT_BASELINE.reduce((sum, entry) => sum + entry.count, 0),
    );
    expect(formatGithubWriteRouteFailure(report, ["probe"])).toContain(
      `${report.findings.length} GitHub write shell-out(s) remain`,
    );
    expect(GITHUB_WRITE_SHELLOUT_BASELINE.find(
      (entry) => entry.path === "apps/dev/src/runtime/gh/issues.ts",
    )?.count).toBe(7);
  });

  it("routes every HITL card read and write through packages/github (#3727)", () => {
    const path = "apps/dev/src/commands/hitl-card.ts";

    expect(collectGithubReadRouteReport(ROOT).findings.filter((finding) => finding.path === path)).toEqual([]);
    expect(collectGithubWriteRouteReport(ROOT).findings.filter((finding) => finding.path === path)).toEqual([]);
    expect(GITHUB_READ_SHELLOUT_BASELINE.some((entry) => entry.path === path)).toBe(false);
    expect(GITHUB_WRITE_SHELLOUT_BASELINE.some((entry) => entry.path === path)).toBe(false);
  });

  it("routes respond, ship, and doctor classifier GitHub I/O through packages/github (#3730)", () => {
    const paths = [
      "apps/dev/src/commands/respond.ts",
      "apps/dev/src/commands/ship.ts",
      "apps/dev/src/runtime/doctor-classifiers.ts",
    ];
    const readReport = collectGithubReadRouteReport(ROOT);
    const writeReport = collectGithubWriteRouteReport(ROOT);

    for (const path of paths) {
      expect(readReport.findings.filter((finding) => finding.path === path)).toEqual([]);
      expect(writeReport.findings.filter((finding) => finding.path === path)).toEqual([]);
      expect(GITHUB_READ_SHELLOUT_BASELINE.some((entry) => entry.path === path)).toBe(false);
      expect(GITHUB_WRITE_SHELLOUT_BASELINE.some((entry) => entry.path === path)).toBe(false);
    }
  });

  it("routes the review, docs, Manager-map, and merge-driver cluster through packages/github (#3732)", () => {
    const migrated = new Set([
      "apps/dev/src/runtime/review-gh.ts",
      "apps/dev/src/runtime/wire/docs.ts",
      "apps/dev/src/runtime/gh/manager-map.ts",
      "apps/dev/src/runtime/merge-driver-io.ts",
    ]);

    expect(collectGithubReadRouteReport(ROOT).findings.filter((finding) => migrated.has(finding.path))).toEqual([]);
    expect(collectGithubWriteRouteReport(ROOT).findings.filter((finding) => migrated.has(finding.path))).toEqual([]);
    expect(GITHUB_READ_SHELLOUT_BASELINE.filter((entry) => migrated.has(entry.path))).toEqual([]);
    expect(GITHUB_WRITE_SHELLOUT_BASELINE.filter((entry) => migrated.has(entry.path))).toEqual([]);
  });

  it("rejects a new gh write and points it at the shared client", () => {
    const findings = collectGithubWriteShelloutsFromFiles([
      {
        relativePath: "packages/red-castle/src/engine/new-writer.ts",
        sourceText: `\nexport async function merge(runGh: any) {\n  return runGh(["pr", "merge", "42", "--merge"]);\n}\n`,
      },
    ]);
    const report = { findings, baseline: [], exemptions: GITHUB_READ_EXEMPTIONS };
    const violations = githubWriteRouteViolations(report);
    const failure = formatGithubWriteRouteFailure(report, violations);

    expect(violations).toHaveLength(1);
    expect(failure).toContain("packages/red-castle/src/engine/new-writer.ts:3");
    expect(failure).toContain("createGithubClient");
  });

  it("sweeps red-castle alongside both daemon applications", () => {
    expect(GITHUB_ROUTE_SCAN_ROOTS).toEqual([
      "apps/dev/src",
      "apps/redskilled/src",
      "packages/red-castle/src",
    ]);
  });

  it("runs in every validation cone", () => {
    expect(REPO_INVARIANT_SUITES.find((suite) => suite.name === "invariants:github-read-routing")).toMatchObject({
      scope: "apps/dev",
      script: "test:invariants",
    });
  });
});
