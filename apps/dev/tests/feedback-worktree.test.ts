import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeFeedbackWorktree,
  resolveCheckoutDir,
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
  _legacySubmoduleCode = 0,
  cache: {
    enabled?: boolean;
    shas?: Record<string, string>;
    expectedShas?: Record<string, string>;
    /** When false, `rebase` returns `{ ok: false }` to model a conflict. */
    rebaseOk?: boolean;
  } = {},
): {
  io: FeedbackWorktreeIO;
  calls: Array<{ op: Op; dest: string; branch?: string; base?: string }>;
  setWorktreeSha: (dest: string, sha: string | null) => void;
  setBranchSha: (branch: string, sha: string | null) => void;
} {
  const calls: Array<{ op: Op; dest: string; branch?: string; base?: string }> = [];
  // The shas map is keyed on dest (worktreeHead) and branch (branchHead). Tests
  // mutate via the returned setters to model a force-push, a re-claim, etc.
  const shas: Record<string, string | null> = { ...(cache.shas ?? {}) };
  const expectedShas: Record<string, string | null> = { ...(cache.expectedShas ?? {}) };
  // The cache-enabled default mirrors the production default (ON); tests that
  // want the strict per-session behaviour pass `{ enabled: false }`.
  const enabled = cache.enabled !== false;
  const rebaseOk = cache.rebaseOk !== false;
  const io: FeedbackWorktreeIO = {
    worktreeAdd: async (_ctx, dest) => {
      calls.push({ op: "add", dest });
      // A refused add carries the real git stderr (#2339), never a bare false.
      return addOk
        ? { ok: true, stderr: "" }
        : { ok: false, stderr: "fatal: couldn't find remote ref refs/heads/nope" };
    },
    pnpm: async (args, opts) => {
      const isInstall = args[0] === "install";
      calls.push({ op: isInstall ? "install" : "script", dest: opts.cwd ?? "" });
      const code = isInstall ? installCode : 0;
      return { code, stdout: "", stderr: code === 0 ? "" : "boom" };
    },
    exec: async (_cmd, _args, opts) => {
      calls.push({ op: "script", dest: opts.cwd ?? "" });
      return { code: 0, stdout: "", stderr: "" };
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
    rebase: async (_ctx, dest, base) => {
      calls.push({ op: "rebase", dest, base });
      return rebaseOk ? { ok: true } : { ok: false, stderr: "CONFLICT (content): merge conflict in x" };
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

type Op = "add" | "install" | "script" | "remove" | "branchHead" | "worktreeHead" | "rebase";

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

    // add → install BEFORE the script runs, all keyed to the worktree.
    expect(calls.map((c) => c.op)).toEqual(["add", "install", "script"]);
    expect(calls[0]?.dest).toBe("/root/.red/tmp/feedback/afk-w1-42-fix");
    expect(calls[1]?.dest).toBe("/root/.red/tmp/feedback/afk-w1-42-fix");
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

  it("self-heals a stale worktree on 'already exists' — removes and recreates (#2379)", async () => {
    // Model: first worktreeAdd fails with "already exists"; the manager removes
    // the stale worktree and retries; the retry succeeds.
    const calls: Array<{ op: string; dest: string }> = [];
    let addAttempt = 0;
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async (_ctx, dest) => {
        addAttempt += 1;
        calls.push({ op: "add", dest });
        if (addAttempt === 1) {
          return { ok: false, stderr: "fatal: '/dest' already exists" };
        }
        return { ok: true, stderr: "" };
      },
      worktreeRemove: async (_ctx, dest) => {
        calls.push({ op: "remove", dest });
      },
      pnpm: async (args, opts) => {
        const isInstall = args[0] === "install";
        calls.push({ op: isInstall ? "install" : "script", dest: opts.cwd ?? "" });
        return { code: 0, stdout: "", stderr: "" };
      },
      exec: async (_cmd, _args, opts) => {
        calls.push({ op: "script", dest: opts.cwd ?? "" });
        return { code: 0, stdout: "", stderr: "" };
      },
      branchHead: async () => null,
      worktreeHead: async () => null,
      rebase: async () => ({ ok: true }),
    };
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

    const result = await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);

    // Self-heal succeeds: the gate runs normally.
    expect(result.code).toBe(0);
    // First add failed, then remove, then second add, then install, then script.
    expect(calls.map((c) => c.op)).toEqual(["add", "remove", "add", "install", "script"]);
    expect(addAttempt).toBe(2);
  });

  it("surfaces the underlying git stderr on a failed worktree add (#2339)", async () => {
    const { io } = fakeIO(0, false, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    } finally {
      process.stderr.write = realWrite;
    }

    // Field reports had to GUESS the root cause from "add failed" alone (#2338).
    const line = written.find((l) => l.includes("feedback worktree add failed"));
    expect(line).toContain("fatal: couldn't find remote ref refs/heads/nope");
  });
});

