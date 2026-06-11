import { describe, expect, it } from "vitest";
import {
  makeFeedbackWorktree,
  splitBranchDir,
  type FeedbackWorktreeIO,
} from "../src/runtime/feedback-worktree.js";

// A monorepo's package dirs are full root-relative paths. The probe is true for
// exactly these and nothing else (mirroring the real accessSync layout check).
const PACKAGES = ["apps/dev", "apps/memory", "packages/shared"];
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
    expect(splitBranchDir("afk/wY7AL/430-afk-backpressure-gate/apps/dev", hasPackage)).toEqual({
      branch: "afk/wY7AL/430-afk-backpressure-gate",
      scope: "apps/dev",
    });
  });

  it("handles a slash-free branch at the root scope", () => {
    expect(splitBranchDir("main", hasPackage)).toEqual({ branch: "main", scope: "." });
  });

  it("peels a package scope off a slash-free branch", () => {
    expect(splitBranchDir("main/packages/shared", hasPackage)).toEqual({
      branch: "main",
      scope: "packages/shared",
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
    expect(splitBranchDir("afk/wZ9QP/77-x/apps/memory", hasPackage)).toEqual({
      branch: "afk/wZ9QP/77-x",
      scope: "apps/memory",
    });
  });
});

/**
 * Recording fake IO: tracks every worktreeAdd/install/script/remove call so a
 * test can assert the materialise → install ordering and the install `cwd`. Pure
 * — no real subprocess is ever spawned. `installCode` scripts the `pnpm install`
 * exit so the install-failure path is exercisable. `addOk` controls whether
 * `worktreeAdd` succeeds so the worktree-add-failure path is exercisable.
 */
function fakeIO(
  installCode = 0,
  addOk = true,
  submoduleCode = 0,
): {
  io: FeedbackWorktreeIO;
  calls: Array<{ op: "add" | "submodule" | "install" | "script" | "remove"; dest: string }>;
} {
  const calls: Array<{
    op: "add" | "submodule" | "install" | "script" | "remove";
    dest: string;
  }> = [];
  const io: FeedbackWorktreeIO = {
    worktreeAdd: async (_ctx, dest) => {
      calls.push({ op: "add", dest });
      return addOk;
    },
    pnpm: async (args, opts) => {
      const isInstall = args[0] === "install";
      calls.push({ op: isInstall ? "install" : "script", dest: opts.cwd ?? "" });
      const code = isInstall ? installCode : 0;
      return { code, stdout: "", stderr: code === 0 ? "" : "boom" };
    },
    // The submodule init (git submodule update --init --recursive) runs between
    // worktreeAdd and install; `submoduleCode` scripts its exit so the
    // init-failure path is exercisable.
    exec: async (_cmd, _args, opts) => {
      calls.push({ op: "submodule", dest: opts.cwd ?? "" });
      return { code: submoduleCode, stdout: "", stderr: submoduleCode === 0 ? "" : "boom" };
    },
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

    // add → submodule init → install BEFORE the script runs, all keyed to the worktree.
    expect(calls.map((c) => c.op)).toEqual(["add", "submodule", "install", "script"]);
    expect(calls[0]?.dest).toBe("/root/.red/tmp/feedback/afk-w1-42-fix");
    expect(calls[1]?.dest).toBe("/root/.red/tmp/feedback/afk-w1-42-fix");
    expect(calls[2]?.dest).toBe("/root/.red/tmp/feedback/afk-w1-42-fix");
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

  it("blocks validation (returns exit code 1) when install fails", async () => {
    const { io, calls } = fakeIO(1);
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    const result = await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    await fb.cleanup();

    // A failed install must block: the pnpm executor returns code 1.
    expect(result.code).toBe(1);
    // The partially-created worktree is torn down immediately (not deferred to cleanup).
    expect(calls.filter((c) => c.op === "remove")).toEqual([
      { op: "remove", dest: "/root/.red/tmp/feedback/afk-w1-42-fix" },
    ]);
    // The script was never run.
    expect(calls.filter((c) => c.op === "script")).toHaveLength(0);
  });

  it("blocks validation (returns exit code 1) when submodule init fails", async () => {
    const { io, calls } = fakeIO(0, true, 1);
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    const result = await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    await fb.cleanup();

    // A failed submodule init must block (else @reddb-io/red-castle is unresolved
    // and the gate fails on every check — a false blocked:validation).
    expect(result.code).toBe(1);
    // The partial worktree is torn down immediately, and neither install nor the
    // script ever runs.
    expect(calls.filter((c) => c.op === "remove")).toEqual([
      { op: "remove", dest: "/root/.red/tmp/feedback/afk-w1-42-fix" },
    ]);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "script")).toHaveLength(0);
  });

  it("blocks validation (returns exit code 1) when worktree-add fails", async () => {
    const { io, calls } = fakeIO(0, false);
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    const result = await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);

    // A failed worktree-add must block: the pnpm executor returns code 1.
    expect(result.code).toBe(1);
    // No install or script should run after a failed worktree add.
    expect(calls.filter((c) => c.op === "install")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "script")).toHaveLength(0);
  });
});
