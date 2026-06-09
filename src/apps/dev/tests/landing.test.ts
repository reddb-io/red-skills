import { describe, expect, it } from "vitest";
import { doLanding, type LandingDeps, type LandingInput, type LandingHookContexts } from "../src/core/landing.js";
import type { ExecResult } from "../src/core/merge.js";

// doLanding owns the lock-toggled landing (ADR 0030/0031): push → pre_merge →
// integrate → land → (locked conflict self-resolve) → post_merge. Before this
// extraction the sequence was only exercised through process-issue's integration
// tests; here it has a direct surface. Every git/gh touch is the injected
// mergeExec / remoteGit fake, and the merge hooks are the injected fireHook.

interface Harness {
  deps: LandingDeps;
  input: LandingInput;
  hooks: LandingHookContexts;
  mergeCalls: string[][];
  pushedAttempt: string[][];
  firedHooks: string[];
}

interface Opts {
  locked?: boolean;
  /** Abort one of the merge hooks. */
  abortHook?: "pre_merge" | "post_merge";
  /** rc the integrate fast-forward returns (1 → integrate fails). */
  integrateCode?: number;
  /** rc the locked `merge --no-ff` returns (1 → conflict). */
  mergeNoFfCode?: number;
  /** "resolve" → resolver clears the conflict; "fail" → leaves it; undefined → no resolver. */
  conflictResolve?: "resolve" | "fail";
  /** rc the post-resolve `push <remote> <base>` returns (1 → reject → reset). */
  resolvePushCode?: number;
  /** Enable the opt-in advisory-review wait (afk.merge.wait_for_review). */
  waitForReview?: boolean;
}

