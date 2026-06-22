import { describe, expect, it } from "vitest";
import { doLanding, type LandingDeps, type LandingInput, type LandingHookContexts } from "../src/core/landing.js";
import type { ExecResult } from "../src/core/merge.js";

// doLanding owns the flag-toggled landing (ADR 0030 amended by #842 / 0031):
// push → pre_merge → integrate → land → (direct conflict self-resolve) →
// post_merge. Before this extraction the sequence was only exercised through
// process-issue's integration tests; here it has a direct surface. Every git/gh
// touch is the injected mergeExec / remoteGit fake, and the merge hooks are the
// injected fireHook.
//
// Landing MODE is the `openPr` flag (afk.worktree_launches_pull_request), NOT the
// lock — the lock only resolves `base` (#842). The "lock × flag matrix" suite
// below covers all four cells; the legacy path suites default the flag to the
// pre-#842 coupling (locked → direct, unlocked → PR) so they keep their meaning.

// The isolated landing worktree the DIRECT path runs every git op in (#572). The
// primary checkout (`/repo`) is never `git -C`'d destructively — see the
// "primary checkout is sacred" suite below.
const WT = "/wt";

interface Harness {
  deps: LandingDeps;
  input: LandingInput;
  hooks: LandingHookContexts;
  mergeCalls: string[][];
  pushedAttempt: string[][];
  firedHooks: string[];
  removedWorktrees: string[];
  /** cwds the conflict resolver was dispatched in. */
  resolverCwds: string[];
}

interface Opts {
  locked?: boolean;
  /**
   * Landing MODE (#842), decoupled from the lock. Defaults to `!locked` so the
   * pre-#842 coupling is preserved for the existing path tests (locked → direct,
   * unlocked → PR); the (lock × flag) matrix suite below sets it explicitly to
   * exercise the two newly-reachable cells.
   */
  openPr?: boolean;
  /** Abort one of the merge hooks. */
  abortHook?: "pre_merge" | "post_merge";
  /** rc the integrate fast-forward returns (1 → integrate fails). */
  integrateCode?: number;
  /** rc the locked `merge --no-ff` returns (1 → conflict). */
  mergeNoFfCode?: number;
  /** "resolve" → resolver clears the conflict; "fail" → leaves it; undefined → no resolver. */
  conflictResolve?: "resolve" | "fail";
  /** rc the post-resolve `push <remote> HEAD:refs/heads/<base>` returns (1 → reject → reset). */
  resolvePushCode?: number;
  /** Enable the opt-in advisory-review wait (afk.merge.wait_for_review). */
  waitForReview?: boolean;
  /** Enable the opt-in CI-aware merge (#812) and drive the `pr view` verdict. */
  ciAware?: "merge" | "ci-failed" | "ci-pending" | "conflict";
  /** Make the landing-worktree provisioner fail (returns null). */
  noWorktree?: boolean;
  /** Commits ahead of base returned by `git rev-list --count`. Default 3. */
  commitCount?: number;
}

