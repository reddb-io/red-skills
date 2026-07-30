import { describe, it, expect } from "vitest";
import {
  formatOrphanBranchListing,
  isPushOnlyDispatch,
  issueFromBranchRef,
  listOrphanBranches,
  orphanedWorkDispatchFailure,
  type OrphanBranchProbe,
} from "../src/core/orphan-branch.js";

// The observed loss (#2893): a `/go` dispatch for #2888 pushed 7 commits
// implementing the whole demand, opened no PR, and reported `engine exit 0`,
// `progress: 1/1 (100%)`. The branch was found by a human reading `git branch
// -r`. This fixture is that run.
const EXIT_ZERO_WITH_ORPHAN_BRANCH = {
  targeted: true,
  pushOnly: false,
  branches: [{ branch: "afk/2888-go-in-apps-redskilled-src-memory-sampler", commitsAhead: 7 }] satisfies OrphanBranchProbe[],
  openPullRequests: [] as { number: number; headRefName: string; body?: string }[],
  issues: [2888],
};

describe("issueFromBranchRef", () => {
  it("resolves the deterministic and the legacy AFK head", () => {
    expect(issueFromBranchRef("afk/2888-go-in-apps-redskilled")).toBe(2888);
    expect(issueFromBranchRef("afk/wCRUD/2888-go-in-apps-redskilled")).toBe(2888);
  });

  it("refuses a ref that is not an AFK head", () => {
    expect(issueFromBranchRef("main")).toBeNull();
    expect(issueFromBranchRef("feature/2888-thing")).toBeNull();
  });
});

describe("listOrphanBranches", () => {
  it("names the branch, the issue and the commit count", () => {
    const orphans = listOrphanBranches(EXIT_ZERO_WITH_ORPHAN_BRANCH);
    expect(orphans).toEqual([
      { branch: "afk/2888-go-in-apps-redskilled-src-memory-sampler", issue: 2888, commitsAhead: 7 },
    ]);
    expect(formatOrphanBranchListing(orphans)[0]).toBe(
      "afk/2888-go-in-apps-redskilled-src-memory-sampler (#2888) — 7 commits ahead of the base, no open pull request",
    );
  });

  it("does not report a branch an open PR already carries", () => {
    const orphans = listOrphanBranches({
      ...EXIT_ZERO_WITH_ORPHAN_BRANCH,
      openPullRequests: [{ number: 41, headRefName: "afk/2888-go-in-apps-redskilled-src-memory-sampler" }],
    });
    expect(orphans).toEqual([]);
  });

  it("does not report a branch an open PR closes from another head", () => {
    const orphans = listOrphanBranches({
      ...EXIT_ZERO_WITH_ORPHAN_BRANCH,
      openPullRequests: [{ number: 42, headRefName: "afk/wZ2R4/2888-legacy-head", body: "Closes #2888" }],
    });
    expect(orphans).toEqual([]);
  });

  it("does not report the empty ref worktree creation pushes", () => {
    const orphans = listOrphanBranches({
      ...EXIT_ZERO_WITH_ORPHAN_BRANCH,
      branches: [{ branch: "afk/2888-go-in-apps-redskilled", commitsAhead: 0 }],
    });
    expect(orphans).toEqual([]);
  });

  it("lists a branch the probe could not read rather than assuming it empty", () => {
    const orphans = listOrphanBranches({
      ...EXIT_ZERO_WITH_ORPHAN_BRANCH,
      branches: [{ branch: "afk/2888-go-in-apps-redskilled", commitsAhead: undefined }],
    });
    expect(orphans).toEqual([{ branch: "afk/2888-go-in-apps-redskilled", issue: 2888, commitsAhead: undefined }]);
    expect(formatOrphanBranchListing(orphans)[0]).toContain("an unread number of commits");
  });

  it("answers only for the issues the dispatch processed", () => {
    const orphans = listOrphanBranches({
      ...EXIT_ZERO_WITH_ORPHAN_BRANCH,
      branches: [
        { branch: "afk/2888-go-in-apps-redskilled", commitsAhead: 7 },
        { branch: "afk/2779-some-other-slice", commitsAhead: 3 },
      ],
    });
    expect(orphans.map((o) => o.issue)).toEqual([2888]);
  });

  it("censuses the whole remote when no issue scope is given", () => {
    const orphans = listOrphanBranches({
      branches: [
        { branch: "afk/2888-go-in-apps-redskilled", commitsAhead: 7 },
        { branch: "afk/2779-some-other-slice", commitsAhead: 3 },
        { branch: "main", commitsAhead: 99 },
      ],
      openPullRequests: [],
    });
    expect(orphans.map((o) => o.issue)).toEqual([2779, 2888]);
  });
});

describe("isPushOnlyDispatch", () => {
  it("recognises a scout run by kind or run mode", () => {
    expect(isPushOnlyDispatch({ kind: "scout" })).toBe(true);
    expect(isPushOnlyDispatch({ runMode: "scout" })).toBe(true);
  });

  it("recognises the local-only mode that lands without a PR", () => {
    expect(isPushOnlyDispatch({ kind: "go", localMerge: true })).toBe(true);
  });

  it("does not excuse an ordinary dispatch", () => {
    expect(isPushOnlyDispatch({ kind: "go", runMode: undefined, localMerge: false })).toBe(false);
    expect(isPushOnlyDispatch({})).toBe(false);
  });
});

describe("orphanedWorkDispatchFailure", () => {
  it("catches the exit-0-with-orphan-branch run", () => {
    const orphans = listOrphanBranches(EXIT_ZERO_WITH_ORPHAN_BRANCH);
    const reason = orphanedWorkDispatchFailure({ targeted: true, pushOnly: false, orphans });
    expect(reason).toContain("afk/2888-go-in-apps-redskilled-src-memory-sampler");
    expect(reason).toContain("#2888");
    expect(reason).toContain("7 commits");
  });

  it("stays silent when a PR carries the work", () => {
    const orphans = listOrphanBranches({
      ...EXIT_ZERO_WITH_ORPHAN_BRANCH,
      openPullRequests: [{ number: 41, headRefName: "afk/2888-go-in-apps-redskilled-src-memory-sampler" }],
    });
    expect(orphanedWorkDispatchFailure({ targeted: true, pushOnly: false, orphans })).toBeNull();
  });

  it("never reports a deliberately push-only run", () => {
    const orphans = listOrphanBranches(EXIT_ZERO_WITH_ORPHAN_BRANCH);
    expect(orphanedWorkDispatchFailure({ targeted: true, pushOnly: true, orphans })).toBeNull();
  });

  it("does not flip the exit code of an open-ended drain", () => {
    const orphans = listOrphanBranches(EXIT_ZERO_WITH_ORPHAN_BRANCH);
    expect(orphanedWorkDispatchFailure({ targeted: false, pushOnly: false, orphans })).toBeNull();
  });

  it("does not fail a run on a probe that could not read the branch", () => {
    const orphans = listOrphanBranches({
      ...EXIT_ZERO_WITH_ORPHAN_BRANCH,
      branches: [{ branch: "afk/2888-go-in-apps-redskilled", commitsAhead: undefined }],
    });
    expect(orphans).toHaveLength(1);
    expect(orphanedWorkDispatchFailure({ targeted: true, pushOnly: false, orphans })).toBeNull();
  });
});
