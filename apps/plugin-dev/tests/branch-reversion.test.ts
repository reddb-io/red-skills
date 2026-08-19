import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  detectBranchReversion,
  testSourceLineRatchet,
} from "../src/core/branch-reversion.js";

function patchForAddedFile(file: string, lines: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function patchForDeletedFile(file: string, lines: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "deleted file mode 100644",
    `--- a/${file}`,
    "+++ /dev/null",
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
  ].join("\n");
}

function addedHunk(file: string, start: number, lines: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start - 1},0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function deletedHunk(file: string, start: number, lines: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},${lines.length} +${start - 1},0 @@`,
    ...lines.map((line) => `-${line}`),
  ].join("\n");
}

describe("detectBranchReversion", () => {
  it("runs the test-source shrink ratchet independently of after-fork geometry", () => {
    const file = "apps/plugin-dev/tests/removed.test.ts";

    const ratchet = testSourceLineRatchet(patchForDeletedFile(file, ["one", "two"]));

    expect(ratchet.testLineDelta).toBe(-2);
    expect(ratchet.testFilesShrunk).toEqual([file]);
    expect(ratchet.testFileLineDeltas).toEqual([{ file, delta: -2 }]);
  });

  it("fails both belts for the pre-rescue #3262 geometry at be56bfc05", () => {
    const birthLatch = Array.from({ length: 173 }, (_, index) => `birth latch test line ${index + 1}`);
    const mainLog = [
      addedHunk("apps/redskilled/src/demand-loop.ts", 398, ["birth latch source"]),
      addedHunk("apps/plugin-dev/src/runtime/feedback-worktree.ts", 461, ["declared setup source"]),
      patchForAddedFile("apps/plugin-dev/src/core/worktree-setup-doctor.ts", ["setup doctor source"]),
      patchForAddedFile("apps/redskilled/tests/birth-latch.test.ts", birthLatch),
    ].join("\n");
    const diff = [
      deletedHunk("apps/redskilled/src/demand-loop.ts", 398, ["birth latch source"]),
      deletedHunk("apps/plugin-dev/src/runtime/feedback-worktree.ts", 461, ["declared setup source"]),
      patchForDeletedFile("apps/plugin-dev/src/core/worktree-setup-doctor.ts", ["setup doctor source"]),
      patchForDeletedFile("apps/redskilled/tests/birth-latch.test.ts", birthLatch),
    ].join("\n");

    const finding = detectBranchReversion(diff, "be56bfc05", mainLog, "", "origin/main");

    expect(finding.blocked).toBe(true);
    expect(finding.revertingFiles).toEqual([
      "apps/plugin-dev/src/core/worktree-setup-doctor.ts",
      "apps/plugin-dev/src/runtime/feedback-worktree.ts",
      "apps/redskilled/src/demand-loop.ts",
      "apps/redskilled/tests/birth-latch.test.ts",
    ]);
    expect(finding.testLineDelta).toBe(-173);
    expect(finding.testFilesShrunk).toEqual(["apps/redskilled/tests/birth-latch.test.ts"]);
    expect(finding.testFileLineDeltas).toContainEqual({
      file: "apps/redskilled/tests/birth-latch.test.ts",
      delta: -173,
    });
    expect(finding.repair).toEqual({
      files: finding.revertingFiles,
      command:
        "git checkout origin/main -- apps/plugin-dev/src/core/worktree-setup-doctor.ts " +
        "apps/plugin-dev/src/runtime/feedback-worktree.ts apps/redskilled/src/demand-loop.ts " +
        "apps/redskilled/tests/birth-latch.test.ts",
    });
  });

  it("passes an intentional contract-phase deletion and cites its declaration", () => {
    const file = "packages/worker/src/deprecated-aliases.ts";
    const body = [
      "## What to build",
      "",
      "Consolidation, contract phase: remove the deprecation aliases and add the old verb names to the extinct-names guard so they cannot return.",
    ].join("\n");

    const finding = detectBranchReversion(
      patchForDeletedFile(file, ["export const oldAlias = nextVerb;"]),
      "fork-sha",
      patchForAddedFile(file, ["export const oldAlias = nextVerb;"]),
      body,
      "origin/main",
    );

    expect(finding.blocked).toBe(false);
    expect(finding.revertingFiles).toEqual([file]);
    expect(finding.declaredFiles).toEqual([file]);
    expect(finding.declarations).toEqual([
      {
        files: [file],
        citation:
          "Consolidation, contract phase: remove the deprecation aliases and add the old verb names to the extinct-names guard so they cannot return.",
      },
    ]);
    expect(finding.repair).toBeNull();
  });

  it("lets a path-specific declaration silence only the named file", () => {
    const declared = "apps/plugin-dev/tests/legacy.test.ts";
    const undeclared = "apps/plugin-dev/tests/current.test.ts";
    const diff = [
      patchForDeletedFile(declared, ["legacy"]),
      patchForDeletedFile(undeclared, ["current"]),
    ].join("\n");
    const mainLog = [
      patchForAddedFile(declared, ["legacy"]),
      patchForAddedFile(undeclared, ["current"]),
    ].join("\n");

    const finding = detectBranchReversion(
      diff,
      "fork-sha",
      mainLog,
      "Deletion declaration: remove `apps/plugin-dev/tests/legacy.test.ts`.",
      "origin/main",
    );

    expect(finding.blocked).toBe(true);
    expect(finding.declaredFiles).toEqual([declared]);
    expect(finding.undeclaredRevertingFiles).toEqual([undeclared]);
    expect(finding.undeclaredTestLineDelta).toBe(-1);
    expect(finding.repair?.files).toEqual([undeclared]);
  });

  it("ratchets test-source lines even when the removed lines predate the fork", () => {
    const file = "apps/plugin-dev/tests/old-behaviour.test.ts";
    const finding = detectBranchReversion(
      deletedHunk(file, 20, ["test one", "test two"]),
      "fork-sha",
      "",
      "",
      "origin/main",
    );

    expect(finding.revertingFiles).toEqual([]);
    expect(finding.testLineDelta).toBe(-2);
    expect(finding.undeclaredTestLineDelta).toBe(-2);
    expect(finding.testFilesShrunk).toEqual([file]);
    expect(finding.blocked).toBe(true);
    expect(finding.repair?.command).toBe(`git checkout origin/main -- ${file}`);
  });

  it("does not let a contract-phase alias declaration whitelist unrelated files", () => {
    const aliasFile = "packages/worker/src/deprecated-aliases.ts";
    const unrelated = "apps/plugin-dev/src/runtime/feedback-worktree.ts";
    const finding = detectBranchReversion(
      [patchForDeletedFile(aliasFile, ["alias"]), patchForDeletedFile(unrelated, ["setup"])].join("\n"),
      "fork-sha",
      [patchForAddedFile(aliasFile, ["alias"]), patchForAddedFile(unrelated, ["setup"])].join("\n"),
      "Consolidation, contract phase: remove the deprecation aliases.",
      "origin/main",
    );

    expect(finding.declaredFiles).toEqual([aliasFile]);
    expect(finding.undeclaredRevertingFiles).toEqual([unrelated]);
    expect(finding.blocked).toBe(true);
  });

  const repo = resolve(import.meta.dirname, "../../..");
  const incidentBase = "6b59aab261aed2dc472698c1ac7409bd21a16913";
  const incidentTip = "be56bfc051644fc6604670a1d1b3d051efe7b7b2";
  const incidentObjectsAvailable = (() => {
    try {
      execFileSync("git", ["cat-file", "-e", `${incidentBase}^{commit}`], { cwd: repo });
      execFileSync("git", ["cat-file", "-e", `${incidentTip}^{commit}`], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(incidentObjectsAvailable)("rejects the actual pre-rescue be56bfc05 tree", () => {
    const forkPoint = execFileSync("git", ["merge-base", incidentBase, incidentTip], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const args = ["diff", "--no-ext-diff", "--no-renames", "--unified=0"];
    const afterForkBasePatch = execFileSync("git", [...args, `${forkPoint}..${incidentBase}`], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const diff = execFileSync("git", [...args, `${incidentBase}..${incidentTip}`], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

    const finding = detectBranchReversion(diff, forkPoint, afterForkBasePatch, "", "origin/main");

    expect(finding.blocked).toBe(true);
    // HISTORICAL paths: this case reads the real be56bfc05 diff out of git, and
    // that commit predates ADR 0153's rename. A tree that already happened does
    // not move because the directory did.
    expect(finding.revertingFiles).toEqual(expect.arrayContaining([
      "apps/redskilled/src/demand-loop.ts",
      "apps/dev/src/runtime/feedback-worktree.ts",
      "apps/dev/src/core/worktree-setup-doctor.ts",
    ]));
    expect(finding.testFileLineDeltas).toContainEqual({
      file: "apps/redskilled/tests/birth-latch.test.ts",
      delta: -173,
    });
    expect(finding.repair?.command).toBe(
      `git checkout origin/main -- ${finding.repair?.files.join(" ")}`,
    );
  });
});
