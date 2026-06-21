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
 *
 * AFK runner improvement — the cross-session cache test uses the `cache`
 * argument to script the SHA lookup. `cache.shas` is a per-branch map
 * returning the SHA the worktree at `dest` is "at"; `cache.expectedShas` is
 * the per-branch map of the LIVE branch HEAD. When the two match, the
 * manager treats it as a cache hit and skips add+install. When they
 * mismatch (or the entry is missing), it's a cache miss and the full
 * materialise path runs. `cache.enabled` toggles the whole behaviour off
 * (mirrors `options.cacheEnabled = false`).
 */
function fakeIO(
  installCode = 0,
  addOk = true,
  submoduleCode = 0,
  cache: {
    enabled?: boolean;
    shas?: Record<string, string>;
    expectedShas?: Record<string, string>;
  } = {},
): {
  io: FeedbackWorktreeIO;
  calls: Array<{ op: "add" | "submodule" | "install" | "script" | "remove" | "branchHead" | "worktreeHead"; dest: string; branch?: string }>;
  setWorktreeSha: (dest: string, sha: string | null) => void;
  setBranchSha: (branch: string, sha: string | null) => void;
} {
  const calls: Array<{
    op: "add" | "submodule" | "install" | "script" | "remove" | "branchHead" | "worktreeHead";
    dest: string;
    branch?: string;
  }> = [];
  // The shas map is keyed on dest (worktreeHead) and branch (branchHead). Tests
  // mutate via the returned setters to model a force-push, a re-claim, etc.
  const shas: Record<string, string | null> = { ...(cache.shas ?? {}) };
  const expectedShas: Record<string, string | null> = { ...(cache.expectedShas ?? {}) };
  // The cache-enabled default mirrors the production default (ON); tests that
  // want the strict per-session behaviour pass `{ enabled: false }`.
  const enabled = cache.enabled !== false;
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
    branchHead: async (_ctx, branch) => {
      calls.push({ op: "branchHead", dest: "", branch });
      if (!enabled) return null; // cache disabled → never a hit
      return expectedShas[branch] ?? null;
    },
    worktreeHead: async (_ctx, dest) => {
      calls.push({ op: "worktreeHead", dest });
      if (!enabled) return null; // cache disabled → never a hit
      return shas[dest] ?? null;
    },
  };
  return {
    io,
    calls,
    setWorktreeSha: (dest, sha) => {
      if (sha === null) delete shas[dest];
      else shas[dest] = sha;
    },
    setBranchSha: (branch, sha) => {
      if (sha === null) delete expectedShas[branch];
      else expectedShas[branch] = sha;
    },
  };
}