function harness(opts: Opts = {}): Harness {
  const mergeCalls: string[][] = [];
  const pushedAttempt: string[][] = [];
  const firedHooks: string[] = [];
  const removedWorktrees: string[] = [];
  const resolverCwds: string[] = [];
  let mergeResolved = false;

  const deps: LandingDeps = {
    mergeExec: async (argv): Promise<ExecResult> => {
      mergeCalls.push(argv);
      const j = argv.join(" ");
      if (argv.includes("pr") && argv.includes("list")) {
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      // The rollback anchor + landed sha the locked worktree path reads.
      if (j.includes("rev-parse --short HEAD")) {
        return { code: 0, stdout: "abc1234\n", stderr: "" };
      }
      if (j.includes("rev-list") && j.includes("--count")) {
        return { code: 0, stdout: `${opts.commitCount ?? 3}\n`, stderr: "" };
      }
      if (opts.integrateCode !== undefined && j.includes("merge --ff-only")) {
        return { code: opts.integrateCode, stdout: "", stderr: "" };
      }
      if (opts.mergeNoFfCode !== undefined && j.includes("merge --no-ff")) {
        return { code: opts.mergeNoFfCode, stdout: "", stderr: "" };
      }
      // The post-resolve push of the locked branch (from the worktree HEAD).
      if (opts.resolvePushCode !== undefined && j === `git -C ${WT} push origin HEAD:refs/heads/main`) {
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
      if (j.includes("pr view")) {
        // #812 CI-aware poll: drive the mergeStateStatus + rollup per opts.ciAware.
        const map: Record<string, { mergeStateStatus: string; statusCheckRollup: unknown[] }> = {
          merge: { mergeStateStatus: "CLEAN", statusCheckRollup: [] },
          "ci-failed": { mergeStateStatus: "BLOCKED", statusCheckRollup: [{ state: "FAILURE" }] },
          "ci-pending": { mergeStateStatus: "BLOCKED", statusCheckRollup: [{ status: "IN_PROGRESS" }] },
          conflict: { mergeStateStatus: "DIRTY", statusCheckRollup: [] },
        };
        return { code: 0, stdout: JSON.stringify(map[opts.ciAware ?? "merge"]), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    remoteGit: async (argv) => {
      pushedAttempt.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
    async fireHook(name) {
      firedHooks.push(name);
      return opts.abortHook !== name;
    },
    conflictResolver: opts.conflictResolve
      ? async (_prompt, cwd) => {
          resolverCwds.push(cwd);
          if (opts.conflictResolve === "resolve") mergeResolved = true;
        }
      : undefined,
    waitForReview: opts.waitForReview ? { check: "CodeRabbit", sleep: async () => {} } : undefined,
    ciAwait: opts.ciAware ? { sleep: async () => {}, maxPolls: 2 } : undefined,
    makeLandingWorktree: async () => (opts.noWorktree ? null : WT),
    removeLandingWorktree: async (dir) => {
      removedWorktrees.push(dir);
    },
  };

  const input: LandingInput = {
    locked: opts.locked ?? false,
    // Default the mode to the pre-#842 coupling (locked → direct, unlocked → PR)
    // unless the test pins the flag to exercise a decoupled cell.
    openPr: opts.openPr ?? !(opts.locked ?? false),
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

  return { deps, input, hooks, mergeCalls, pushedAttempt, firedHooks, removedWorktrees, resolverCwds };
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
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("merge --no-ff --no-verify afk/wAAAA/9-fix-the-thing"))).toBe(true);
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
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    // Integrate step synced the lock branch, not main.
    expect(j.some((c) => c.includes("merge --ff-only origin/feature-locked"))).toBe(true);
    expect(j.some((c) => c.includes("merge --ff-only origin/main"))).toBe(false);
    // Attempt branch was merged (into current HEAD = lock-branch after the precheck fix).
    expect(j.some((c) => c.includes("merge --no-ff --no-verify afk/wAAAA/9-fix-the-thing"))).toBe(true);
    // Push targeted the lock branch (worktree HEAD → refs/heads/<base>), not main.
    expect(j.some((c) => c.includes("push origin HEAD:refs/heads/feature-locked"))).toBe(true);
    expect(j.some((c) => c.includes("refs/heads/main"))).toBe(false);
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

  it("integrate failure (locked, in the worktree) → { ok:false, integrate-failed }, never lands or fires post_merge", async () => {
    // Integrate now runs only on the LOCKED path, inside the isolated worktree
    // (#572) — the unlocked admin-PR path no longer integrates the primary at all.
    const h = harness({ locked: true, integrateCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "integrate-failed", locked: true });
    expect(h.firedHooks).toEqual(["pre_merge"]);
    const j = joined(h.mergeCalls);
    // The integrate ran against the worktree, never merged the attempt.
    expect(j.some((c) => c.includes(`git -C ${WT} merge --ff-only origin/main`))).toBe(true);
    expect(j.some((c) => c.includes("merge --no-ff"))).toBe(false);
    // Even a failed locked land tears the worktree down.
    expect(h.removedWorktrees).toEqual([WT]);
  });

  it("unlocked land succeeds on a diverged primary (no gating pre-merge ff-only)", async () => {
    // The admin-PR merge is remote, so a diverged primary cannot fail the land
    // (#572). integrateCode:1 fails every `merge --ff-only` — including landPr's
    // best-effort POST-merge local fast-forward — yet the landing still succeeds:
    // there is no longer a pre-merge integrate gating the unlocked path.
    const h = harness({ locked: false, integrateCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    // It still admin-merged the PR.
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
    // The primary checkout was never touched by a destructive op (no reset/abort).
    expect(h.mergeCalls.every((c) => !c.includes("reset"))).toBe(true);
  });

  it("land failure (locked, no resolver) → { ok:false, land-failed, locked:true }", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    // post_merge never fires on a failed land.
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });

  it("locked zero-commit branch → land-failed without merging (mirrors unlocked empty-branch)", async () => {
    // A branch with no commits relative to base would produce an empty no-op merge
    // on the locked path, wrongly closing the issue as done. Guard must catch this.
    const h = harness({ locked: true, commitCount: 0 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    // No merge --no-ff must have been attempted.
    expect(joined(h.mergeCalls).some((c) => c.includes("merge --no-ff"))).toBe(false);
    // post_merge must not fire.
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });
});

describe("doLanding — locked conflict self-resolve", () => {
  it("resolver clears the conflict → lands ok, pushes the locked branch from the worktree", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1, conflictResolve: "resolve" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    // the resolve path pushed the locked base from the worktree HEAD.
    expect(j).toContain(`git -C ${WT} push origin HEAD:refs/heads/main`);
    expect(j.some((c) => c.includes("merge --abort"))).toBe(false);
    // the resolver ran in the worktree, never the primary checkout.
    expect(h.resolverCwds).toEqual([WT]);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });

  it("resolver fails → aborts the merge in the worktree, { ok:false, land-failed }", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1, conflictResolve: "fail" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    const j = joined(h.mergeCalls);
    expect(j).toContain(`git -C ${WT} merge --abort`);
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });

  it("resolved but the locked push is rejected → resets the worktree to preMergeSha, land-failed", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1, conflictResolve: "resolve", resolvePushCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    const j = joined(h.mergeCalls);
    // The rollback rewinds the throwaway worktree, NOT the primary checkout (#572).
    expect(j).toContain(`git -C ${WT} reset --hard abc1234`);
    expect(j.some((c) => c.includes("git -C /repo reset --hard"))).toBe(false);
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

describe("doLanding — the primary checkout is sacred (#572)", () => {
  // Acceptance: a push-reject rollback never `git reset --hard`s the primary
  // working tree, and primary WIP survives a failed land. The locked merge/push/
  // rollback all run in the isolated worktree (`/wt`); the ONLY `git -C /repo`
  // touch is the non-destructive attempt-branch push (via remoteGit).
  function assertPrimaryUntouched(h: Harness): void {
    const primaryOps = h.mergeCalls.filter((c) => c.includes("-C") && c.includes("/repo"));
    // No destructive op ever targets the primary checkout.
    for (const op of primaryOps) {
      expect(op.includes("reset")).toBe(false);
      expect(op.includes("merge")).toBe(false);
      expect(op.includes("rebase")).toBe(false);
    }
  }

  it("locked push reject: reset --hard lands on the worktree, primary WIP is preserved", async () => {
    // mergeNoFfCode unset → the `merge --no-ff` succeeds; the locked branch push
    // is rejected, triggering landMerge's own reset. It must hit the worktree.
    const h = harness({ locked: true });
    h.deps.mergeExec = (() => {
      const inner = h.deps.mergeExec;
      return async (argv: string[]) => {
        const j = argv.join(" ");
        // Reject the locked-branch push so landMerge rolls back.
        if (j === `git -C ${WT} push origin HEAD:refs/heads/main`) {
          h.mergeCalls.push(argv);
          return { code: 1, stdout: "", stderr: "rejected" };
        }
        return inner(argv);
      };
    })();
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    const j = joined(h.mergeCalls);
    expect(j).toContain(`git -C ${WT} reset --hard abc1234`);
    assertPrimaryUntouched(h);
    // The throwaway worktree is always torn down.
    expect(h.removedWorktrees).toEqual([WT]);
  });

  it("locked happy land: merge + push run in the worktree, primary untouched, worktree torn down", async () => {
    const h = harness({ locked: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes(`git -C ${WT} merge --no-ff --no-verify afk/wAAAA/9-fix-the-thing`))).toBe(true);
    expect(j).toContain(`git -C ${WT} push origin HEAD:refs/heads/main`);
    assertPrimaryUntouched(h);
    expect(h.removedWorktrees).toEqual([WT]);
  });

  it("locked land is REFUSED when no isolated worktree can be provisioned", async () => {
    // Rather than fall back to mutating the primary, the locked land fails cleanly
    // (parks to ready-for-human) so the primary checkout is never at risk.
    const h = harness({ locked: true, noWorktree: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: true });
    // Nothing merged/reset anywhere — no worktree, no land.
    expect(h.mergeCalls.some((c) => c.includes("merge --no-ff"))).toBe(false);
    assertPrimaryUntouched(h);
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });
});

describe("doLanding — CI-aware merge (#812)", () => {
  it("unlocked + ciAwait, CLEAN → polls merge state then admin-merges", async () => {
    const h = harness({ locked: false, ciAware: "merge" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    const j = joined(h.mergeCalls);
    const viewIdx = j.findIndex((c) => c.includes("pr view"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --admin --merge"));
    expect(viewIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(viewIdx);
  });

  it("a FAILED required check → { ok:false, ci-failed } with the PR number, never admin-merges", async () => {
    const h = harness({ locked: false, ciAware: "ci-failed" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "ci-failed", locked: false, prNumber: 42 });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(false);
    // post_merge never fires on a failed land.
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });

  it("checks still pending past the timeout → { ok:false, ci-pending } (no re-run, PR preserved)", async () => {
    const h = harness({ locked: false, ciAware: "ci-pending" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "ci-pending", locked: false, prNumber: 42 });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("a real DIRTY conflict still maps to land-failed (→ merge-conflict), not ci", async () => {
    const h = harness({ locked: false, ciAware: "conflict" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: false });
  });
});

describe("doLanding — landing mode decoupled from the lock (lock × flag matrix, #842)", () => {
  // The flag (openPr = afk.worktree_launches_pull_request) chooses PR vs direct;
  // the lock only resolves `base`. Four cells: {no lock, lock=X} × {true, false}.
  // `prMerged` = the admin-PR path ran; `directMerged` = the worktree merge ran.
  const prMerged = (j: string[]) => j.some((c) => c.includes("pr merge 42 --admin --merge"));
  const directMerged = (j: string[]) => j.some((c) => c.includes("merge --no-ff --no-verify afk/wAAAA/9-fix-the-thing"));

  it("no lock + true (default) → admin-merged PR into main (today's unlocked)", async () => {
    const h = harness({ locked: false, openPr: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    const j = joined(h.mergeCalls);
    expect(prMerged(j)).toBe(true);
    expect(directMerged(j)).toBe(false);
    // PR base is the resolved base (main here) — the reused-PR lookup keys on it.
    expect(j.some((c) => c.includes("pr list") && c.includes("--base main"))).toBe(true);
  });

  it("no lock + false → DIRECT merge into main, no PR (offline, new)", async () => {
    const h = harness({ locked: false, openPr: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    // Direct path captures the merge sha from the worktree; locked echoes input.locked=false.
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(directMerged(j)).toBe(true);
    // No PR opened/merged at all.
    expect(prMerged(j)).toBe(false);
    expect(j.some((c) => c.includes("pr list") || c.includes("pr merge"))).toBe(false);
    // Merge ran in the isolated worktree, pushing main from its HEAD.
    expect(j).toContain(`git -C ${WT} push origin HEAD:refs/heads/main`);
  });

  it("lock=X + true (default) → admin-merged PR with base = the lock branch, not main (new)", async () => {
    const h = harness({ locked: true, openPr: true });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    // PR path → no captured sha; locked echoes input.locked=true.
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    expect(prMerged(j)).toBe(true);
    // The PR targeted the lock branch as its base (PR #42 reused via pr list).
    expect(j.some((c) => c.includes("pr list") && c.includes("--base feature-locked"))).toBe(true);
    // No local direct merge of the attempt branch.
    expect(directMerged(j)).toBe(false);
  });

  it("lock=X + false → DIRECT merge into the lock branch (today's locked path)", async () => {
    const h = harness({ locked: true, openPr: false });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(directMerged(j)).toBe(true);
    // Integrate + push targeted the lock branch, never main.
    expect(j.some((c) => c.includes("merge --ff-only origin/feature-locked"))).toBe(true);
    expect(j).toContain(`git -C ${WT} push origin HEAD:refs/heads/feature-locked`);
    expect(j.some((c) => c.includes("refs/heads/main"))).toBe(false);
    expect(prMerged(j)).toBe(false);
  });

  it("afk.merge.* still governs the PR merge: lock=X + true + wait_for_review polls before the admin-merge", async () => {
    // The flag only decides whether a PR opens; HOW it merges stays afk.merge.*.
    const h = harness({ locked: true, openPr: true, waitForReview: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    const checksIdx = j.findIndex((c) => c.includes("pr checks"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --admin --merge"));
    expect(checksIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(checksIdx);
  });
});