describe("host-wide validation gate semaphore (#2487)", () => {
  it("never runs a reconcile gate command alongside a live worker gate command", async () => {
    let held = false;
    const waiters: Array<() => void> = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;

    const ioFor = (): FeedbackWorktreeIO => {
      const base = fakeIO(0, true, 0, { enabled: false }).io;
      return {
        ...base,
        gateLock: async () => {
          if (held) await new Promise<void>((resolve) => waiters.push(resolve));
          held = true;
          return async () => {
            held = false;
            waiters.shift()?.();
          };
        },
        pnpm: async (args, opts) => {
          if (args[0] === "install") return base.pnpm(args, opts);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return { code: 0, stdout: "", stderr: "" };
        },
      } as FeedbackWorktreeIO;
    };

    const worker = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", ioFor(), {
      cacheEnabled: false,
    });
    const reconcile = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", ioFor(), {
      cacheEnabled: false,
    });

    const first = worker.pnpm(["pnpm", "-C", "afk/wLIVE/1-work", "test"]);
    while (releases.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const second = reconcile.pnpm(["pnpm", "-C", "afk/wBOOT/2-reconcile", "test"]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(maxActive).toBe(1);
    releases.shift()?.();
    while (releases.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    releases.shift()?.();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });
});

// #2339: the post-merge integration gate (#1335) hands the feedback executors
// the isolated rebase/landing worktree DIR, not a branch name. Treating that dir
// as a branch made `git fetch origin <dir>` fail, blocked ALL validation
// (`durationMs: 0` on every check), and parked a phantom merge-conflict.
describe("makeFeedbackWorktree — already-materialised checkout token (#2339)", () => {
  /**
   * A temp primary checkout (so the layout probe sees `apps/dev` as a real
   * package) plus a sibling dir that looks to git like a linked worktree: a
   * `.git` FILE at its root, exactly what `git worktree add` writes.
   */
  function makeFixture(): { root: string; dir: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), "red-gate-"));
    const root = join(base, "repo");
    mkdirSync(join(root, "apps", "dev"), { recursive: true });
    writeFileSync(join(root, "apps", "dev", "package.json"), JSON.stringify({ name: "dev" }));
    const dir = join(base, "rebase-wt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    return { root, dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it("recognises a checkout dir and never fetches it as a branch", () => {
    const { root, dir, cleanup } = makeFixture();
    try {
      expect(resolveCheckoutDir(dir, root)).toBe(dir);
      // A worker branch name is never mistaken for a path.
      expect(resolveCheckoutDir("afk/w1/42-fix", root)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("runs the gate IN the rebase worktree instead of blocking validation", async () => {
    const { root, dir, cleanup } = makeFixture();
    try {
      // addOk=false models the field failure exactly: fetching a filesystem
      // path as a branch always fails, so any add attempt here blocks the gate.
      const { io, calls } = fakeIO(0, false, 0, { enabled: false });
      const fb = makeFeedbackWorktree(root, join(root, ".red/tmp/feedback"), io, {
        cacheEnabled: false,
      });

      // The exact call shape of postMergeGate: a `-C <rebase-worktree>/<scope>`
      // token plus a root-scoped backpressure command in the same dir.
      const gate = await fb.pnpm(["pnpm", "-C", `${dir}/apps/dev`, "test"]);
      const bp = await fb.backpressure({ command: "pnpm test", cwd: dir, timeoutMs: 1000 });

      expect(gate.code).toBe(0);
      expect(bp.code).toBe(0);
      // The caller already provisioned the checkout — no add, no re-install.
      expect(calls.filter((c) => c.op === "add")).toHaveLength(0);
      expect(calls.filter((c) => c.op === "install")).toHaveLength(0);
      // And the commands ran in that dir, not the primary checkout.
      expect(calls.filter((c) => c.op === "script").map((c) => c.dest)).toContain(dir);
    } finally {
      cleanup();
    }
  });
});

// AFK runner improvement: cross-session worktree cache. A materialised worktree
// whose branch HEAD matches the live branch's HEAD is REUSED across sessions
// (no `worktree add` / `pnpm install` on re-claim). The
// worktree itself is the cache — `cleanup()` only removes worktrees the
// session created, so cached worktrees from prior sessions persist.
describe("makeFeedbackWorktree — cross-session worktree cache", () => {
  const BRANCH = "afk/w1/42-fix";
  const DEST = "/root/.red/tmp/feedback/afk-w1-42-fix";
  const SHA = "abc1234";

  it("cache HIT: same branch HEAD + same worktree HEAD → no add/install on a re-claim", async () => {
    // Model a fresh worktree from a prior session: dest is at SHA, branch is at
    // SHA. New session: should hit the cache, skip the full materialise.
    const { io, calls } = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: SHA },
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: true });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    // The cache check (branchHead + worktreeHead) ran, but no add / install.
    // Only the script runs against the cached checkout.
    expect(calls.filter((c) => c.op === "add")).toHaveLength(0);
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

    // Cache invalidation: the full add + install path runs again.
    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);
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

    // Two full materialise cycles: add+install runs twice.
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

// AFK runner improvement (Pattern 2): when `rebaseOnto` is set, a freshly
// materialised worker worktree is rebased onto the session base BEFORE the gate
// runs so a worker test written against a now-moved main validates against the
// latest source. Best-effort: a conflict aborts and the gate runs un-rebased
// (the baseline probe then downgrades the resulting pre-existing failure).
describe("makeFeedbackWorktree — rebaseOnto (Pattern 2 drift mitigation)", () => {
  const BRANCH = "afk/w1/42-fix";
  const DEST = "/root/.red/tmp/feedback/afk-w1-42-fix";
  const SHA = "abc1234";

  it("rebases a freshly materialised worktree onto the base AFTER install, BEFORE the script", async () => {
    const { io, calls } = fakeIO(0, true, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, {
      cacheEnabled: false,
      rebaseOnto: "main",
    });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    // Order: add → install → rebase → script.
    expect(calls.map((c) => c.op)).toEqual(["add", "install", "rebase", "script"]);
    const rebaseCall = calls.find((c) => c.op === "rebase")!;
    expect(rebaseCall.dest).toBe(DEST);
    expect(rebaseCall.base).toBe("main");
  });

  it("does NOT rebase when `rebaseOnto` is unset (default OFF — no behaviour change)", async () => {
    const { io, calls } = fakeIO(0, true, 0, { enabled: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    expect(calls.filter((c) => c.op === "rebase")).toHaveLength(0);
    expect(calls.map((c) => c.op)).toEqual(["add", "install", "script"]);
  });

  it("a rebase CONFLICT does not block the gate — the script still runs (best-effort)", async () => {
    const { io, calls } = fakeIO(0, true, 0, { enabled: false, rebaseOk: false });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, {
      cacheEnabled: false,
      rebaseOnto: "main",
    });

    const result = await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    // The rebase failed, but the gate still ran (the script executed) and the
    // result is the script's result (code 0 here), NOT a blocked validation.
    expect(result.code).toBe(0);
    expect(calls.filter((c) => c.op === "rebase")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "script")).toHaveLength(1);
  });

  it("does NOT rebase on a CACHE HIT (the cached worktree is already at the branch HEAD)", async () => {
    // Cache hit: branch HEAD == worktree HEAD → skip the full materialise AND
    // the rebase. Re-rebasing would invalidate the cache for no benefit.
    const { io, calls } = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: SHA },
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, {
      cacheEnabled: true,
      rebaseOnto: "main",
    });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    expect(calls.filter((c) => c.op === "rebase")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "add")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "script")).toHaveLength(1);
  });

  it("DOES rebase on a cache MISS that re-materialises (the base moved → re-validate against it)", async () => {
    const { io, calls } = fakeIO(0, true, 0, {
      shas: { [DEST]: SHA },
      expectedShas: { [BRANCH]: "def5678" }, // branch moved → cache miss
    });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, {
      cacheEnabled: true,
      rebaseOnto: "main",
    });

    await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);

    expect(calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "rebase")).toHaveLength(1);
  });
});

