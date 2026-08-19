import { describe, expect, test } from "vitest";
import {
  EMPTY_TREE_OID,
  type GitChange,
  parseNameStatus,
  parseNameStatusZ,
  postCheckoutRange,
  postCommitRange,
  selectIngestPaths,
} from "../src/git-diff-selection.js";

describe("parseNameStatusZ (AC4 — selection isolated from git)", () => {
  test("parses additions, modifications, and deletions", () => {
    // `git diff --name-status -z` is NUL-delimited: <status>\0<path>\0 ...
    const raw = "A\0src/new.ts\0M\0src/edit.ts\0D\0src/gone.ts\0";
    expect(parseNameStatusZ(raw)).toEqual<GitChange[]>([
      { status: "A", path: "src/new.ts" },
      { status: "M", path: "src/edit.ts" },
      { status: "D", path: "src/gone.ts" },
    ]);
  });

  test("parses renames and copies with their two-path records", () => {
    // Rename/copy records carry a similarity score and old+new paths.
    const raw = "R100\0src/old.ts\0src/renamed.ts\0C75\0src/base.ts\0src/copy.ts\0";
    expect(parseNameStatusZ(raw)).toEqual<GitChange[]>([
      { status: "R", path: "src/renamed.ts", oldPath: "src/old.ts" },
      { status: "C", path: "src/copy.ts", oldPath: "src/base.ts" },
    ]);
  });

  test("empty / whitespace-only output yields no changes", () => {
    expect(parseNameStatusZ("")).toEqual([]);
    expect(parseNameStatusZ("\0")).toEqual([]);
  });
});

describe("parseNameStatus (tab/newline form)", () => {
  test("parses the non -z tab-delimited form including renames", () => {
    const raw = ["M\tsrc/edit.ts", "R096\tsrc/old.ts\tsrc/new.ts", "D\tsrc/gone.ts"].join("\n");
    expect(parseNameStatus(raw)).toEqual<GitChange[]>([
      { status: "M", path: "src/edit.ts" },
      { status: "R", path: "src/new.ts", oldPath: "src/old.ts" },
      { status: "D", path: "src/gone.ts" },
    ]);
  });

  test("ignores blank lines", () => {
    expect(parseNameStatus("\n\nA\tx.ts\n\n")).toEqual([{ status: "A", path: "x.ts" }]);
  });
});

describe("selectIngestPaths", () => {
  test("re-indexes added/modified/typechanged files", () => {
    const sel = selectIngestPaths([
      { status: "A", path: "a.ts" },
      { status: "M", path: "b.ts" },
      { status: "T", path: "c.ts" },
    ]);
    expect(sel.reindexed).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(sel.removed).toEqual([]);
    expect(sel.paths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("a rename re-indexes the destination and stales the source", () => {
    const sel = selectIngestPaths([
      { status: "R", path: "new.ts", oldPath: "old.ts" },
    ]);
    expect(sel.reindexed).toEqual(["new.ts"]);
    expect(sel.removed).toEqual(["old.ts"]);
    // Both reach the incremental refresh: the new path to index, the old to stale.
    expect(sel.paths).toEqual(["new.ts", "old.ts"]);
  });

  test("a copy re-indexes the destination but does not stale the source", () => {
    const sel = selectIngestPaths([
      { status: "C", path: "copy.ts", oldPath: "base.ts" },
    ]);
    expect(sel.reindexed).toEqual(["copy.ts"]);
    expect(sel.removed).toEqual([]);
  });

  test("a deletion is reported as removed so its elements go stale", () => {
    const sel = selectIngestPaths([{ status: "D", path: "gone.ts" }]);
    expect(sel.reindexed).toEqual([]);
    expect(sel.removed).toEqual(["gone.ts"]);
    expect(sel.paths).toEqual(["gone.ts"]);
  });

  test("dedupes paths while preserving first-seen order", () => {
    const sel = selectIngestPaths([
      { status: "M", path: "dup.ts" },
      { status: "M", path: "dup.ts" },
      { status: "A", path: "other.ts" },
    ]);
    expect(sel.paths).toEqual(["dup.ts", "other.ts"]);
  });

  test("skips unknown/broken statuses", () => {
    const sel = selectIngestPaths([
      { status: "X", path: "weird.ts" },
      { status: "B", path: "broken.ts" },
    ]);
    expect(sel.paths).toEqual([]);
  });
});

describe("postCheckoutRange (branch-vs-file checkout gating)", () => {
  test("a branch checkout (flag=1) yields the prev..new range", () => {
    expect(postCheckoutRange("aaa", "bbb", "1")).toEqual({ from: "aaa", to: "bbb" });
  });

  test("a file checkout (flag=0) is a no-op", () => {
    expect(postCheckoutRange("aaa", "bbb", "0")).toBeNull();
  });

  test("a no-move checkout (prev === new) is a no-op", () => {
    expect(postCheckoutRange("aaa", "aaa", "1")).toBeNull();
  });

  test("missing refs are a no-op", () => {
    expect(postCheckoutRange("", "bbb", "1")).toBeNull();
    expect(postCheckoutRange("aaa", "", "1")).toBeNull();
  });
});

describe("postCommitRange (root-commit aware)", () => {
  test("a commit with a parent diffs parent..head", () => {
    expect(postCommitRange("head", "parent")).toEqual({ from: "parent", to: "head" });
  });

  test("the root commit diffs against the empty tree", () => {
    expect(postCommitRange("head", undefined)).toEqual({ from: EMPTY_TREE_OID, to: "head" });
  });
});