function harness(opts: Opts = {}): Harness {
  const mergeCalls: string[][] = [];
  const pushedAttempt: string[][] = [];
  const firedHooks: string[] = [];
  let mergeResolved = false;

  const deps: LandingDeps = {
    mergeExec: async (argv): Promise<ExecResult> => {
      mergeCalls.push(argv);
      const j = argv.join(" ");
      if (argv.includes("pr") && argv.includes("list")) {
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      if (opts.integrateCode !== undefined && j.includes("merge --ff-only")) {
        return { code: opts.integrateCode, stdout: "", stderr: "" };
      }
      if (opts.mergeNoFfCode !== undefined && j.includes("merge --no-ff")) {
        return { code: opts.mergeNoFfCode, stdout: "", stderr: "" };
      }
      // The post-resolve push of the locked branch.
      if (opts.resolvePushCode !== undefined && j === "git -C /repo push origin main") {
        return { code: opts.resolvePushCode, stdout: "", stderr: "" };
      }
      if (j.includes("diff --name-only --diff-filter=U")) {
        const unresolved = opts.conflictResolve === "fail" || !mergeResolved;
        return { code: 0, stdout: unresolved ? "src/x.ts\n" : "", stderr: "" };
      }
      if (j.includes("rev-parse -q --verify MERGE_HEAD")) {
        const pending = opts.conflictResolve === "fail" || !mergeResolved;
        return { code: pending ? 0 : 1, stdout: "", stderr: "" };
      }
      if (j.includes("pr checks")) {
        return { code: 0, stdout: JSON.stringify([{ name: "CodeRabbit", state: "SUCCESS" }]), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    remoteGit: async (argv) => {
      pushedAttempt.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
    async headShortSha() {
      return "abc1234";
    },
    async fireHook(name) {
      firedHooks.push(name);
      return opts.abortHook !== name;
    },
    conflictResolver: opts.conflictResolve
      ? async () => {
          if (opts.conflictResolve === "resolve") mergeResolved = true;
        }
      : undefined,
    waitForReview: opts.waitForReview ? { check: "CodeRabbit", sleep: async () => {} } : undefined,
  };

  const input: LandingInput = {
    locked: opts.locked ?? false,
    repo: "o/r",
    repoDir: "/repo",
    remote: "origin",
    branch: "afk/wAAAA/9-fix-the-thing",
    base: "main",
    issue: 9,
    title: "Fix the thing",
  };

  const hooks: LandingHookContexts = {
    preMerge: () => "pre_merge-ctx",
    postMerge: () => "post_merge-ctx",
  };

  return { deps, input, hooks, mergeCalls, pushedAttempt, firedHooks };
}

const joined = (calls: string[][]): string[] => calls.map((c) => c.join(" "));

describe("doLanding — happy paths", () => {
  it("unlocked → pushes, fires both hooks, lands via admin PR", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    // worker branch pushed before landing.
    expect(h.pushedAttempt.length).toBe(1);
    // both merge hooks fired, in order.
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr list"))).toBe(true);
    expect(j.some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
    // unlocked never merges the attempt branch locally.
    expect(j.some((c) => c.includes("merge --no-ff afk/"))).toBe(false);
  });

  it("unlocked + wait_for_review → polls the review check before the admin-merge", async () => {
    const h = harness({ locked: false, waitForReview: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    const j = joined(h.mergeCalls);
    const checksIdx = j.findIndex((c) => c.includes("pr checks"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --admin --merge"));
    expect(checksIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(checksIdx);
  });

  it("unlocked, default (no wait_for_review) → never polls review checks", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr checks"))).toBe(false);
  });

  it("locked → lands via merge --no-ff into the locked branch + push", async () => {
    const h = harness({ locked: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("merge --no-ff afk/wAAAA/9-fix-the-thing"))).toBe(true);
    expect(j.some((c) => c.includes("pr list") || c.includes("pr merge"))).toBe(false);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });

  it("locked with non-main lock-branch → integrates origin/<lock-branch>, merges attempt, pushes lock-branch (never main)", async () => {
    // Regression: when lock-value != "main", the landing must target the resolved
    // base (lock-branch), not the primary checkout's HEAD which the boot precheck
    // used to force to "main" unconditionally (#569).
    const h = harness({ locked: true });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    // Integrate step synced the lock branch, not main.
    expect(j.some((c) => c.includes("merge --ff-only origin/feature-locked"))).toBe(true);
    expect(j.some((c) => c.includes("merge --ff-only origin/main"))).toBe(false);
    // Attempt branch was merged (into current HEAD = lock-branch after the precheck fix).
    expect(j.some((c) => c.includes("merge --no-ff afk/wAAAA/9-fix-the-thing"))).toBe(true);
    // Push targeted the lock branch, not main.
    expect(j.some((c) => c.includes("push origin feature-locked"))).toBe(true);
    expect(j.some((c) => c.includes("push origin main"))).toBe(false);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });
});

describe("doLanding — abort / failure short-circuits", () => {
  it("pre_merge abort → { ok:false, pre_merge-abort } and never integrates/lands", async () => {
    const h = harness({ locked: false, abortHook: "pre_merge" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "pre_merge-abort", locked: false });
    // push happened (it precedes pre_merge), but no integrate/land and no post_merge.
    expect(h.pushedAttempt.length).toBe(1);
    expect(h.firedHooks).toEqual(["pre_merge"]);
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("merge --ff-only"))).toBe(false);
    expect(j.some((c) => c.includes("pr list"))).toBe(false);
  });

  it("integrate failure → { ok:false, integrate-failed }, never lands or fires post_merge", async () => {
    const h = harness({ locked: false, integrateCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "integrate-failed", locked: false });
    expect(h.firedHooks).toEqual(["pre_merge"]);
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr list"))).toBe(false);
  });

  it("land failure (locked, no resolver) → { ok:false, land-failed, locked:true }", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    // post_merge never fires on a failed land.
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });
});

describe("doLanding — locked conflict self-resolve", () => {
  it("resolver clears the conflict → lands ok, pushes the locked branch", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1, conflictResolve: "resolve" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    // the resolve path pushed the locked base.
    expect(j).toContain("git -C /repo push origin main");
    expect(j.some((c) => c.includes("merge --abort"))).toBe(false);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });

  it("resolver fails → aborts the merge, { ok:false, land-failed }", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1, conflictResolve: "fail" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    const j = joined(h.mergeCalls);
    expect(j).toContain("git -C /repo merge --abort");
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });

  it("resolved but the locked push is rejected → resets to preMergeSha, land-failed", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1, conflictResolve: "resolve", resolvePushCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    const j = joined(h.mergeCalls);
    expect(j).toContain("git -C /repo reset --hard abc1234");
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });

  it("unlocked land failure never attempts the conflict resolver", async () => {
    // landPr fails when the PR list returns nothing; force that by making pr list empty.
    const h = harness({ locked: false });
    h.deps.mergeExec = async (argv) => {
      const j = argv.join(" ");
      if (argv.includes("pr") && argv.includes("list")) return { code: 0, stdout: "\n", stderr: "" };
      if (argv.includes("pr") && argv.includes("create")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: false });
  });
});
