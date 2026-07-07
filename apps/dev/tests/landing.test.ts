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

// The isolated worker-branch worktree the PR path's pre-merge rebase runs in
// (#1006). Distinct from WT so a test can assert the fetch/rebase/force-push
// never `git -C`'d the primary checkout (`/repo`).
const RWT = "/rwt";
const DEFAULT_BRANCH_TIP = "feedfacecafebeef";

interface Harness {
  deps: LandingDeps;
  input: LandingInput;
  hooks: LandingHookContexts;
  mergeCalls: string[][];
  pushedAttempt: string[][];
  firedHooks: string[];
  removedWorktrees: string[];
  removedRebaseWorktrees: string[];
  mainRedRepairLookups: number;
  /** cwds the conflict resolver was dispatched in. */
  resolverCwds: string[];
}

interface Opts {
  locked?: boolean;
  /**
   * Make the primary checkout's working tree DIRTY (`git status --porcelain`
   * returns a modified path). Drives the fastForwardLocalTarget WIP guard: a
   * dirty primary must skip the post-merge promotion (ADR 0083 §2's #1019
   * safety intent), even though §2's literal no-write rule is relaxed.
   */
  dirtyPrimary?: boolean;
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
  /** rc the final `gh pr merge` returns (1 → PR exists but merge is rejected). */
  prMergeCode?: number;
  /** Make the landing-worktree provisioner fail (returns null). */
  noWorktree?: boolean;
  /** Commits ahead of base returned by `git rev-list --count`. Default 3. */
  commitCount?: number;
  /** Resolved origin/<branch> tip used by stale-local-ref regressions. */
  branchTip?: string;
  /** Enable the PR-path pre-merge rebase provisioner (#1006). Defaults true for PR landings (#1212). */
  rebaseWorktree?: boolean;
  /** The rebase provisioner returns null (could not provision → rebase skipped). */
  noRebaseWorktree?: boolean;
  /** rc the rebase in the rebase worktree returns (1 → real conflict → abort). */
  rebaseCode?: number;
  /** rc the force-with-lease push returns (1 → reject on every attempt). */
  rebasePushCode?: number;
  /**
   * ADR 0083 landing precondition (#1018): drive the local-trunk-vs-origin check.
   *   - "diverged" → `merge-base --is-ancestor` exits 1 (local trunk carries
   *     commits origin does not) → the landing aborts with `trunk-diverged`.
   *   - "absent"   → `rev-parse --verify refs/heads/<trunk>` exits 1 (the primary
   *     never checked the trunk out) → the precondition proceeds.
   * Unset → the local trunk reads as an ancestor of origin → proceeds.
   */
  trunk?: "diverged" | "absent";
  /**
   * Sensitive-path guard (issue #1102): inject getDiffPaths.
   *   - undefined → guard not wired (safe default, no-op, existing tests unaffected)
   *   - "hit"  → getDiffPaths returns a diff that touches .github/workflows/ci.yml
   *   - "clean"→ getDiffPaths returns a diff with no sensitive paths
   */
  sensitivePaths?: "hit" | "clean";
  /**
   * Sensitive-path guard bypass (#1171). When true, `input.sensitivePathApproved`
   * is set so the step-0a guard is skipped even on a "hit" diff. Models the
   * `/requeue --adopt-branch` human land of a reviewed protected diff.
   */
  sensitivePathApproved?: boolean;
  /** Main-red tracking gate (#1237): set input.mainRed. */
  mainRed?: boolean;
  /** Main-red tracking gate (#1237): whether the open repair issue finder returns an issue. */
  mainRedRepairIssue?: boolean;
  /** Issue labels used to derive the landing-created conventional merge title. */
  labels?: string[];
  /** Force the admin PR path to create a PR instead of reusing an open one. */
  createPr?: boolean;
}

