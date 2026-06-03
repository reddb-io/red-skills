import { describe, expect, it } from "vitest";
import { splitBranchDir } from "../src/runtime/feedback-worktree.js";

// A monorepo's package dirs are full root-relative paths. The probe is true for
// exactly these and nothing else (mirroring the real accessSync layout check).
const PACKAGES = ["src/apps/dev", "src/apps/memory", "src/packages/shared"];
const hasPackage = (scope: string): boolean => PACKAGES.includes(scope);

describe("splitBranchDir (#437)", () => {
  it("keeps a multi-slash afk/* branch intact at the root scope", () => {
    // The regression: this used to split to { branch: 'afk', scope: 'wY7AL/...' }
    // and run `pnpm -C <root>/wY7AL/...` → ENOENT.
    expect(splitBranchDir("afk/wY7AL/430-afk-backpressure-gate", hasPackage)).toEqual({
      branch: "afk/wY7AL/430-afk-backpressure-gate",
      scope: ".",
    });
  });

  it("peels a nested package scope off a multi-slash afk/* branch", () => {
    expect(splitBranchDir("afk/wY7AL/430-afk-backpressure-gate/src/apps/dev", hasPackage)).toEqual({
      branch: "afk/wY7AL/430-afk-backpressure-gate",
      scope: "src/apps/dev",
    });
  });

  it("handles a slash-free branch at the root scope", () => {
    expect(splitBranchDir("main", hasPackage)).toEqual({ branch: "main", scope: "." });
  });

  it("peels a package scope off a slash-free branch", () => {
    expect(splitBranchDir("main/src/packages/shared", hasPackage)).toEqual({
      branch: "main",
      scope: "src/packages/shared",
    });
  });

  it("treats an unknown trailing path as part of the branch, not a scope", () => {
    // No suffix is a real package → the whole token is the branch.
    expect(splitBranchDir("afk/wK7M2/521-add-src-helper", hasPackage)).toEqual({
      branch: "afk/wK7M2/521-add-src-helper",
      scope: ".",
    });
  });

  it("matches the genuine package suffix, never a shorter coincidental segment", () => {
    expect(splitBranchDir("afk/wZ9QP/77-x/src/apps/memory", hasPackage)).toEqual({
      branch: "afk/wZ9QP/77-x",
      scope: "src/apps/memory",
    });
  });
});
