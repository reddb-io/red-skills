import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRANCH_TIP, RWT, WT, doLanding, harness, joined, type Harness } from "./landing.test-support.js";

const DEV_SRC = join(import.meta.dirname, "..", "src");

describe("doLanding — happy paths", () => {
  it("unlocked → pushes, fires both hooks, lands via admin PR", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    // worker branch pushed before landing.
    expect(h.pushedAttempt.length).toBe(1);
    // both merge hooks fired, in order.
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr list"))).toBe(true);
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    // unlocked never merges the attempt branch locally.
    expect(j.some((c) => c.includes("merge --no-ff afk/"))).toBe(false);
    expect(h.landingPhases).toEqual(["gate", "push-pr", "cascade"]);
  });

  it("unlocked + wait_for_review → polls the review check before the admin-merge", async () => {
    const h = harness({ locked: false, waitForReview: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    const checksIdx = j.findIndex((c) => c.includes("pr checks"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --merge"));
    expect(checksIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(checksIdx);
  });

  it("unlocked + explicit PR-resolved abort → stops before admin-merge", async () => {
    const h = harness({ locked: false, onPrResolvedAbort: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "pr-resolved-abort", locked: false, prNumber: 42 });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("unlocked, default (no wait_for_review) → never polls review checks", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr checks"))).toBe(false);
  });

  it("default unlocked landing → merge runs without --admin (branch protection is honored, #1103)", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    const mergeCall = h.mergeCalls.find((c) => c.join(" ").includes("pr merge"));
    expect(mergeCall).toBeDefined();
    expect(mergeCall!.join(" ")).not.toContain("--admin");
  });

  it("locked → lands via merge --no-ff into the locked branch + push", async () => {
    const h = harness({ locked: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes(`merge --no-ff --no-verify ${DEFAULT_BRANCH_TIP}`))).toBe(true);
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
    expect(j.some((c) => c.includes(`merge --no-ff --no-verify ${DEFAULT_BRANCH_TIP}`))).toBe(true);
    // Push targeted the lock branch (worktree HEAD → refs/heads/<base>), not main.
    expect(j.some((c) => c.includes("push origin HEAD:refs/heads/feature-locked"))).toBe(true);
    // The ADR 0083 precondition READS refs/heads/main (the trunk, read-only); the
    // landing's WRITE ops (merge/push) must never target main.
    expect(j.some((c) => (c.includes("merge --") || c.includes("push ")) && c.includes("main"))).toBe(false);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });
});

describe("doLanding — conventional landing titles (#1267)", () => {
  it.each([
    { labels: ["type:bug"], title: "fix: #9 Fix the thing" },
    { labels: ["bug"], title: "fix: #9 Fix the thing" },
    { labels: ["type:feature"], title: "feat: #9 Fix the thing" },
    { labels: ["enhancement"], title: "feat: #9 Fix the thing" },
    { labels: ["type:task"], title: "chore: #9 Fix the thing" },
    { labels: ["lane:go"], changedFiles: ["apps/dev/src/core/go.ts"], title: "fix: #9 Fix the thing" },
    { labels: ["lane:go"], changedFiles: ["docs/OPERATIONS.md"], title: "docs: #9 Fix the thing" },
    { labels: ["lane:go"], changedFiles: ["scripts/test-version-sync-contract.sh"], title: "chore: #9 Fix the thing" },
  ])("direct/no-agent landing maps $labels to $title", async ({ labels, changedFiles, title }) => {
    const h = harness({ locked: true, labels, changedFiles });
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r.ok).toBe(true);
    expect(joined(h.mergeCalls)).toContain(
      `git -C ${WT} merge --no-ff --no-verify ${DEFAULT_BRANCH_TIP} -m ${title}`,
    );
  });

  it("admin PR landing uses the conventional title for the PR and merge commit subject", async () => {
    const h = harness({ locked: false, createPr: true, labels: ["type:feature"] });
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j).toContain(
      "gh -R o/r pr create --base main --head afk/wAAAA/9-fix-the-thing --title feat: #9 Fix the thing --body Automated AFK landing for #9. Per-attempt history lives in the issue Envelopes, the local ledgers, and pushed worker-branch commits.\n\nCloses #9",
    );
    expect(j).toContain("gh -R o/r pr merge 42 --merge --subject feat: #9 Fix the thing");
  });
});

describe("doLanding — fleet mirror decouples landing from the primary checkout", () => {
  it("diverged local trunk no longer gates PR landing or reads primary local trunk refs", async () => {
    const h = harness({ locked: false, trunk: "diverged" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    expect(h.pushedAttempt.length).toBe(1);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(j.some((c) => c.includes("refs/heads/main"))).toBe(false);
    expect(j.some((c) => c.includes("symbolic-ref") || c.includes("status --porcelain"))).toBe(false);
    expect(j).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
  });

  it("diverged local trunk no longer gates direct landing; promotion is mirror-only", async () => {
    const h = harness({ locked: true, trunk: "diverged" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j).toContain(`git -C ${WT} push origin HEAD:refs/heads/main`);
    expect(j.some((c) => c.includes("refs/heads/main") && c.includes("-C /repo"))).toBe(false);
    expect(j.some((c) => c.includes("symbolic-ref") || c.includes("status --porcelain"))).toBe(false);
    expect(j).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
  });

  it("mirror promotion never resets, stashes, auto-commits, or checks out the primary", async () => {
    const h = harness({ locked: false, trunk: "diverged" });
    await doLanding(h.deps, h.input, h.hooks);
    for (const c of h.mergeCalls) {
      const j = c.join(" ");
      expect(j.includes("reset")).toBe(false);
      expect(j.includes("stash")).toBe(false);
      expect(j.includes("commit")).toBe(false);
      expect(j.includes("checkout")).toBe(false);
      expect(j.includes("switch")).toBe(false);
    }
    const primaryOps = joined(h.mergeCalls).filter((c) => c.includes("-C /repo"));
    expect(primaryOps.every((op) => /fetch|rev-parse|update-ref/.test(op))).toBe(true);
  });

  it("absent local trunk → still lands and promotes the mirror", async () => {
    const h = harness({ locked: false, trunk: "absent" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(joined(h.mergeCalls)).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
  });

  it("ancestor local trunk (default) → lands without primary fast-forward", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(j.some((c) => c.includes("git -C /repo merge --ff-only"))).toBe(false);
    expect(j).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
  });
});

describe("doLanding — formerly-sensitive paths land normally (#2417)", () => {
  it("a diff touching .github/workflows/ proceeds to a normal landing without blocking", async () => {
    const h = harness({ locked: false, changedFiles: [".github/workflows/ci.yml", "src/index.ts"] });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    expect(h.pushedAttempt).toHaveLength(1);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });
});

describe("doLanding — abort / failure short-circuits", () => {
  it("push failure → { ok:false, infra } before any hook fires (no silent zero-diff)", async () => {
    const h = harness({ locked: false });
    // Simulate the continuous-push hook having failed: the initial push also
    // fails, and the ref reads confirm nothing reached origin. The refusal is
    // `infra`, never `land-failed` — the latter funnels into the merge-conflict
    // terminal, which is how a push failure came to be labelled a conflict
    // under a summary denying it was one (#2811).
    h.deps.remoteGit = async () => ({ code: 1, stdout: "", stderr: "fatal: authentication failed" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toMatchObject({ ok: false, reason: "infra", locked: false });
    expect((r as { infraReason?: string }).infraReason).toContain("push failed");
    expect((r as { infraReason?: string }).infraReason).not.toMatch(/merge conflict/i);
    // No hooks should fire — the push is the first mandatory step.
    expect(h.firedHooks).toEqual([]);
  });

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
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    // It still admin-merged the PR.
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    // The primary checkout was never touched by a destructive op (no reset/abort).
    expect(h.mergeCalls.every((c) => !c.includes("reset"))).toBe(true);
  });

  it("land failure (locked, no resolver) → { ok:false, land-failed, locked:true }", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toMatchObject({ ok: false, reason: "land-failed", locked: true });
    // post_merge never fires on a failed land.
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });

  it("locked zero-commit branch → land-failed without merging (mirrors unlocked empty-branch)", async () => {
    // A branch with no commits relative to base would produce an empty no-op merge
    // on the locked path, wrongly closing the issue as done. Guard must catch this.
    const h = harness({ locked: true, commitCount: 0 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toMatchObject({ ok: false, reason: "land-failed", locked: true });
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
    expect(r).toMatchObject({ ok: false, reason: "land-failed", locked: true });
    const j = joined(h.mergeCalls);
    expect(j).toContain(`git -C ${WT} merge --abort`);
    expect(h.firedHooks).toEqual(["pre_merge"]);
  });

  it("resolved but the locked push is rejected → resets the worktree to preMergeSha, land-failed", async () => {
    const h = harness({ locked: true, mergeNoFfCode: 1, conflictResolve: "resolve", resolvePushCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toMatchObject({ ok: false, reason: "land-failed", locked: true });
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
    expect(r).toMatchObject({ ok: false, reason: "land-failed", locked: false });
    expect((r as { message?: string }).message).toContain("merge step");
  });
});

describe("doLanding — the primary checkout is sacred (#572)", () => {
  // Acceptance: a push-reject rollback never `git reset --hard`s the primary
  // working tree, and primary WIP survives a failed land. The locked merge/push/
  // rollback all run in the isolated worktree (`/wt`). The one allowed `git -C
  // /repo` write is the guarded post-merge ff-only promotion (ADR 0083 §2
  // amended); a DESTRUCTIVE op (reset, rebase, or a `--no-ff` merge commit) must
  // never target the primary checkout.
  function assertPrimaryUntouched(h: Harness): void {
    const primaryOps = h.mergeCalls.filter((c) => c.includes("-C") && c.includes("/repo"));
    for (const op of primaryOps) {
      expect(op.includes("reset")).toBe(false);
      expect(op.includes("rebase")).toBe(false);
      // `merge` element (not `merge-base`) is allowed only as a pure ff.
      if (op.includes("merge")) {
        expect(op.includes("--ff-only")).toBe(true);
      }
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
    expect(r).toMatchObject({ ok: false, reason: "land-failed", locked: true });
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
    expect(j.some((c) => c.includes(`git -C ${WT} merge --no-ff --no-verify ${DEFAULT_BRANCH_TIP}`))).toBe(true);
    expect(j).toContain(`git -C ${WT} push origin HEAD:refs/heads/main`);
    assertPrimaryUntouched(h);
    expect(h.removedWorktrees).toEqual([WT]);
  });

  it("locked land is REFUSED when no isolated worktree can be provisioned", async () => {
    // Rather than fall back to mutating the primary, the locked land fails cleanly
    // (parks to ready-for-human) so the primary checkout is never at risk.
    const h = harness({ locked: true, noWorktree: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toMatchObject({ ok: false, reason: "land-failed", locked: true });
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
    expect(r).toEqual({
      ok: true,
      locked: false,
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "satisfied-by-ci",
        reason: "PR #42 had fresh green CI evidence from 1 required check(s); local post-merge validation skipped.",
        prNumber: 42,
        checkCount: 1,
      },
    });
    const j = joined(h.mergeCalls);
    const viewIdx = j.findIndex((c) => c.includes("pr view"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --merge"));
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

  it("a wedged merge poll emits landing heartbeats for every bounded poll before parking", async () => {
    const h = harness({ locked: false, ciAware: "ci-pending" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "ci-pending", locked: false, prNumber: 42 });
    expect(h.landingEvents.filter((event) => event.detail.step === "merge-poll")).toEqual([
      expect.objectContaining({
        phase: "wait",
        detail: expect.objectContaining({ status: "poll", pr_number: 42, attempt: 1, max_polls: 2 }),
      }),
      expect.objectContaining({
        phase: "wait",
        detail: expect.objectContaining({ status: "poll", pr_number: 42, attempt: 2, max_polls: 2 }),
      }),
    ]);
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("a real DIRTY conflict preserves the PR number for the caller's merge-conflict handoff", async () => {
    const h = harness({ locked: false, ciAware: "conflict" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "pr-conflict", locked: false, prNumber: 42 });
  });

  it("a rejected admin merge after PR creation preserves the PR instead of collapsing to generic land-failed", async () => {
    const h = harness({ locked: false, prMergeCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    // #2807: the refusal carries the OBSERVED PR state, never a guessed cause.
    expect(r).toEqual({
      ok: false,
      reason: "pr-merge-failed",
      locked: false,
      prNumber: 42,
      message: "the forge rejected the merge and the PR state does not explain it (mergeStateStatus=CLEAN mergeable=MERGEABLE)",
    });
    expect((r as { message?: string }).message).not.toMatch(/usually|probably/i);
  });
});

describe("doLanding — PR-path pre-merge rebase (#1006)", () => {
  it("branch diverged by one unrelated commit is rebased in the worktree, force-pushed, then merged cleanly", async () => {
    const h = harness({ locked: false, rebaseWorktree: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    // The rebase ran in the isolated worker-branch worktree, before the merge.
    const fetchIdx = j.findIndex((c) => c === `git -C ${RWT} fetch origin main --quiet`);
    const rebaseIdx = j.findIndex((c) => c === `git -C ${RWT} rebase origin/main`);
    const pushIdx = j.findIndex(
      (c) => c === `git -C ${RWT} push origin HEAD:refs/heads/afk/wAAAA/9-fix-the-thing --force-with-lease`,
    );
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --merge"));
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(rebaseIdx).toBeGreaterThan(fetchIdx);
    expect(pushIdx).toBeGreaterThan(rebaseIdx);
    expect(mergeIdx).toBeGreaterThan(pushIdx);
    // Clean rebase → no abort; the primary checkout is never rebased/reset.
    expect(j.some((c) => c.includes("rebase --abort"))).toBe(false);
    expect(j.some((c) => c.includes(`git -C /repo rebase`) || c.includes(`git -C /repo reset`))).toBe(false);
    // The throwaway rebase worktree is torn down.
    expect(h.removedRebaseWorktrees).toEqual([RWT]);
  });

  it("a real rebase conflict aborts and parks blocked:merge-conflict (never admin-merges)", async () => {
    const h = harness({ locked: false, rebaseWorktree: true, rebaseCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    // pr-conflict routes to blocked:merge-conflict at the caller (existing behaviour).
    expect(r).toEqual({ ok: false, reason: "pr-conflict", locked: false });
    const j = joined(h.mergeCalls);
    expect(j).toContain(`git -C ${RWT} rebase --abort`);
    // Never force-pushed, never admin-merged, post_merge never fired.
    expect(j.some((c) => c.includes("--force-with-lease"))).toBe(false);
    expect(j.some((c) => c.includes("pr merge"))).toBe(false);
    expect(h.firedHooks).toEqual(["pre_merge"]);
    // The primary checkout is never touched destructively.
    expect(j.some((c) => c.includes("git -C /repo reset") || c.includes("git -C /repo rebase"))).toBe(false);
    // Worktree still torn down on the failure path.
    expect(h.removedRebaseWorktrees).toEqual([RWT]);
  });

  it("#2481: a far-ahead, base-stale branch parks with the guard's reason and never rebases", async () => {
    const h = harness({ locked: false, rebaseWorktree: true, staleBranch: { ahead: 65, ageHours: 15 } });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "pr-conflict", locked: false });
    expect((r as { message?: string }).message).toContain("65 commits ahead");
    const j = joined(h.mergeCalls);
    // The doomed sequential rebase never starts, and nothing is merged.
    expect(j.some((c) => c === `git -C ${RWT} rebase origin/main`)).toBe(false);
    expect(j.some((c) => c.includes("pr merge"))).toBe(false);
    expect(h.removedRebaseWorktrees).toEqual([RWT]);
  });

  it("#2481: a far-ahead branch on a FRESH base still lands normally", async () => {
    const h = harness({ locked: false, rebaseWorktree: true, staleBranch: { ahead: 65, ageHours: 1 } });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r.ok).toBe(true);
    expect(joined(h.mergeCalls)).toContain(`git -C ${RWT} rebase origin/main`);
  });

  it("force-with-lease rejected on every attempt → parks blocked:merge-conflict after the bounded retry", async () => {
    const h = harness({ locked: false, rebaseWorktree: true, rebasePushCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "pr-conflict", locked: false });
    const j = joined(h.mergeCalls);
    // Three force-with-lease pushes (1 + 2 retries) then gives up — never merges.
    const pushes = j.filter((c) => c.includes("--force-with-lease")).length;
    expect(pushes).toBe(3);
    expect(j.some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("no provisioner → aborts as infra and never admin-merges", async () => {
    const h = harness({ locked: false, rebaseWorktree: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: false,
      reason: "infra",
      infraReason: "pre-merge rebase worktree could not be provisioned",
      locked: false,
    });
    expect(joined(h.mergeCalls).some((c) => c.includes("--force-with-lease"))).toBe(false);
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge"))).toBe(false);
  });

  it("worktree could not be provisioned → aborts as infra and never admin-merges", async () => {
    const h = harness({ locked: false, noRebaseWorktree: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: false,
      reason: "infra",
      infraReason: "pre-merge rebase worktree could not be provisioned",
      locked: false,
    });
    expect(joined(h.mergeCalls).some((c) => c.includes("--force-with-lease"))).toBe(false);
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge"))).toBe(false);
  });

  it("the DIRECT (non-PR) path ignores the rebase provisioner (it integrates origin itself)", async () => {
    const h = harness({ locked: false, openPr: false, rebaseWorktree: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    // No pre-merge rebase force-push on the direct path.
    expect(joined(h.mergeCalls).some((c) => c.includes(`git -C ${RWT}`))).toBe(false);
  });
});

describe("doLanding — landing mode decoupled from the lock (lock × flag matrix, #842)", () => {
  // The flag (openPr = afk.worktree_launches_pull_request) chooses PR vs direct;
  // the lock only resolves `base`. Four cells: {no lock, lock=X} × {true, false}.
  // `prMerged` = the admin-PR path ran; `directMerged` = the worktree merge ran.
  const prMerged = (j: string[]) => j.some((c) => c.includes("pr merge 42 --merge"));
  const directMerged = (j: string[]) => j.some((c) => c.includes("merge --no-ff --no-verify"));

  it("returns the forge merge SHA from a completed PR landing", async () => {
    const h = harness({ locked: false, openPr: true });
    const mergeExec = h.deps.mergeExec;
    h.deps.mergeExec = async (argv) => {
      if (argv.join(" ").includes("pr view 42 --json mergeCommit --jq .mergeCommit.oid")) {
        return { code: 0, stdout: "forge-merge-sha\n", stderr: "" };
      }
      return await mergeExec(argv);
    };

    expect(await doLanding(h.deps, h.input, h.hooks)).toEqual({
      ok: true,
      locked: false,
      mergeSha: "forge-merge-sha",
    });
  });

  it("no lock + true (default) → admin-merged PR into main (today's unlocked)", async () => {
    const h = harness({ locked: false, openPr: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
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

  it("no lock + false + stale local main → lands from the worktree and promotes red-trunk after the push", async () => {
    const branchTip = "1234567890abcdef";
    const h = harness({ locked: false, openPr: false, branchTip });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });

    const j = joined(h.mergeCalls);
    const integrateIdx = j.findIndex((c) => c === `git -C ${WT} merge --ff-only origin/main`);
    const resolveTipIdx = j.findIndex(
      (c) => c === `git -C ${WT} rev-parse --verify --quiet origin/afk/wAAAA/9-fix-the-thing`,
    );
    const ancestorIdx = j.findIndex((c) => c === `git -C ${WT} merge-base --is-ancestor origin/main ${branchTip}`);
    const fastForwardIdx = j.findIndex((c) => c === `git -C ${WT} merge --ff-only ${branchTip}`);
    const pushIdx = j.findIndex((c) => c === `git -C ${WT} push origin HEAD:refs/heads/main`);
    const promoteIdx = j.findIndex((c) => c === "git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");

    expect(integrateIdx).toBeGreaterThanOrEqual(0);
    expect(resolveTipIdx).toBeGreaterThan(integrateIdx);
    expect(ancestorIdx).toBeGreaterThan(resolveTipIdx);
    expect(fastForwardIdx).toBeGreaterThan(ancestorIdx);
    expect(pushIdx).toBeGreaterThan(fastForwardIdx);
    expect(promoteIdx).toBeGreaterThan(pushIdx);
    expect(j.some((c) => c.includes("merge --no-ff"))).toBe(false);
  });

  it("lock=X + true (default) → admin-merged PR with base = the lock branch, not main (new)", async () => {
    const h = harness({ locked: true, openPr: true });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    // PR path → no captured sha; locked echoes input.locked=true.
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
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
    // The ADR 0083 precondition READS refs/heads/main (the trunk, read-only); the
    // landing's WRITE ops (merge/push) must never target main.
    expect(j.some((c) => (c.includes("merge --") || c.includes("push ")) && c.includes("main"))).toBe(false);
    expect(prMerged(j)).toBe(false);
  });

  it("afk.merge.* still governs the PR merge: lock=X + true + wait_for_review polls before the admin-merge", async () => {
    // The flag only decides whether a PR opens; HOW it merges stays afk.merge.*.
    const h = harness({ locked: true, openPr: true, waitForReview: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    const checksIdx = j.findIndex((c) => c.includes("pr checks"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --merge"));
    expect(checksIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(checksIdx);
  });
});

describe("doLanding — post-land promotion advances red-trunk, not the primary checkout", () => {
  const DESTRUCTIVE_VERBS = new Set(["reset", "rebase", "checkout", "switch", "commit", "cherry-pick"]);
  function destructivePrimaryWrites(h: Harness): string[] {
    return h.mergeCalls
      .filter((argv) => {
        const i = argv.indexOf("/repo");
        if (i < 1 || argv[i - 1] !== "-C") return false;
        return argv.includes("merge") || argv.some((tok) => DESTRUCTIVE_VERBS.has(tok));
      })
      .map((argv) => argv.join(" "));
  }

  it("locked + PR (default flag) → admin-merges remotely AND promotes red-trunk", async () => {
    const h = harness({ locked: true, openPr: true });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(j).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
    expect(j.some((c) => c.includes("symbolic-ref") || c.includes("status --porcelain"))).toBe(false);
    expect(destructivePrimaryWrites(h)).toEqual([]);
  });

  it("locked + PR on a DIRTY primary → still promotes red-trunk without reading primary WIP", async () => {
    const h = harness({ locked: true, openPr: true, dirtyPrimary: true });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(j).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
    expect(j.some((c) => c.includes("status --porcelain"))).toBe(false);
    expect(destructivePrimaryWrites(h)).toEqual([]);
  });

  it("locked + direct → merges/pushes in the worktree, then promotes red-trunk", async () => {
    const h = harness({ locked: true, openPr: false });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    expect(joined(h.mergeCalls)).toContain(`git -C ${WT} push origin HEAD:refs/heads/feature-locked`);
    expect(joined(h.mergeCalls)).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
    expect(destructivePrimaryWrites(h)).toEqual([]);
  });

  it("locked + direct conflict self-resolve stays in the worktree, primary destructive-write-free", async () => {
    const h = harness({ locked: true, openPr: false, mergeNoFfCode: 1, conflictResolve: "resolve" });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    // The resolver ran in the worktree, and the resolved lock branch pushed from it.
    expect(h.resolverCwds).toEqual([WT]);
    expect(joined(h.mergeCalls)).toContain(`git -C ${WT} push origin HEAD:refs/heads/feature-locked`);
    expect(destructivePrimaryWrites(h)).toEqual([]);
  });

  it("UNLOCKED PR landing also promotes red-trunk instead of local main", async () => {
    const h = harness({ locked: false, openPr: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    expect(joined(h.mergeCalls)).toContain("git -C /repo update-ref refs/heads/red-trunk 0r1g1nsha");
    expect(joined(h.mergeCalls).some((c) => c.includes("git -C /repo merge --ff-only origin/main"))).toBe(false);
  });
});

// --- post-merge-integration gate (#1335) ---
// Validate the merged tree (origin/<base> integrated into the worker branch)
// BEFORE pushing to the remote, so a stale-main-broken result is never merged.
describe("doLanding — post-merge-integration gate (#1335)", () => {
  it("direct path: gate absent → fails infra because no local validation fallback is available", async () => {
    const h = harness({ locked: true, openPr: false, requirePostMergeValidation: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: false,
      reason: "infra",
      locked: true,
      infraReason: "Post-merge validation fallback is not configured for a direct landing that bypassed PR CI.",
    });
    expect(h.postMergeGateDirs).toEqual([]);
  });

  it("PR path: gate absent + usable CI evidence → records satisfied-by-CI", async () => {
    const h = harness({ locked: false, openPr: true, ciAware: "merge" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: true,
      locked: false,
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "satisfied-by-ci",
        reason: "PR #42 had fresh green CI evidence from 1 required check(s); local post-merge validation skipped.",
        prNumber: 42,
        checkCount: 1,
      },
    });
    expect(h.postMergeGateDirs).toEqual([]);
  });

  it("PR path: gate absent + unusable CI evidence → fails infra", async () => {
    const h = harness({ locked: false, openPr: true, ciAware: "skipped" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: false,
      reason: "infra",
      locked: false,
      prNumber: 42,
      infraReason: "Post-merge validation fallback is not configured and PR CI evidence was absent or unusable.",
    });
    expect(h.postMergeGateDirs).toEqual([]);
  });

  it("direct path: gate wired + passes → lands successfully, gate called with the landing worktree", async () => {
    const h = harness({ locked: true, openPr: false, postMergeGate: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: true,
      locked: true,
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "local-rerun",
        reason: "Direct landing bypassed PR CI; local post-merge validation fallback ran.",
      },
    });
    // Gate was called exactly once with the landing worktree (WT), not the primary.
    expect(h.postMergeGateDirs).toEqual([WT]);
    // The merge still happened (gate passed, not a no-merge).
    expect(joined(h.mergeCalls).some((c) => c.includes("merge"))).toBe(true);
    expect(h.landingPhases).toEqual(["gate", "gate", "merge", "cascade"]);
  });

  it("PR path: usable CI evidence → records satisfied-by-CI and skips the local gate", async () => {
    const h = harness({ locked: false, openPr: true, postMergeGate: true, ciAware: "merge" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: true,
      locked: false,
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "satisfied-by-ci",
        reason: "PR #42 had fresh green CI evidence from 1 required check(s); local post-merge validation skipped.",
        prNumber: 42,
        checkCount: 1,
      },
    });
    expect(h.postMergeGateDirs).toEqual([]);
    // The admin-merge still happened.
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(true);
    expect(h.landingPhases).toEqual(["gate", "push-pr", "wait", "cascade"]);
  });

  it("PR path: skipped CI evidence → falls back to the local rebase-worktree gate", async () => {
    const h = harness({ locked: false, openPr: true, postMergeGate: true, ciAware: "skipped" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: true,
      locked: false,
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "local-rerun",
        reason: "PR #42 CI evidence was absent or unusable; local post-merge validation fallback ran.",
        prNumber: 42,
      },
    });
    expect(h.postMergeGateDirs).toEqual([RWT]);
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(true);
  });

  it("direct path: gate wired + fails → returns post-merge-gate, nothing pushed to remote", async () => {
    const h = harness({ locked: true, openPr: false, postMergeGate: true, postMergeGateFails: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "post-merge-gate", locked: true });
    // Gate was called with the landing worktree.
    expect(h.postMergeGateDirs).toEqual([WT]);
    // Nothing was pushed to the remote base (origin/<base>).
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes(`push origin HEAD:refs/heads/`))).toBe(false);
    // No --no-ff landing merge was created (integrateOrigin's ff-only is allowed).
    expect(j.some((c) => c.includes("merge --no-ff"))).toBe(false);
  });

  it("PR path: gate wired + fails → returns post-merge-gate, no admin-merge attempted", async () => {
    const h = harness({ locked: false, openPr: true, postMergeGate: true, postMergeGateFails: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "post-merge-gate", locked: false, prNumber: 42 });
    // Gate was called with the rebase worktree.
    expect(h.postMergeGateDirs).toEqual([RWT]);
    // No admin-merge was attempted.
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("direct path: gate failure aborts before the merge but worktree is still torn down", async () => {
    const h = harness({ locked: true, openPr: false, postMergeGate: true, postMergeGateFails: true });
    await doLanding(h.deps, h.input, h.hooks);
    // The landing worktree is always cleaned up even on gate failure.
    expect(h.removedWorktrees).toEqual([WT]);
  });

  it("PR path: gate failure aborts before admin-merge but rebase worktree is still torn down", async () => {
    const h = harness({ locked: false, openPr: true, postMergeGate: true, postMergeGateFails: true });
    await doLanding(h.deps, h.input, h.hooks);
    // The rebase worktree is always cleaned up even on gate failure.
    expect(h.removedRebaseWorktrees).toEqual([RWT]);
  });

  it("direct path: integrate-failed → gate is never called (gate only runs on success)", async () => {
    const h = harness({ locked: true, openPr: false, postMergeGate: true, integrateCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "integrate-failed", locked: true });
    expect(h.postMergeGateDirs).toEqual([]);
  });

  it("PR rebase conflict → gate is never called (gate only runs on successful rebase)", async () => {
    const h = harness({ locked: false, openPr: true, postMergeGate: true, rebaseCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "pr-conflict", locked: false });
    expect(h.postMergeGateDirs).toEqual([]);
  });
});

describe("landing outcomes — every non-ok reason is a landing failure (ADR 0129)", () => {
  // The `adversarial-correction` reason was the ONE non-ok landing outcome that
  // was not a landing failure: review ran after the merge decision and aborted
  // it to send the work back to the implementer. Review is the gate fold's third
  // stage now (#2730), so the reason has no producer left — and a string scan is
  // the only check that also catches a re-introduction in a comment, a log line,
  // or a test fixture that would quietly resurrect the vocabulary.
  it("no shipped dev source mentions the adversarial-correction landing reason", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (readFileSync(full, "utf8").includes("adversarial-correction")) {
          offenders.push(relative(DEV_SRC, full));
        }
      }
    };
    walk(DEV_SRC);

    expect(offenders, `retired landing reason \`adversarial-correction\` found in: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });
});