function harness(opts: Opts = {}): Harness {
  const mergeCalls: string[][] = [];
  const pushedAttempt: string[][] = [];
  const firedHooks: string[] = [];
  const removedWorktrees: string[] = [];
  const removedRebaseWorktrees: string[] = [];
  let mainRedRepairLookups = 0;
  const resolverCwds: string[] = [];
  let mergeResolved = false;
  let prCreated = false;

  const deps: LandingDeps = {
    mergeExec: async (argv): Promise<ExecResult> => {
      mergeCalls.push(argv);
      const j = argv.join(" ");
      // fastForwardLocalTarget probes (ADR 0083 §2 amended): the primary sits on
      // <base>, and its tree is clean unless the test opts into dirtyPrimary.
      if (j.includes("symbolic-ref --short HEAD")) {
        return { code: 0, stdout: `${input.base}\n`, stderr: "" };
      }
      if (j.includes("status --porcelain")) {
        return { code: 0, stdout: opts.dirtyPrimary ? " M apps/dev/src/x.ts\n" : "", stderr: "" };
      }
      if (j.includes("merge-base --is-ancestor origin/")) {
        return { code: opts.branchTip ? 0 : 1, stdout: "", stderr: "" };
      }
      // ADR 0083 landing precondition (#1018), against the primary checkout.
      // `merge-base --is-ancestor local origin/<trunk>` — exit 1 = diverged.
      if (j.includes("merge-base --is-ancestor")) {
        return { code: opts.trunk === "diverged" ? 1 : 0, stdout: "", stderr: "" };
      }
      // The primary's LOCAL trunk ref probe — exit 1 = absent (proceed).
      if (j.includes("rev-parse --verify --quiet --short refs/heads/")) {
        return opts.trunk === "absent"
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: "1oca1sha\n", stderr: "" };
      }
      // origin/<trunk> SHA, captured for the divergence envelope.
      if (j.includes("rev-parse --short origin/")) {
        return { code: 0, stdout: "0r1g1nsha\n", stderr: "" };
      }
      // #1006 pre-merge rebase, in the isolated worker-branch worktree (RWT).
      if (j === `git -C ${RWT} rebase origin/main`) {
        return { code: opts.rebaseCode ?? 0, stdout: "", stderr: "" };
      }
      if (j.startsWith(`git -C ${RWT} push origin HEAD:refs/heads/`) && j.includes("--force-with-lease")) {
        return { code: opts.rebasePushCode ?? 0, stdout: "", stderr: "" };
      }
      if (argv.includes("pr") && argv.includes("list")) {
        if (opts.createPr && !prCreated) return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      if (argv.includes("pr") && argv.includes("create")) {
        prCreated = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      // The rollback anchor + landed sha the locked worktree path reads.
      if (j.includes("rev-parse --short HEAD")) {
        return { code: 0, stdout: "abc1234\n", stderr: "" };
      }
      if (j.includes("rev-list") && j.includes("--count")) {
        return { code: 0, stdout: `${opts.commitCount ?? 3}\n`, stderr: "" };
      }
      if (j.includes("rev-parse --verify --quiet origin/afk/wAAAA/9-fix-the-thing")) {
        return { code: 0, stdout: `${opts.branchTip ?? DEFAULT_BRANCH_TIP}\n`, stderr: "" };
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
      if (j.includes("pr merge")) {
        return { code: opts.prMergeCode ?? 0, stdout: "", stderr: opts.prMergeCode ? "merge rejected" : "" };
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
    // #1212: PR-path fresh-base integration is mandatory, so the harness wires a
    // working rebase worktree by default. Tests that exercise infra provisioning
    // failures opt out explicitly.
    makeRebaseWorktree: opts.rebaseWorktree === false ? undefined : async () => (opts.noRebaseWorktree ? null : RWT),
    removeRebaseWorktree: opts.rebaseWorktree !== false
      ? async (dir) => {
          removedRebaseWorktrees.push(dir);
        }
      : undefined,
    // #1102: only wired when the test opts in (opt-in — absent → guard skipped).
    getDiffPaths: opts.sensitivePaths
      ? async () => ({
          changedFiles:
            opts.sensitivePaths === "hit"
              ? [".github/workflows/ci.yml", "src/index.ts"]
              : ["src/index.ts", "apps/dev/src/core/landing.ts"],
          packageJsonDiff: "",
        })
      : undefined,
    findMainRedRepairIssue:
      opts.mainRed === undefined
        ? undefined
        : async () => {
            mainRedRepairLookups += 1;
            return opts.mainRedRepairIssue ? { number: 123 } : null;
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
    // ADR 0083 landing precondition (#1018): the configured Trunk. The default
    // permissive mergeExec below returns code 0 for the precondition's
    // fetch/rev-parse/is-ancestor calls, so the local trunk reads as an ancestor
    // → the precondition proceeds and the existing path assertions are unchanged.
    trunk: "main",
    issue: 9,
    title: "Fix the thing",
    ...(opts.labels ? { labels: opts.labels } : {}),
    // #1171: only set when the test opts in; default undefined keeps the guard
    // armed for every existing landing assertion.
    sensitivePathApproved: opts.sensitivePathApproved,
    mainRed: opts.mainRed,
  };

  const hooks: LandingHookContexts = {
    preMerge: () => "pre_merge-ctx",
    postMerge: () => "post_merge-ctx",
  };

  return {
    deps,
    input,
    hooks,
    mergeCalls,
    pushedAttempt,
    firedHooks,
    removedWorktrees,
    removedRebaseWorktrees,
    get mainRedRepairLookups() {
      return mainRedRepairLookups;
    },
    resolverCwds,
  };
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
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    // unlocked never merges the attempt branch locally.
    expect(j.some((c) => c.includes("merge --no-ff afk/"))).toBe(false);
  });

  it("unlocked + wait_for_review → polls the review check before the admin-merge", async () => {
    const h = harness({ locked: false, waitForReview: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    const j = joined(h.mergeCalls);
    const checksIdx = j.findIndex((c) => c.includes("pr checks"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --merge"));
    expect(checksIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(checksIdx);
  });

  it("unlocked, default (no wait_for_review) → never polls review checks", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr checks"))).toBe(false);
  });

  it("unlocked + red main + open main-red repair issue → admin-merges", async () => {
    const h = harness({ locked: false, mainRed: true, mainRedRepairIssue: true });
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({ ok: true, locked: false });
    expect(h.mainRedRepairLookups).toBe(1);
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
  });

  it("unlocked + red main + no main-red repair issue → refuses before admin-merge", async () => {
    const h = harness({ locked: false, mainRed: true, mainRedRepairIssue: false });
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("main-red-untracked");
    expect(r.message).toContain("Refusing admin-merge onto red main");
    expect(h.mainRedRepairLookups).toBe(1);
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("default unlocked landing → merge runs without --admin (branch protection is honored, #1103)", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
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
  ])("direct/no-agent landing maps $labels to $title", async ({ labels, title }) => {
    const h = harness({ locked: true, labels });
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r.ok).toBe(true);
    expect(joined(h.mergeCalls)).toContain(
      `git -C ${WT} merge --no-ff --no-verify ${DEFAULT_BRANCH_TIP} -m ${title}`,
    );
  });

  it("admin PR landing uses the conventional title for the PR and merge commit subject", async () => {
    const h = harness({ locked: false, createPr: true, labels: ["type:feature"] });
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({ ok: true, locked: false });
    const j = joined(h.mergeCalls);
    expect(j).toContain(
      "gh -R o/r pr create --base main --head afk/wAAAA/9-fix-the-thing --title feat: #9 Fix the thing --body Automated AFK landing for #9. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.\n\nCloses #9",
    );
    expect(j).toContain("gh -R o/r pr merge 42 --merge --subject feat: #9 Fix the thing");
  });
});

describe("doLanding — ADR 0083 trunk landing precondition (#1018)", () => {
  it("diverged local trunk → aborts with trunk-diverged BEFORE any push/integrate/land, naming both SHAs", async () => {
    const h = harness({ locked: false, trunk: "diverged" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: false,
      reason: "trunk-diverged",
      locked: false,
      localTrunkSha: "1oca1sha",
      originTrunkSha: "0r1g1nsha",
    });
    // The abort is loud and EARLY: no attempt-branch push, no hooks, no landing.
    expect(h.pushedAttempt).toEqual([]);
    expect(h.firedHooks).toEqual([]);
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr merge"))).toBe(false);
    expect(j.some((c) => c.includes("merge --no-ff"))).toBe(false);
  });

  it("diverged local trunk on the DIRECT (locked) path also aborts before integrating", async () => {
    const h = harness({ locked: true, trunk: "diverged" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({
      ok: false,
      reason: "trunk-diverged",
      locked: true,
      localTrunkSha: "1oca1sha",
      originTrunkSha: "0r1g1nsha",
    });
    const j = joined(h.mergeCalls);
    // Never provisioned a landing worktree, never integrated origin/<base>.
    expect(h.removedWorktrees).toEqual([]);
    expect(j.some((c) => c.includes("merge --ff-only"))).toBe(false);
    expect(j.some((c) => c.includes("merge --no-ff"))).toBe(false);
  });

  it("the precondition NEVER resets / stashes / auto-commits / force-pushes to repair the divergence", async () => {
    const h = harness({ locked: false, trunk: "diverged" });
    await doLanding(h.deps, h.input, h.hooks);
    for (const c of h.mergeCalls) {
      const j = c.join(" ");
      expect(j.includes("reset")).toBe(false);
      expect(j.includes("stash")).toBe(false);
      expect(j.includes("commit")).toBe(false);
      expect(j.includes("--force")).toBe(false);
    }
    // The only primary-checkout touches are the read-only precondition probes.
    const primaryOps = joined(h.mergeCalls).filter((c) => c.includes("-C /repo"));
    for (const op of primaryOps) {
      expect(/fetch|rev-parse|merge-base/.test(op)).toBe(true);
    }
  });

  it("absent local trunk → precondition proceeds and lands unchanged", async () => {
    const h = harness({ locked: false, trunk: "absent" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
  });

  it("ancestor local trunk (default) → precondition proceeds and lands unchanged", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    // The precondition fresh-fetched origin/<trunk> then admin-merged.
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c === "git -C /repo fetch origin main --quiet")).toBe(true);
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
  });
});

describe("doLanding — sensitive-path guard (issue #1102)", () => {
  it("diff touching .github/workflows → aborts with sensitive-paths BEFORE any push/hook/land", async () => {
    const h = harness({ locked: false, sensitivePaths: "hit" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("sensitive-paths");
      expect(r.locked).toBe(false);
      expect(r.sensitivePaths).toBeDefined();
      expect(r.sensitivePaths!.length).toBeGreaterThan(0);
      expect(r.sensitivePaths![0].path).toBe(".github/workflows/ci.yml");
    }
    // The abort is early: no push, no hooks, no landing.
    expect(h.pushedAttempt).toHaveLength(0);
    expect(h.firedHooks).toHaveLength(0);
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr merge"))).toBe(false);
    expect(j.some((c) => c.includes("merge --no-ff"))).toBe(false);
  });

  it("sensitive-paths abort also fires on the DIRECT (locked) path before integrating", async () => {
    const h = harness({ locked: true, sensitivePaths: "hit" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("sensitive-paths");
      expect(r.locked).toBe(true);
    }
    expect(h.pushedAttempt).toHaveLength(0);
    expect(h.firedHooks).toHaveLength(0);
    expect(h.removedWorktrees).toHaveLength(0);
  });

  it("clean diff with no sensitive paths proceeds to a normal landing", async () => {
    const h = harness({ locked: false, sensitivePaths: "clean" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    expect(h.pushedAttempt).toHaveLength(1);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });

  it("absent getDiffPaths dep → guard is skipped, landing proceeds normally", async () => {
    // sensitivePaths: undefined → getDiffPaths not wired → guard is a no-op.
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
  });

  it("sensitivePathApproved=true → guard bypassed, a hit diff lands normally (#1171 adopt path)", async () => {
    // The `/requeue --adopt-branch` human land: getDiffPaths still HITS a
    // protected path, but the maintainer-approved flag skips the guard so the
    // reviewed branch lands.
    const h = harness({ locked: false, sensitivePaths: "hit", sensitivePathApproved: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    expect(h.pushedAttempt).toHaveLength(1);
    expect(h.firedHooks).toEqual(["pre_merge", "post_merge"]);
  });

  it("sensitivePathApproved defaults undefined/false → a hit diff STILL parks (guard not weakened for the agent path)", async () => {
    // The autonomous path never sets the flag, so the identical hit diff aborts.
    const h = harness({ locked: false, sensitivePaths: "hit" });
    expect(h.input.sensitivePathApproved).toBeUndefined();
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("sensitive-paths");
    expect(h.pushedAttempt).toHaveLength(0);
  });
});

describe("doLanding — abort / failure short-circuits", () => {
  it("push failure → { ok:false, land-failed } before any hook fires (no silent zero-diff)", async () => {
    const h = harness({ locked: false });
    // Simulate the continuous-push hook having failed: the initial push also fails.
    h.deps.remoteGit = async () => ({ code: 1, stdout: "", stderr: "fatal: authentication failed" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "land-failed", locked: false });
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
    expect(r).toEqual({ ok: true, locked: false });
    // It still admin-merged the PR.
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
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

  it("a real DIRTY conflict preserves the PR number for the caller's merge-conflict handoff", async () => {
    const h = harness({ locked: false, ciAware: "conflict" });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "pr-conflict", locked: false, prNumber: 42 });
  });

  it("a rejected admin merge after PR creation preserves the PR instead of collapsing to generic land-failed", async () => {
    const h = harness({ locked: false, prMergeCode: 1 });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: false, reason: "pr-merge-failed", locked: false, prNumber: 42 });
  });
});

describe("doLanding — PR-path pre-merge rebase (#1006)", () => {
  it("branch diverged by one unrelated commit is rebased in the worktree, force-pushed, then merged cleanly", async () => {
    const h = harness({ locked: false, rebaseWorktree: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
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

  it("no lock + false + stale local main → fast-forwards the freshly fetched origin/main to the validated branch tip", async () => {
    const branchTip = "1234567890abcdef";
    const h = harness({ locked: false, openPr: false, branchTip });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });

    const j = joined(h.mergeCalls);
    const fetchBaseIdx = j.findIndex((c) => c === "git -C /repo fetch origin main --quiet");
    const integrateIdx = j.findIndex((c) => c === `git -C ${WT} merge --ff-only origin/main`);
    const resolveTipIdx = j.findIndex(
      (c) => c === `git -C ${WT} rev-parse --verify --quiet origin/afk/wAAAA/9-fix-the-thing`,
    );
    const ancestorIdx = j.findIndex((c) => c === `git -C ${WT} merge-base --is-ancestor origin/main ${branchTip}`);
    const fastForwardIdx = j.findIndex((c) => c === `git -C ${WT} merge --ff-only ${branchTip}`);
    const pushIdx = j.findIndex((c) => c === `git -C ${WT} push origin HEAD:refs/heads/main`);

    expect(fetchBaseIdx).toBeGreaterThanOrEqual(0);
    expect(integrateIdx).toBeGreaterThan(fetchBaseIdx);
    expect(resolveTipIdx).toBeGreaterThan(integrateIdx);
    expect(ancestorIdx).toBeGreaterThan(resolveTipIdx);
    expect(fastForwardIdx).toBeGreaterThan(ancestorIdx);
    expect(pushIdx).toBeGreaterThan(fastForwardIdx);
    expect(j.some((c) => c.includes("merge --no-ff"))).toBe(false);
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
    // The ADR 0083 precondition READS refs/heads/main (the trunk, read-only); the
    // landing's WRITE ops (merge/push) must never target main.
    expect(j.some((c) => (c.includes("merge --") || c.includes("push ")) && c.includes("main"))).toBe(false);
    expect(prMerged(j)).toBe(false);
  });

  it("afk.merge.* still governs the PR merge: lock=X + true + wait_for_review polls before the admin-merge", async () => {
    // The flag only decides whether a PR opens; HOW it merges stays afk.merge.*.
    const h = harness({ locked: true, openPr: true, waitForReview: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    const checksIdx = j.findIndex((c) => c.includes("pr checks"));
    const mergeIdx = j.findIndex((c) => c.includes("pr merge 42 --merge"));
    expect(checksIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(checksIdx);
  });
});

describe("doLanding — primary promotion is a guarded fast-forward only (ADR 0083 §2 amended, #1019)", () => {
  // ADR 0083 §2 (amended): a landing may now advance the primary's local <base>
  // to the freshly merged origin tip — for LOCKED landings too — via the
  // hardened fastForwardLocalTarget, so a locked repo's local base stops rotting
  // and the next worker forks a fresh base. The §2 SAFETY intent is preserved:
  // the ONLY primary write any landing path may issue is `merge --ff-only`, and
  // never on a dirty or diverged primary. A DESTRUCTIVE verb against `/repo`
  // (`merge --no-ff`, reset, rebase, checkout, switch, commit, cherry-pick)
  // remains categorically forbidden.
  const DESTRUCTIVE_VERBS = new Set(["reset", "rebase", "checkout", "switch", "commit", "cherry-pick"]);
  /** `git -C /repo …` calls that mutate primary content beyond a pure ff — the
   * forbidden set. `merge --ff-only` is the one allowed primary write, so a
   * `merge` token counts only when it is NOT `--ff-only`. */
  function destructivePrimaryWrites(h: Harness): string[] {
    return h.mergeCalls
      .filter((argv) => {
        const i = argv.indexOf("/repo");
        if (i < 1 || argv[i - 1] !== "-C") return false;
        const destructiveMerge = argv.includes("merge") && !argv.includes("--ff-only");
        return destructiveMerge || argv.some((tok) => DESTRUCTIVE_VERBS.has(tok));
      })
      .map((argv) => argv.join(" "));
  }

  it("locked + PR (default flag) → admin-merges remotely AND guard-fast-forwards the primary's local lock branch", async () => {
    const h = harness({ locked: true, openPr: true });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    // The PR is admin-merged remotely — the integration lands on origin.
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    // The guarded promotion now advances the primary's local lock branch too.
    expect(j).toContain("git -C /repo merge --ff-only origin/feature-locked");
    // …but no destructive write ever touches the primary.
    expect(destructivePrimaryWrites(h)).toEqual([]);
  });

  it("locked + PR on a DIRTY primary → skips the promotion (WIP is sacred, #1019)", async () => {
    const h = harness({ locked: true, openPr: true, dirtyPrimary: true });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true });
    const j = joined(h.mergeCalls);
    expect(j.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    // The dirty-tree guard makes the promotion a no-op — the primary is untouched.
    expect(j.some((c) => c.includes("git -C /repo merge --ff-only"))).toBe(false);
    expect(destructivePrimaryWrites(h)).toEqual([]);
  });

  it("locked + direct → merges/pushes in the worktree, then guard-fast-forwards the primary", async () => {
    const h = harness({ locked: true, openPr: false });
    h.input.base = "feature-locked";
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    // The integrated result reaches the maintainer on origin/<lock-branch>.
    expect(joined(h.mergeCalls)).toContain(`git -C ${WT} push origin HEAD:refs/heads/feature-locked`);
    // The primary's local lock branch is promoted by the guarded ff, nothing more.
    expect(joined(h.mergeCalls)).toContain("git -C /repo merge --ff-only origin/feature-locked");
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

  it("UNLOCKED PR landing is unchanged — still fast-forwards the primary's local main (criterion 3)", async () => {
    const h = harness({ locked: false, openPr: true });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: false });
    // The unlocked path keeps its best-effort local fast-forward of <target>=main.
    expect(joined(h.mergeCalls).some((c) => c.includes("git -C /repo merge --ff-only origin/main"))).toBe(true);
  });
});
