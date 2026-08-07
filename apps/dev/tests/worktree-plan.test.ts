import { describe, expect, it } from "vitest";
import { issueNumberOf, planWorktree, slugify } from "../src/core/worktree-plan.js";

describe("planWorktree — the lane, the base and the direction, decided once", () => {
  it("lands a slug in the manual lane, branched off the remote trunk", () => {
    const plan = planWorktree({ target: "Release toolchain" });

    expect(plan.directory).toBe(".red/tmp/worktrees/manual/release-toolchain");
    expect(plan.branch).toBe("afk/release-toolchain");
    expect(plan.base).toBe("origin/main");
    expect(plan.existing).toBe(false);
  });

  it("always bases a NEW branch on a remote ref, never a local one", () => {
    // `git worktree add <dir> <branch>` resolves the LOCAL ref, which can trail
    // origin — the work builds on a stale tip and only the refused push says so.
    for (const plan of [
      planWorktree({ target: "x" }),
      planWorktree({ target: "y", trunk: "trunk" }),
      planWorktree({ target: "z", base: "origin/release" }),
    ]) {
      expect(plan.base.startsWith("origin/"), `${plan.base} must be a remote ref`).toBe(true);
    }
  });

  it("takes an EXISTING branch from origin with -B, not from the local ref", () => {
    const plan = planWorktree({ target: "ignored", checkout: "afk/already-pushed" });

    expect(plan.existing).toBe(true);
    expect(plan.base).toBe("origin/afk/already-pushed");
    expect(plan.argv).toEqual([
      "worktree",
      "add",
      ".red/tmp/worktrees/manual/afk-already-pushed",
      "-B",
      "afk/already-pushed",
      "origin/afk/already-pushed",
    ]);
  });

  it("names an issue worktree after its title when the caller resolved one", () => {
    const plan = planWorktree({ target: "#3466", issueTitle: "The release reaches the registry" });

    expect(plan.directory).toBe(".red/tmp/worktrees/manual/3466-the-release-reaches-the-registry");
    expect(plan.branch).toBe("afk/3466-the-release-reaches-the-registry");
  });

  it("still plans an issue with no title, rather than refusing", () => {
    // The title is a nicety; a doctor that failed without one would send the
    // caller back to the three-part command this exists to replace.
    const plan = planWorktree({ target: "3466" });
    expect(plan.directory).toBe(".red/tmp/worktrees/manual/3466");
  });

  it("keeps every plan inside .red/tmp/worktrees, whatever the lane", () => {
    for (const lane of ["manual", "docs", "landing", "reconcile"] as const) {
      const plan = planWorktree({ target: "s", lane });
      expect(plan.directory.startsWith(`.red/tmp/worktrees/${lane}/`)).toBe(true);
    }
  });

  it("refuses a target that leaves no slug behind", () => {
    expect(() => planWorktree({ target: "///" })).toThrow(/no usable slug/);
    expect(() => planWorktree({ target: "  " })).toThrow(/must not be empty/);
  });

  it("reads issue targets in both spellings and nothing else", () => {
    expect(issueNumberOf("#3466")).toBe(3466);
    expect(issueNumberOf("3466")).toBe(3466);
    expect(issueNumberOf("release-3466")).toBeNull();
    expect(slugify("A Title, With Punctuation!")).toBe("a-title-with-punctuation");
  });
});