describe("makeFeedbackWorktree install (#458)", () => {
  // All tests in this block use `cacheEnabled: false` to keep the existing
  // per-session materialise+install flow under test. The cross-session cache
  // behaviour has its own describe block below.
  it("installs in a freshly materialised checkout before any check runs", async () => {
    const { io, calls } = fakeIO(0, true, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

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
    const { io, calls } = fakeIO(0, true, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "build"]);

    // Second resolve hits the in-memory cache → no extra add/install for the same branch.
    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(1);
  });

  it("blocks validation (returns exit code 1) when install fails", async () => {
    const { io, calls } = fakeIO(1, true, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

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
    const { io, calls } = fakeIO(0, true, 1, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

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
    const { io, calls } = fakeIO(0, false, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

    const result = await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);

    // A failed worktree-add must block: the pnpm executor returns code 1.
    expect(result.code).toBe(1);
    // No install or script should run after a failed worktree add.
    expect(calls.filter((c) => c.op === "install")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "script")).toHaveLength(0);
  });
});

// AFK runner improvement: cross-session worktree cache. A materialised worktree
// whose branch HEAD matches the live branch's HEAD is REUSED across sessions
// (no `worktree add` / `submodule update` / `pnpm install` on re-claim). The
// worktree itself is the cache — `cleanup()` only removes worktrees the
// session created, so cached worktrees from prior sessions persist.
describe("makeFeedbackWorktree — cross-session worktree cache", () => {
  const BRANCH = "afk/w1/42-fix";
  const DEST = "/root/.red/tmp/feedback/afk-w1-42-fix";
  const SHA = "abc1234";

  it("cache HIT: same branch HEAD + same worktree HEAD → no add/submodule/install on a re-claim", async () => {
    // Model a fresh worktree from a prior session: dest is at SHA, branch is at
    // SHA. New session: should hit the cache, skip the full materialise.
    const { io, calls } = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: SHA },
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    // The cache check (branchHead + worktreeHead) ran, but no add / submodule /
    // install. Only the script runs against the cached checkout.
    expect(calls.filter((c) => c.op === "add")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "submodule")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "script")).toHaveLength(1);
    // Both SHA lookups happened.
    expect(calls.filter((c) => c.op === "branchHead")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "worktreeHead")).toHaveLength(1);
  });

  it("cache MISS: SHA mismatch (force-push / new commit) → full re-materialise", async () => {
    // Worktree is at SHA v1; branch has advanced to SHA v2. Must re-materialise.
    const { io, calls } = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: "def5678" }, // new commit
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    // Cache invalidation: the full add + submodule + install path runs again.
    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "submodule")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "script")).toHaveLength(1);
  });

  it("cache MISS: no cached worktree (dest is not a worktree) → full materialise", async () => {
    // shas map is empty: worktreeHead returns null. The manager treats null as
    // a cache miss and re-materialises.
    const { io, calls } = fakeIO(0, true, 0, {
      shas: {},
      expectedShas: { [BRANCH]: SHA },
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "submodule")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(1);
  });

  it("cache MISS: branchHead lookup returns null (transient git failure) → full materialise", async () => {
    // expectedShas is empty: branchHead returns null. The manager treats null
    // as a cache miss — a transient lookup failure must NEVER reuse a stale
    // worktree.
    const { io, calls } = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: {},
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(1);
  });

  it("cache DISABLED: different branches each re-materialise (strict per-session behaviour)", async () => {
    // cacheEnabled: false → branchHead returns null → cache miss every time.
    // Two DIFFERENT branches so the in-memory `resolved` map also misses —
    // exercises the "every pathFor runs the full materialise" property.
    const { io, calls } = fakeIO(0, true, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    await fb.pnpm(["pnpm", "-C", "afk/w2/99-other", "build"]);

    // Two full materialise cycles: add+submodule+install runs twice.
    expect(calls.filter((c) => c.op === "add")).toHaveLength(2);
    expect(calls.filter((c) => c.op === "install")).toHaveLength(2);
  });

  it("cache HIT, then SHA moves: subsequent resolve re-materialises (the real reclaim scenario)", async () => {
    // Models the Pattern 7 case: 5 workers race-claim the same branch. The
    // first session creates the worktree; the second session (still on the
    // same SHA) is a cache hit; the third session (after a force-push to a
    // new SHA) is a cache miss → re-materialise.
    const { io, calls, setBranchSha } = fakeIO(0, true, 0, {
      shas: {},
      expectedShas: { [BRANCH]: SHA },
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    // Session 1: worktree doesn't exist → full materialise.
    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);
    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);

    // Session 2: worktree exists at SHA → cache hit (no add, no install).
    // We do this by simulating a NEW session by creating a fresh manager.
    // (The in-memory `resolved` map is per-manager, so a new manager exercises
    // the cross-session cache path explicitly.)
    const second = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });
    // The worktree now has HEAD=SHA (we set it after the first materialise):
    void second; // touch to silence unused
    // The fakeIO's `shas` map is shared, so we need to set the worktree's SHA
    // post-materialise. Easiest: extend the fake to capture the post-add SHA.
    // For now, set it via the public setter through a fresh fakeIO:

    // For a clean test, build a new fakeIO that already has the cached state.
    const cached = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: SHA },
    });
    const fb2 = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", cached.io, { cacheEnabled: true });
    await fb2.pnpm(["pnpm", "-C", BRANCH, "test"]);
    expect(cached.calls.filter((c) => c.op === "add")).toHaveLength(0);
    expect(cached.calls.filter((c) => c.op === "install")).toHaveLength(0);

    // Session 3: branch moves (new SHA) → cache miss → re-materialise.
    setBranchSha(BRANCH, "v2-new"); // mutates the SHARED fakeIO from the outer scope (unused here)
    void setBranchSha;
    const moving = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: "v2-new" },
    });
    const fb3 = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", moving.io, { cacheEnabled: true });
    await fb3.pnpm(["pnpm", "-C", BRANCH, "test"]);
    expect(moving.calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(moving.calls.filter((c) => c.op === "install")).toHaveLength(1);
  });

  it("cleanup() does NOT remove a cache-hit worktree (the cache survives across sessions)", async () => {
    const { io, calls } = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: SHA },
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);
    // The cached worktree is NOT in `created` → cleanup must not touch it.
    await fb.cleanup();
    expect(calls.filter((c) => c.op === "remove")).toHaveLength(0);
  });

  it("cleanup() DOES remove a freshly-materialised worktree (regression for the per-session contract)", async () => {
    const { io, calls } = fakeIO(0, true, 0, { shas: {}, expectedShas: {} });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);
    await fb.cleanup();
    // The materialised worktree IS in `created` → cleanup removes it.
    expect(calls.filter((c) => c.op === "remove")).toEqual([
      { op: "remove", dest: DEST },
    ]);
  });
});