describe("gate test subprocess env (#1215 / #1224 Part C)", () => {
  // A /go (or scout) worker runs the feedback gate with RED_AFK_WORKERS_NAMESPACE
  // pinned to its lane. That must NOT leak into the gate's `pnpm -C <scope> test`
  // subprocess, or namespace-sensitive suites (worker-paths, supervisor-fs) see
  // the /go lane instead of the default and fail — a false full-suite red that
  // parks otherwise-green work (this leak cost issue #1219 ~70 minutes).
  function captureEnvIO(): { io: FeedbackWorktreeIO; envsFor: (script: string) => NodeJS.ProcessEnv[] } {
    const seen: Array<{ script: string; env: NodeJS.ProcessEnv | undefined }> = [];
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async () => ({ ok: true, stderr: "" }),
      pnpm: async (args, opts) => {
        // The gate rewrites the token to ["-C", <path>, <script>]; "install" is
        // the materialise step, everything else is a gate check.
        const script = args[0] === "install" ? "install" : (args[2] ?? args[1] ?? "");
        seen.push({ script, env: opts.env });
        return { code: 0, stdout: "", stderr: "" };
      },
      exec: async (cmd, args, opts) => {
        const script = cmd === "sh" ? `sh:${args.join(" ")}` : cmd;
        seen.push({ script, env: opts.env });
        return { code: 0, stdout: "", stderr: "" };
      },
      worktreeRemove: async () => {},
      branchHead: async () => null,
      worktreeHead: async () => null,
      rebase: async () => ({ ok: true }),
    };
    return { io, envsFor: (script) => seen.filter((s) => s.script === script).map((s) => s.env ?? {}) };
  }

  it("runs gate pnpm subprocesses with AFK path-routing env unset", async () => {
    const prevNamespace = process.env.RED_AFK_WORKERS_NAMESPACE;
    const prevWorkerId = process.env.RED_AFK_WORKER_ID;
    const prevIterDir = process.env.RED_AFK_ITER_DIR;
    process.env.RED_AFK_WORKERS_NAMESPACE = "go-workers"; // the /go lane leak
    process.env.RED_AFK_WORKER_ID = "go-dispatch-worker";
    process.env.RED_AFK_ITER_DIR = "/tmp/go-workers/go-dispatch-worker/1215-a1";
    try {
      const { io, envsFor } = captureEnvIO();
      const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, { cacheEnabled: false });

      await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
      await fb.pnpm(["pnpm", "-C", "origin/main", "test"]);

      const envs = envsFor("test");
      // The gate's test subprocess env exists and does NOT carry AFK
      // path-routing dispatch vars into worker-path-sensitive suites.
      expect(envs).toHaveLength(2);
      for (const env of envs) {
        expect("RED_AFK_WORKERS_NAMESPACE" in env).toBe(false);
        expect("RED_AFK_WORKER_ID" in env).toBe(false);
        expect("RED_AFK_ITER_DIR" in env).toBe(false);
      }
      // The worker's own process env is untouched (we scrub a copy, not the real env).
      expect(process.env.RED_AFK_WORKERS_NAMESPACE).toBe("go-workers");
      expect(process.env.RED_AFK_WORKER_ID).toBe("go-dispatch-worker");
      expect(process.env.RED_AFK_ITER_DIR).toBe("/tmp/go-workers/go-dispatch-worker/1215-a1");
    } finally {
      if (prevNamespace === undefined) delete process.env.RED_AFK_WORKERS_NAMESPACE;
      else process.env.RED_AFK_WORKERS_NAMESPACE = prevNamespace;
      if (prevWorkerId === undefined) delete process.env.RED_AFK_WORKER_ID;
      else process.env.RED_AFK_WORKER_ID = prevWorkerId;
      if (prevIterDir === undefined) delete process.env.RED_AFK_ITER_DIR;
      else process.env.RED_AFK_ITER_DIR = prevIterDir;
    }
  });

  it("applies validation resource budget to pnpm and backpressure subprocesses", async () => {
    const { io, envsFor } = captureEnvIO();
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io, {
      cacheEnabled: false,
      resourceBudget: { nodeMaxOldSpaceMb: 1536, vitestMaxWorkers: 2 },
    });

    await fb.pnpm(["pnpm", "-C", "afk/w1/42-fix", "test"]);
    await fb.backpressure({ command: "pnpm --dir apps/rsp test", cwd: "afk/w1/42-fix", timeoutMs: 1000 });

    const envs = [...envsFor("test"), ...envsFor("sh:-c pnpm --dir apps/rsp test")];
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env.NODE_OPTIONS).toContain("--max-old-space-size=1536");
      expect(env.VITEST_MAX_WORKERS).toBe("2");
    }
  });
});

