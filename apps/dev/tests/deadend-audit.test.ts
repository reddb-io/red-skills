import { describe, expect, it } from "vitest";
import {
  auditDeadends,
  CURE_BY_CLASS,
  DEADEND_CLASS_ORDER,
  type DeadendAuditInputs,
  type DeadendClass,
} from "../src/core/deadend-audit.js";

const NOW = Date.parse("2026-07-23T12:00:00Z");

function baseInputs(over: Partial<DeadendAuditInputs> = {}): DeadendAuditInputs {
  return {
    nowMs: NOW,
    liveWorkers: [],
    issues: [],
    prs: [],
    claims: [],
    worktrees: [],
    issueStates: new Map(),
    humanQueueMaxAgeMs: 24 * 60 * 60 * 1000,
    ...over,
  };
}

function activeBlockerBody(): string {
  return [
    "## Current blocker",
    "",
    "<!-- red:blocker-state v1 -->",
    "status: blocked",
    "kind: runner",
    "summary: Agent idle for 600 seconds",
    "next: human guidance required",
    "<!-- /red:blocker-state -->",
  ].join("\n");
}

function findingsFor(report: ReturnType<typeof auditDeadends>, cls: DeadendClass) {
  return report.classes.find((c) => c.deadendClass === cls)!;
}

describe("auditDeadends — per-class detection with pinned cure", () => {
  it("always reports every class in canonical order, even with no findings", () => {
    const report = auditDeadends(baseInputs());
    expect(report.classes.map((c) => c.deadendClass)).toEqual(DEADEND_CLASS_ORDER);
    expect(report.total).toBe(0);
    for (const cls of report.classes) {
      expect(cls.cure).toBe(CURE_BY_CLASS[cls.deadendClass]);
      expect(cls.count).toBe(0);
    }
  });

  it("detects a dangling claim from a dead worker → claim_release", () => {
    const report = auditDeadends(
      baseInputs({
        liveWorkers: ["wLIVE"],
        claims: [
          { issue: 100, worker: "wDEAD" },
          { issue: 101, worker: "wLIVE" },
        ],
      }),
    );
    const cls = findingsFor(report, "dangling_claim");
    expect(cls.cure).toBe("claim_release");
    expect(cls.findings).toHaveLength(1);
    expect(cls.findings[0]!.subject).toBe("#100");
    expect(cls.findings[0]!.detail).toContain("wDEAD");
  });

  it("detects a red PR with a dead owner → retake", () => {
    const report = auditDeadends(
      baseInputs({
        liveWorkers: ["wLIVE"],
        prs: [
          { number: 5, issue: 100, owner: "wDEAD", checksRed: true },
          { number: 6, issue: 101, owner: "wDEAD", checksRed: false }, // green: not stuck
          { number: 7, issue: 102, owner: "wLIVE", checksRed: true }, // live owner: not stuck
          { number: 8, issue: 103, owner: "", checksRed: true }, // unknown owner: not stuck
        ],
      }),
    );
    const cls = findingsFor(report, "red_pr_dead_owner");
    expect(cls.cure).toBe("retake");
    expect(cls.findings.map((f) => f.subject)).toEqual(["PR #5"]);
  });

  it("detects a superseded PR left open → close_superseded_pr", () => {
    const report = auditDeadends(
      baseInputs({
        liveWorkers: ["w1"],
        prs: [
          { number: 10, issue: 200, owner: "w1", checksRed: false },
          { number: 12, issue: 200, owner: "w1", checksRed: false }, // newest → current
          { number: 30, issue: 201, owner: "w1", checksRed: false }, // lone PR: not superseded
        ],
      }),
    );
    const cls = findingsFor(report, "superseded_pr");
    expect(cls.cure).toBe("close_superseded_pr");
    expect(cls.findings.map((f) => f.subject)).toEqual(["PR #10"]);
    expect(cls.findings[0]!.detail).toContain("#12");
  });

  it("detects an executable Ticket with an active Current blocker → quarantine", () => {
    const report = auditDeadends(
      baseInputs({
        issues: [
          { number: 300, labels: ["ready-for-agent"], body: activeBlockerBody() },
          { number: 301, labels: ["ready-for-agent"], body: "no blocker here" },
          { number: 302, labels: ["ready-for-human"], body: activeBlockerBody() }, // not executable
        ],
      }),
    );
    const cls = findingsFor(report, "active_current_blocker");
    expect(cls.cure).toBe("quarantine");
    expect(cls.findings.map((f) => f.subject)).toEqual(["#300"]);
  });

  it("quarantines a malformed status: blocked record and names its defect", () => {
    const malformed = [
      "<!-- red:blocker-state v1 -->",
      "status: blocked",
      "kind: runner",
      "<!-- /red:blocker-state -->",
    ].join("\n");
    const report = auditDeadends(baseInputs({
      issues: [{ number: 303, labels: ["ready-for-agent"], body: malformed }],
    }));

    const finding = findingsFor(report, "active_current_blocker").findings[0]!;
    expect(finding.subject).toBe("#303");
    expect(finding.detail).toContain("malformed-blocker-state");
  });

  it("detects a dependency-blocked Ticket whose req targets all closed → unblock_sweep", () => {
    const report = auditDeadends(
      baseInputs({
        issues: [
          { number: 400, labels: ["blocked:dependency", "req:10", "req:11"], body: "" },
          { number: 401, labels: ["blocked:dependency", "req:12", "req:13"], body: "" },
        ],
        issueStates: new Map([
          [10, "CLOSED"],
          [11, "CLOSED"],
          [12, "CLOSED"],
          [13, "OPEN"], // one still open → 401 stays blocked
        ]),
      }),
    );
    const cls = findingsFor(report, "dependency_all_closed");
    expect(cls.cure).toBe("unblock_sweep");
    expect(cls.findings.map((f) => f.subject)).toEqual(["#400"]);
  });

  it("detects a human-queue age outlier → hitl_review", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const report = auditDeadends(
      baseInputs({
        humanQueueMaxAgeMs: dayMs,
        issues: [
          {
            number: 500,
            labels: ["ready-for-human"],
            body: "",
            updatedAt: new Date(NOW - 3 * dayMs).toISOString(),
          },
          {
            number: 501,
            labels: ["ready-for-human"],
            body: "",
            updatedAt: new Date(NOW - dayMs / 2).toISOString(), // fresh
          },
        ],
      }),
    );
    const cls = findingsFor(report, "human_queue_age_outlier");
    expect(cls.cure).toBe("hitl_review");
    expect(cls.findings.map((f) => f.subject)).toEqual(["#500"]);
  });

  it("detects a stale feedback/base worktree → worktree_remove", () => {
    const report = auditDeadends(
      baseInputs({
        worktrees: [
          { lane: "feedback", path: ".red/tmp/worktrees/feedback/dead", live: false },
          { lane: "base", path: ".red/tmp/worktrees/base/live", live: true },
        ],
      }),
    );
    const cls = findingsFor(report, "stale_worktree");
    expect(cls.cure).toBe("worktree_remove");
    expect(cls.findings.map((f) => f.subject)).toEqual([
      ".red/tmp/worktrees/feedback/dead",
    ]);
  });

  it("sums total across all classes", () => {
    const report = auditDeadends(
      baseInputs({
        claims: [{ issue: 1, worker: "wDEAD" }],
        worktrees: [{ lane: "feedback", path: "p", live: false }],
      }),
    );
    expect(report.total).toBe(2);
    expect(report.generatedAtMs).toBe(NOW);
  });
});
