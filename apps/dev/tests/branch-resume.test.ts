import { describe, expect, it } from "vitest";
import {
  buildResumeInstruction,
  decideBranchAdoption,
  discoverResumableBranch,
  extractFailureReason,
  formatAdoptionNotice,
  isExplicitRestartRequested,
  isGateGreenBranch,
} from "../src/core/branch-resume.js";
import type { BranchRef } from "../src/core/branch-cleanup.js";

// Refs #2397

describe("discoverResumableBranch", () => {
  it("returns null for an empty ref list", () => {
    expect(discoverResumableBranch([], 42)).toBeNull();
  });

  it("returns null when no branch matches the issue", () => {
    const refs: BranchRef[] = [
      { branch: "afk/wAB12/10-other-issue", commitS: 1000 },
      { branch: "afk/wAB12/11-another", commitS: 2000 },
    ];
    expect(discoverResumableBranch(refs, 9)).toBeNull();
  });

  it("returns the single matching branch", () => {
    const refs: BranchRef[] = [
      { branch: "afk/wAB12/9-fix-the-thing", commitS: 1000 },
      { branch: "afk/wAB12/10-other-issue", commitS: 2000 },
    ];
    expect(discoverResumableBranch(refs, 9)).toEqual({
      branch: "afk/wAB12/9-fix-the-thing",
      commitS: 1000,
    });
  });

  it("selects the branch with the highest commitS when multiple match", () => {
    const refs: BranchRef[] = [
      { branch: "afk/wAB12/9-fix-the-thing", commitS: 1000 },
      { branch: "afk/wXX99/9-fix-the-thing", commitS: 3000 },
      { branch: "afk/wYY01/9-fix-the-thing", commitS: 2000 },
    ];
    expect(discoverResumableBranch(refs, 9)?.branch).toBe("afk/wXX99/9-fix-the-thing");
  });

  it("prefers a branch with a commitS over one without", () => {
    const refs: BranchRef[] = [
      { branch: "afk/wAB12/9-fix-the-thing" },
      { branch: "afk/wXX99/9-fix-the-thing", commitS: 1 },
    ];
    expect(discoverResumableBranch(refs, 9)?.branch).toBe("afk/wXX99/9-fix-the-thing");
  });

  it("returns a branch even when commitS is absent on all candidates", () => {
    const refs: BranchRef[] = [
      { branch: "afk/wAB12/9-fix-the-thing" },
    ];
    expect(discoverResumableBranch(refs, 9)?.branch).toBe("afk/wAB12/9-fix-the-thing");
  });

  it("ignores snapshot branches (afk-attempts/*) and other namespaces", () => {
    const refs: BranchRef[] = [
      { branch: "afk-attempts/wAB12/9-fix-the-thing", commitS: 9999 },
      { branch: "main", commitS: 9999 },
      { branch: "afk/wAB12/9-fix-the-thing", commitS: 100 },
    ];
    expect(discoverResumableBranch(refs, 9)?.branch).toBe("afk/wAB12/9-fix-the-thing");
  });
});

describe("extractFailureReason", () => {
  it("returns undefined for undefined context", () => {
    expect(extractFailureReason(undefined)).toBeUndefined();
  });

  it("returns undefined when the marker is absent", () => {
    expect(extractFailureReason("prev-snapshot-branch: afk/wAB12/9-fix")).toBeUndefined();
  });

  it("extracts the reason after prev-failure-reason:", () => {
    const ctx = "prev-attempt: 1\nprev-failure-reason:\nlanding-quota-exceeded\n";
    expect(extractFailureReason(ctx)).toBe("landing-quota-exceeded");
  });

  it("trims surrounding whitespace from the extracted reason", () => {
    const ctx = "prev-failure-reason:   feedback-failed   ";
    expect(extractFailureReason(ctx)).toBe("feedback-failed");
  });

  it("handles multi-word reason text", () => {
    const ctx = "prev-failure-reason:\nsome custom reason here\n";
    expect(extractFailureReason(ctx)).toBe("some custom reason here");
  });
});