// #2437: the `feedback/main` baseline worktree is a singleton shared by every
// landing revalidation on the host. Three landing tails failed in one night with
// `feedback worktree setup failed for main; validation blocked` while a sibling
// worker was landing — the loser of an unserialized `worktree add` + `pnpm
// install` race. Each collision burned a full ~25-minute revalidation cycle.
describe("makeFeedbackWorktree — shared baseline serialization (#2437)", () => {
  const BRANCH = "main";
  const DEST = "/root/.red/tmp/feedback/main";
  const SHA = "base1234";

  /**
   * Two managers (modelling two worker PROCESSES) over one shared baseline
   * worktree. `shas[DEST]` is the on-disk state both see, so a materialise by
   * one manager is visible to the other — exactly the shared-singleton
   * semantics of the real directory.
   *
   * `worktreeAdd` is deliberately hostile: it refuses with git's real "already
   * exists" while another add/install is in flight, and it takes a turn of the
   * event loop, so an unserialized pair of managers reproduces the field
   * failure. `lock` is a shared in-memory mutex keyed by path, standing in for
   * the O_EXCL lock file the production IO uses.
   */
  function sharedBaselineIO(opts: { serialize: boolean }): {
    ioFor: () => FeedbackWorktreeIO;
    calls: Array<{ op: Op; dest: string }>;
    maxConcurrentSetups: () => number;
  } {
    const calls: Array<{ op: Op; dest: string }> = [];
    const shas: Record<string, string> = {};
    const busy = new Set<string>();
    let setupsInFlight = 0;
    let maxSetups = 0;
    // One mutex per path, shared by every manager this helper builds.
    const held = new Set<string>();
    const waiters: Array<() => void> = [];

    const io = (): FeedbackWorktreeIO => ({
      worktreeAdd: async (_ctx, dest) => {
        calls.push({ op: "add", dest });
        if (busy.has(dest)) {
          return { ok: false, stderr: `fatal: '${dest}' already exists` };
        }
        busy.add(dest);
        setupsInFlight += 1;
        maxSetups = Math.max(maxSetups, setupsInFlight);
        await Promise.resolve();
        return { ok: true, stderr: "" };
      },
      pnpm: async (args, opts2) => {
        const isInstall = args[0] === "install";
        // An install runs with `cwd` at the worktree; a check runs from the
        // primary root with the worktree in its rewritten `-C` arg.
        const cIdx = args.indexOf("-C");
        const dest = isInstall ? (opts2.cwd ?? "") : (args[cIdx + 1] ?? opts2.cwd ?? "");
        calls.push({ op: isInstall ? "install" : "script", dest });
        if (!isInstall) return { code: 0, stdout: "", stderr: "" };
        // The install is the long pole — yield so a concurrent manager gets a
        // chance to collide with it.
        await Promise.resolve();
        shas[opts2.cwd ?? ""] = SHA;
        busy.delete(opts2.cwd ?? "");
        setupsInFlight -= 1;
        return { code: 0, stdout: "", stderr: "" };
      },
      exec: async (_cmd, _args, opts2) => {
        calls.push({ op: "script", dest: opts2.cwd ?? "" });
        return { code: 0, stdout: "", stderr: "" };
      },
      worktreeRemove: async (_ctx, dest) => {
        calls.push({ op: "remove", dest });
        busy.delete(dest);
        delete shas[dest];
      },
      branchHead: async (_ctx, branch) => (branch === BRANCH ? SHA : null),
      worktreeHead: async (_ctx, dest) => shas[dest] ?? null,
      rebase: async () => ({ ok: true }),
      ...(opts.serialize
        ? {
            lock: async (dest: string) => {
              while (held.has(dest)) {
                await new Promise<void>((resolve) => waiters.push(resolve));
              }
              held.add(dest);
              return async () => {
                held.delete(dest);
                for (const wake of waiters.splice(0)) wake();
              };
            },
          }
        : {}),
    });

    return { ioFor: io, calls, maxConcurrentSetups: () => maxSetups };
  }

  it("serializes two concurrent revalidations — the loser gets a cache hit, not a failure", async () => {
    const shared = sharedBaselineIO({ serialize: true });
    const a = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", shared.ioFor());
    const b = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", shared.ioFor());

    const [ra, rb] = await Promise.all([
      a.pnpm(["pnpm", "-C", BRANCH, "test"]),
      b.pnpm(["pnpm", "-C", BRANCH, "test"]),
    ]);

    // Neither revalidation is blocked — this is the whole point of the fix.
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    // Only ONE manager materialised: the waiter re-checked the cache under the
    // lock, found the freshly-installed worktree, and skipped add + install.
    expect(shared.calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(shared.calls.filter((c) => c.op === "install")).toHaveLength(1);
    expect(shared.maxConcurrentSetups()).toBe(1);
    // Both still ran their check against the shared baseline.
    expect(shared.calls.filter((c) => c.op === "script" && c.dest === DEST)).toHaveLength(2);
  });

  it("without the lock the two setups collide on one directory — the regression this guards", async () => {
    // Same fixture, serialization removed. The loser's add is refused
    // ("already exists"), it force-removes the winner's half-installed
    // worktree, and both processes end up materialising the same directory at
    // once — the corruption that surfaced as `setup failed for main`.
    const shared = sharedBaselineIO({ serialize: false });
    const a = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", shared.ioFor());
    const b = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", shared.ioFor());

    await Promise.all([
      a.pnpm(["pnpm", "-C", BRANCH, "test"]),
      b.pnpm(["pnpm", "-C", BRANCH, "test"]),
    ]);

    // Two adds and two installs against ONE path, overlapping in time, plus the
    // loser ripping out the winner's checkout mid-install.
    expect(shared.calls.filter((c) => c.op === "add").length).toBeGreaterThan(1);
    expect(shared.calls.filter((c) => c.op === "remove").length).toBeGreaterThan(0);
    expect(shared.maxConcurrentSetups()).toBe(2);
  });

  it("retries a contended setup instead of latching the whole session as blocked", async () => {
    // First materialise attempt fails (a collision); the next validation call
    // must try again rather than short-circuit to code 1 for the rest of the
    // ~25-minute cycle.
    let attempt = 0;
    const shas: Record<string, string> = {};
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async (_ctx, dest) => {
        attempt += 1;
        if (attempt === 1) return { ok: false, stderr: "fatal: unable to lock ref" };
        shas[dest] = SHA;
        return { ok: true, stderr: "" };
      },
      worktreeRemove: async () => {},
      pnpm: async () => ({ code: 0, stdout: "", stderr: "" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      branchHead: async (_ctx, branch) => (branch === BRANCH ? SHA : null),
      worktreeHead: async (_ctx, dest) => shas[dest] ?? null,
      rebase: async () => ({ ok: true }),
    };
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    const first = await fb.pnpm(["pnpm", "-C", BRANCH, "test"]);
    const second = await fb.pnpm(["pnpm", "-C", BRANCH, "build"]);

    expect(first.code).toBe(1);
    expect(second.code).toBe(0);
    expect(attempt).toBe(2);
  });

  it("latches after three consecutive failures so a truly broken baseline stops retrying", async () => {
    let adds = 0;
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async () => {
        adds += 1;
        return { ok: false, stderr: "fatal: couldn't find remote ref refs/heads/main" };
      },
      worktreeRemove: async () => {},
      pnpm: async () => ({ code: 0, stdout: "", stderr: "" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      branchHead: async () => null,
      worktreeHead: async () => null,
      rebase: async () => ({ ok: true }),
    };
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    for (let i = 0; i < 5; i++) {
      expect((await fb.pnpm(["pnpm", "-C", BRANCH, "test"])).code).toBe(1);
    }
    // Three attempts, then the branch is latched — no unbounded retry storm.
    expect(adds).toBe(3);
  });

  it("shares one materialise across concurrent calls in the same process", async () => {
    const shared = sharedBaselineIO({ serialize: true });
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", shared.ioFor());

    await Promise.all([
      fb.pnpm(["pnpm", "-C", BRANCH, "test"]),
      fb.pnpm(["pnpm", "-C", BRANCH, "build"]),
      fb.backpressure({ command: "pnpm test", cwd: BRANCH, timeoutMs: 1000 }),
    ]);

    expect(shared.calls.filter((c) => c.op === "add")).toHaveLength(1);
    expect(shared.calls.filter((c) => c.op === "install")).toHaveLength(1);
  });
});

// #2964 — `materialise()` returns a bare `null` on three distinct paths, and the
// blocked message named none of them. A field report on `reddb-io/brand` could
// not conclude which one fired ("lock contention" was stated as a suspicion
// precisely because the evidence had been thrown away), so every recurrence was
// a fresh investigation. Each path now carries its own cause into the message
// the validation record's `summary` is built from.
describe("makeFeedbackWorktree setup failure names its cause (#2964)", () => {
  const BROKEN = "afk/w1/9-x";

  it("names a failed `worktree add`, carrying git's own stderr", async () => {
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async () => ({ ok: false, stderr: "fatal: couldn't find remote ref refs/heads/nope" }),
      worktreeRemove: async () => {},
      pnpm: async () => ({ code: 0, stdout: "", stderr: "" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      branchHead: async () => null,
      worktreeHead: async () => null,
      rebase: async () => ({ ok: true }),
    };
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    const r = await fb.backpressure({ command: "bash scripts/gate.sh", cwd: BROKEN, timeoutMs: 1000 });

    expect(r.code).toBe(1);
    // The literal the INFRA classifier matches survives verbatim…
    expect(r.stderr).toContain("feedback worktree setup failed");
    // …and the cause is appended after it.
    expect(r.stderr).toContain("worktree add failed");
    expect(r.stderr).toContain("couldn't find remote ref refs/heads/nope");
  });

  it("names a failed install, with its exit code and pnpm's stderr", async () => {
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async () => ({ ok: true, stderr: "" }),
      worktreeRemove: async () => {},
      pnpm: async () => ({ code: 1, stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      branchHead: async () => null,
      worktreeHead: async () => null,
      rebase: async () => ({ ok: true }),
    };
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    const r = await fb.backpressure({ command: "bash scripts/gate.sh", cwd: BROKEN, timeoutMs: 1000 });

    expect(r.stderr).toContain("pnpm install --frozen-lockfile failed (exit 1)");
    expect(r.stderr).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    // Distinguishable from the add path — that is the whole point.
    expect(r.stderr).not.toContain("worktree add failed");
  });

  it("names a lock-wait timeout, which no other path can be mistaken for", async () => {
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async () => ({ ok: true, stderr: "" }),
      worktreeRemove: async () => {},
      pnpm: async () => ({ code: 0, stdout: "", stderr: "" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      branchHead: async () => null,
      worktreeHead: async () => null,
      rebase: async () => ({ ok: true }),
      lock: async () => null, // the wait timed out
    };
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    const r = await fb.backpressure({ command: "bash scripts/gate.sh", cwd: BROKEN, timeoutMs: 1000 });

    expect(r.stderr).toContain("lock wait timed out");
    expect(r.stderr).not.toContain("worktree add failed");
    expect(r.stderr).not.toContain("pnpm install");
  });

  it("keeps the cause on the LATCHED calls — the ones a reader actually sees", async () => {
    const io: FeedbackWorktreeIO = {
      worktreeAdd: async () => ({ ok: false, stderr: "fatal: couldn't find remote ref refs/heads/nope" }),
      worktreeRemove: async () => {},
      pnpm: async () => ({ code: 0, stdout: "", stderr: "" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      branchHead: async () => null,
      worktreeHead: async () => null,
      rebase: async () => ({ ok: true }),
    };
    const fb = makeFeedbackWorktree("/root", "/root/.red/tmp/feedback", io);

    // Burn through MAX_SETUP_ATTEMPTS so the branch latches to `resolved -> null`.
    for (let i = 0; i < 3; i++) await fb.backpressure({ command: "x", cwd: BROKEN, timeoutMs: 1000 });
    const latched = await fb.backpressure({ command: "x", cwd: BROKEN, timeoutMs: 1000 });

    expect(latched.stderr).toContain("worktree add failed");
  });
});
