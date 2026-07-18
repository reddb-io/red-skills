import { describe, expect, it } from "vitest";
import {
  branchMatchesIssue,
  parseIssueSpecifier,
  planRetakeApply,
  recommendRetake,
  summarizeChecks,
} from "../src/core/retake.js";

const issue = {
  number: 123,
  title: "Retake this",
  state: "OPEN",
  labels: [],
};

describe("retake helpers", () => {
  it("parses plain, hash, and issue URL specifiers", () => {
    expect(parseIssueSpecifier("123")).toBe(123);
    expect(parseIssueSpecifier("#123")).toBe(123);
    expect(parseIssueSpecifier("https://github.com/reddb-io/red-skills/issues/123")).toBe(123);
  });

  it("matches issue numbers in common branch names", () => {
    expect(branchMatchesIssue("codex/123-retake", 123)).toBe(true);
    expect(branchMatchesIssue("origin/afk/wABCD/123-add-feature", 123)).toBe(true);
    expect(branchMatchesIssue("codex/9123-other", 123)).toBe(false);
  });

  it("matches PRs linked by body references", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [{ number: 10, title: "Finish work", body: "Closes #123", state: "OPEN", checksState: "green" }],
      branches: [],
      worktrees: [],
    })).toMatchObject({ kind: "ship-pr" });
  });

  it("does not match body prose that only mentions the number", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [{ number: 10, title: "Finish work", body: "Validated with retake 123", state: "MERGED", checksState: "green" }],
      branches: [],
      worktrees: [],
    })).toMatchObject({ kind: "create-branch" });
  });

  it("summarizes check rollups", () => {
    expect(summarizeChecks([{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }])).toBe("green");
    expect(summarizeChecks([{ status: "IN_PROGRESS" }])).toBe("pending");
    expect(summarizeChecks([{ conclusion: "FAILURE" }])).toBe("failing");
    expect(summarizeChecks([])).toBe("unknown");
  });
});

describe("recommendRetake", () => {
  it("routes ready-for-human issues to HITL first", () => {
    expect(recommendRetake({
      issue: { ...issue, labels: ["ready-for-human"] },
      pullRequests: [{ number: 10, title: "ship: #123", state: "OPEN", checksState: "green" }],
      branches: [],
      worktrees: [],
    })).toMatchObject({ kind: "resolve-hitl", command: "/hitl #123" });
  });

  it("recommends fixing an open PR with failing checks", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [{ number: 10, title: "ship: #123", state: "OPEN", headRefName: "codex/123-retake", checksState: "failing" }],
      branches: [],
      worktrees: [{ path: "/repo/.red/tmp/work-ship-123", branch: "codex/123-retake", dirty: false }],
    })).toMatchObject({ kind: "fix-pr", command: "cd /repo/.red/tmp/work-ship-123" });
  });

  it("prefers a worker state file anchor over branch/worktree fallback", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [],
      branches: [{ name: "origin/codex/123-retake", remote: true }],
      worktrees: [],
      workerState: {
        path: "/repo/.red/tmp/workers/wAAAA/123-a2/afk.state.toon",
        attemptDir: "/repo/.red/tmp/workers/wAAAA/123-a2",
        issue: 123,
        attempt: 2,
        phase: "terminal",
        outcome: "stalled",
        lastExitCode: 124,
      },
    })).toMatchObject({
      kind: "continue-state",
      command: "cd /repo/.red/tmp/workers/wAAAA/123-a2",
    });
  });

  it("recommends continuing a dirty matching worktree", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [],
      branches: [],
      worktrees: [{ path: "/repo/.red/tmp/work-ship-123", branch: "codex/123-retake", dirty: true }],
    })).toMatchObject({ kind: "continue-worktree" });
  });

  it("recommends adopting a clean open PR through the no-agent lane", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [{ number: 10, title: "ship: #123", state: "OPEN", headRefName: "codex/123-retake", checksState: "green" }],
      branches: [],
      worktrees: [{ path: "/repo/.red/tmp/work-ship-123", branch: "codex/123-retake", dirty: false }],
    })).toMatchObject({ kind: "ship-pr", command: "cd /repo/.red/tmp/work-ship-123 && red-skills-dev requeue 123 --adopt-branch codex/123-retake --guidance 'Hand-done work adopted via /retake; run the gate.'" });
  });

  it("recommends creating a fresh branch when no local state exists", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [],
      branches: [],
      worktrees: [],
    })).toMatchObject({ kind: "create-branch" });
  });

  it("recreates remote branches as local branches inside ship worktrees", () => {
    expect(recommendRetake({
      issue,
      pullRequests: [],
      branches: [{ name: "origin/codex/123-retake", remote: true }],
      worktrees: [],
    })).toMatchObject({
      kind: "create-worktree",
      command: "git worktree add .red/tmp/work-ship-123 -b codex/123-retake origin/codex/123-retake",
    });
  });

  it("plans a safe apply for a fresh issue with no local state", () => {
    expect(planRetakeApply({
      issue,
      pullRequests: [],
      branches: [],
      worktrees: [],
    })).toMatchObject({
      operations: [{
        cmd: "git",
        args: ["worktree", "add", ".red/tmp/work-ship-123", "-b", "codex/123-retake", "origin/main"],
      }],
      nextCommand: "cd .red/tmp/work-ship-123",
    });
  });

  it("plans a safe apply that recreates a worktree for an open PR", () => {
    expect(planRetakeApply({
      issue,
      pullRequests: [{ number: 10, title: "ship: #123", state: "OPEN", headRefName: "codex/123-retake", checksState: "green" }],
      branches: [],
      worktrees: [],
    })).toMatchObject({
      operations: [
        { cmd: "git", args: ["fetch", "origin", "codex/123-retake:codex/123-retake"] },
        { cmd: "git", args: ["worktree", "add", ".red/tmp/work-ship-123", "codex/123-retake"] },
      ],
      nextCommand: "cd .red/tmp/work-ship-123 && red-skills-dev requeue 123 --adopt-branch codex/123-retake --guidance 'Hand-done work adopted via /retake; run the gate.'",
    });
  });

  it("plans no git operations when worker state already anchors the attempt", () => {
    expect(planRetakeApply({
      issue,
      pullRequests: [],
      branches: [{ name: "origin/codex/123-retake", remote: true }],
      worktrees: [],
      workerState: {
        path: "/repo/.red/tmp/workers/wAAAA/123-a2/afk.state.toon",
        attemptDir: "/repo/.red/tmp/workers/wAAAA/123-a2",
        issue: 123,
        attempt: 2,
        phase: "terminal",
        outcome: "stalled",
        lastExitCode: 124,
      },
    })).toMatchObject({
      operations: [],
      nextCommand: "cd /repo/.red/tmp/workers/wAAAA/123-a2",
    });
  });

  it("does not run git when the next step is HITL", () => {
    expect(planRetakeApply({
      issue: { ...issue, labels: ["ready-for-human"] },
      pullRequests: [],
      branches: [],
      worktrees: [],
    })).toMatchObject({
      operations: [],
      nextCommand: "/hitl #123",
    });
  });
});