describe("isGateGreenBranch", () => {
  it("returns false for undefined reason (first attempt — no prior context)", () => {
    expect(isGateGreenBranch(undefined)).toBe(false);
  });

  it("returns false for empty string reason", () => {
    expect(isGateGreenBranch("")).toBe(false);
  });

  it.each([
    "feedback-failed",
    "no-sentinel",
    "stalled",
    "blocked",
    "base-stale",
    "merge-conflict",
    "runner-transient",
    "exhausted",
    "signal-killed",
  ])("returns false for gate-stage failure reason %s", (reason) => {
    expect(isGateGreenBranch(reason)).toBe(false);
  });

  it.each([
    "landing-quota-exceeded",
    "landing-conflict",
    "pr-open-failed",
    "some-other-post-gate-reason",
  ])("returns true for post-gate failure reason %s", (reason) => {
    expect(isGateGreenBranch(reason)).toBe(true);
  });

  it("checks only the first token, ignoring subsequent words", () => {
    expect(isGateGreenBranch("landing-quota-exceeded: GitHub API rate limit")).toBe(true);
    expect(isGateGreenBranch("feedback-failed: tests failed")).toBe(false);
  });
});

describe("isExplicitRestartRequested", () => {
  it("returns false for empty guidance", () => {
    expect(isExplicitRestartRequested("")).toBe(false);
  });

  it("returns false for guidance that does not mention restart/rebuild", () => {
    expect(isExplicitRestartRequested("Please fix the typo in the commit message.")).toBe(false);
  });

  it("returns true when guidance contains 'restart' as a whole word", () => {
    expect(isExplicitRestartRequested("Please restart from scratch.")).toBe(true);
  });

  it("returns true when guidance contains 'rebuild'", () => {
    expect(isExplicitRestartRequested("We need to rebuild this from the ground up.")).toBe(true);
  });

  it("returns true case-insensitively", () => {
    expect(isExplicitRestartRequested("RESTART the implementation.")).toBe(true);
    expect(isExplicitRestartRequested("Rebuild with a different approach.")).toBe(true);
  });

  it("does not match 'restarting' because the trailing word boundary prevents a partial-stem match", () => {
    expect(isExplicitRestartRequested("restarting the service")).toBe(false);
  });
});

describe("buildResumeInstruction", () => {
  it("includes the branch name in both variants", () => {
    const branch = "afk/wAB12/9-fix-the-thing";
    expect(buildResumeInstruction(branch, true)).toContain(branch);
    expect(buildResumeInstruction(branch, false)).toContain(branch);
  });

  it("gate-green variant mentions 'gate already passed' and advises not re-implementing", () => {
    const text = buildResumeInstruction("afk/wAB12/9-fix", true);
    expect(text).toContain("gate already passed");
    expect(text).toContain("Do NOT re-implement");
  });

  it("non-gate-green variant tells the agent to continue from where it left off", () => {
    const text = buildResumeInstruction("afk/wAB12/9-fix", false);
    expect(text).toContain("Continue from where it left off");
    expect(text).toContain("do NOT start over");
  });

  it("both variants open with a mandatory base sync before any work (#2481)", () => {
    for (const gateGreen of [true, false]) {
      const text = buildResumeInstruction("afk/wAB12/9-fix", gateGreen);
      expect(text).toContain("FIRST, before anything else, sync the branch");
      expect(text).toContain("git rebase origin/main");
      expect(text).toContain("git push --force-with-lease");
    }
  });

  it("sync instruction names the configured base branch", () => {
    const text = buildResumeInstruction("afk/wAB12/9-fix", false, "develop");
    expect(text).toContain("git fetch origin develop");
    expect(text).toContain("git rebase origin/develop");
    expect(text).toContain("origin/develop..HEAD");
  });
});

