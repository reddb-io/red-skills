import { describe, expect, it } from "vitest";
import {
  makeFeedbackWorktree,
  splitBranchDir,
  type FeedbackWorktreeIO,
} from "../src/runtime/feedback-worktree.js";

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

/**
 * Recording fake IO: tracks every worktreeAdd/install/script/remove call so a
 * test can assert the materialise → install ordering and the install `cwd`. Pure
 * — no real subprocess is ever spawned. `installCode` scripts the `pnpm install`
 * exit so the install-failure path is exercisable.
 */
function fakeIO(installCode = 0): {
  io: FeedbackWorktreeIO;
  calls: Array<{ op: "add" | "install" | "script" | "remove"; dest: string }>;
} {
  const calls: Array<{ op: "add" | "install" | "script" | "remove"; dest: string }> = [];
  const io: FeedbackWorktreeIO = {
    worktreeAdd: async (_ctx, dest) => {
      calls.push({ op: "add", dest });
      return true;
    },
    pnpm: async (args, opts) => {
      const isInstall = args[0] === "install";
      calls.push({ op: isInstall ? "install" : "script", dest: opts.cwd ?? "" });
      const code = isInstall ? installCode : 0;
      return { code, stdout: "", stderr: code === 0 ? "" : "boom" };
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    worktreeRemove: async (_ctx, dest) => {
      calls.push({ op: "remove", dest });
    },
  };
  return { io, calls };
}

describe("makeFeedbackWorktree install (#458)", () => {
  it("installs in a freshly materialised checkout before any check runs", async () => {
    const { io, calls } = fakeIO();
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    // Resolve a worker branch by running a pnpm -C token through the executor;
    // it must materialise + install the checkout, then run the script there.
    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);

    // add → install BEFORE the script runs, the first two keyed to the worktree.
    expect(calls.map((c) => c.op)).toEqual(["add", "install", "script"]);
    expect(calls[0]?.dest).toBe("/root/.red/tmp/feedback/afk-w1-42-fix");
    expect(calls[1]?.dest).toBe("/root/.red/tmp/feedback/afk-w1-42-fix");
  });

  it("installs the materialised checkout exactly once across reused branches", async () => {
    const { io, calls } = fakeIO();
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "build"]);

    // Second resolve hits the cache → no extra add/install for the same branch.
    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(1);
  });

  it("keeps the checkout (does not fall back to root) when install fails", async () => {
    const { io, calls } = fakeIO(1);
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    await fb.cleanup();

    // A failed install still registers the worktree for cleanup (the checkout is
    // used, not abandoned to root), so cleanup removes it.
    expect(calls.filter((c) => c.op === "remove")).toEqual([
      { op: "remove", dest: "/root/.red/tmp/feedback/afk-w1-42-fix" },
    ]);
  });
});