// Refs #2865

describe("decideBranchAdoption", () => {
  const CANDIDATE: BranchRef = { branch: "afk/9-fix-the-thing", commitS: 1000 };

  it("returns none when no branch for the issue exists", () => {
    expect(
      decideBranchAdoption({
        candidate: null,
        commitsAhead: undefined,
        explicitRestart: false,
        hasOpenPullRequest: false,
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none for a branch that carries no commits ahead of the base", () => {
    // Worktree creation pushes the deterministic ref before the agent writes a
    // line, so a name match alone is not evidence of work.
    expect(
      decideBranchAdoption({
        candidate: CANDIDATE,
        commitsAhead: 0,
        explicitRestart: false,
        hasOpenPullRequest: false,
      }),
    ).toEqual({ kind: "none" });
  });

  it("adopts a branch that carries commits ahead of the base", () => {
    expect(
      decideBranchAdoption({
        candidate: CANDIDATE,
        commitsAhead: 9,
        explicitRestart: false,
        hasOpenPullRequest: false,
      }),
    ).toEqual({
      kind: "adopt",
      branch: CANDIDATE.branch,
      commitsAhead: 9,
      hasOpenPullRequest: false,
    });
  });

  it("adopts when the commit count is unknown — an unread branch is never assumed empty", () => {
    const decision = decideBranchAdoption({
      candidate: CANDIDATE,
      commitsAhead: undefined,
      explicitRestart: false,
      hasOpenPullRequest: false,
    });
    expect(decision.kind).toBe("adopt");
  });

  it("refuses with a stated reason when a human directive asked for a restart", () => {
    const decision = decideBranchAdoption({
      candidate: CANDIDATE,
      commitsAhead: 9,
      explicitRestart: true,
      hasOpenPullRequest: false,
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("unreachable");
    expect(decision.branch).toBe(CANDIDATE.branch);
    expect(decision.commitsAhead).toBe(9);
    expect(decision.reason).toMatch(/restart/i);
  });

  it("does not announce a refusal for an empty branch a restart would discard", () => {
    expect(
      decideBranchAdoption({
        candidate: CANDIDATE,
        commitsAhead: 0,
        explicitRestart: true,
        hasOpenPullRequest: false,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("formatAdoptionNotice", () => {
  it("surfaces a branch that carries commits and has no open pull request", () => {
    const notice = formatAdoptionNotice(
      { kind: "adopt", branch: "afk/9-fix-the-thing", commitsAhead: 9, hasOpenPullRequest: false },
      9,
    );
    expect(notice).toContain("afk/9-fix-the-thing");
    expect(notice).toContain("9 commits");
    expect(notice).toContain("no open pull request");
  });

  it("stays silent when an open pull request already surfaces the work", () => {
    expect(
      formatAdoptionNotice(
        { kind: "adopt", branch: "afk/9-fix-the-thing", commitsAhead: 9, hasOpenPullRequest: true },
        9,
      ),
    ).toBeNull();
  });

  it("records the reason adoption was refused", () => {
    const notice = formatAdoptionNotice(
      { kind: "refused", branch: "afk/9-fix-the-thing", commitsAhead: 9, reason: "a human directive asked for a restart" },
      9,
    );
    expect(notice).toContain("afk/9-fix-the-thing");
    expect(notice).toContain("a human directive asked for a restart");
    expect(notice).toContain("9 commits");
  });

  it("says nothing when there was no branch to decide about", () => {
    expect(formatAdoptionNotice({ kind: "none" }, 9)).toBeNull();
  });

  it("names an unknown commit count as unknown rather than as zero", () => {
    const notice = formatAdoptionNotice(
      { kind: "adopt", branch: "afk/9-fix-the-thing", commitsAhead: undefined, hasOpenPullRequest: false },
      9,
    );
    expect(notice).toContain("an unknown number of commits");
  });
});
