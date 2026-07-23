import { describe, expect, it } from "vitest";
import {
  auditTmpRoot,
  DIAGNOSTICS_TTL_S,
  FEEDBACK_TTL_S,
  KNOWN_TMP_LANES,
  LOGS_TTL_S,
  parseFeedbackWorktreeWorkerSlug,
  planDiagnosticsJanitor,
  planFeedbackWorktreeJanitor,
  planLogsJanitor,
  planOrphanFeedbackWorktreeSweep,
  planScratchJanitor,
  planTmpJanitor,
  planWorkerDirJanitor,
  SCRATCH_TTL_S,
  type JanitorEntry,
  type OrphanFeedbackEntry,
  type WorkerDirJanitorEntry,
} from "../src/core/tmp-janitor.js";

const NOW = 1_000_000_000;

function entry(path: string, ageS: number): JanitorEntry {
  return { path, mtimeS: NOW - ageS };
}

// ---------- planLogsJanitor ----------

describe("planLogsJanitor", () => {
  it("returns empty plans when there are no entries", () => {
    expect(planLogsJanitor([], NOW)).toEqual({ reclaim: [], spare: [] });
  });

  it("reclaims a log dir strictly older than the TTL", () => {
    const e = entry("/red/tmp/logs/2020-01-01", LOGS_TTL_S + 1);
    expect(planLogsJanitor([e], NOW)).toEqual({ reclaim: [e], spare: [] });
  });

  it("spares a log dir younger than the TTL", () => {
    const e = entry("/red/tmp/logs/2020-01-08", LOGS_TTL_S - 1);
    expect(planLogsJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("spares a log dir whose age equals the TTL exactly (not strictly greater)", () => {
    const e = entry("/red/tmp/logs/2020-01-08", LOGS_TTL_S);
    expect(planLogsJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("partitions a mixed set of log dirs", () => {
    const old = entry("/red/tmp/logs/old", LOGS_TTL_S + 1);
    const fresh = entry("/red/tmp/logs/fresh", LOGS_TTL_S - 1);
    const plan = planLogsJanitor([old, fresh], NOW);
    expect(plan.reclaim).toEqual([old]);
    expect(plan.spare).toEqual([fresh]);
  });
});

// ---------- planScratchJanitor ----------

describe("planScratchJanitor", () => {
  it("returns empty plans when there are no entries", () => {
    expect(planScratchJanitor([], NOW)).toEqual({ reclaim: [], spare: [] });
  });

  it("reclaims a scratch entry strictly older than the TTL", () => {
    const e = entry("/red/tmp/scratch/thing.txt", SCRATCH_TTL_S + 1);
    expect(planScratchJanitor([e], NOW)).toEqual({ reclaim: [e], spare: [] });
  });

  it("spares a scratch entry younger than the TTL", () => {
    const e = entry("/red/tmp/scratch/wip.json", SCRATCH_TTL_S - 1);
    expect(planScratchJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("spares a scratch entry whose age equals the TTL exactly", () => {
    const e = entry("/red/tmp/scratch/boundary", SCRATCH_TTL_S);
    expect(planScratchJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("partitions a mixed set of scratch entries", () => {
    const old = entry("/red/tmp/scratch/stale", SCRATCH_TTL_S + 100);
    const fresh = entry("/red/tmp/scratch/active", 60);
    const plan = planScratchJanitor([old, fresh], NOW);
    expect(plan.reclaim).toEqual([old]);
    expect(plan.spare).toEqual([fresh]);
  });
});

// ---------- planDiagnosticsJanitor ----------

describe("planDiagnosticsJanitor", () => {
  it("returns empty plans when there are no entries", () => {
    expect(planDiagnosticsJanitor([], NOW)).toEqual({ reclaim: [], spare: [] });
  });

  it("reclaims a diagnostics entry past the age cap", () => {
    const e = entry("/red/tmp/diagnostics/crash-1.log", DIAGNOSTICS_TTL_S + 1);
    expect(planDiagnosticsJanitor([e], NOW)).toEqual({ reclaim: [e], spare: [] });
  });

  it("spares a diagnostics entry within the age cap", () => {
    const e = entry("/red/tmp/diagnostics/recent.log", DIAGNOSTICS_TTL_S - 1);
    expect(planDiagnosticsJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("spares a diagnostics entry at exactly the age cap", () => {
    const e = entry("/red/tmp/diagnostics/boundary.log", DIAGNOSTICS_TTL_S);
    expect(planDiagnosticsJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("partitions a mixed set of diagnostics entries", () => {
    const old = entry("/red/tmp/diagnostics/old-crash.log", DIAGNOSTICS_TTL_S + 86400);
    const fresh = entry("/red/tmp/diagnostics/new-crash.log", 3600);
    const plan = planDiagnosticsJanitor([old, fresh], NOW);
    expect(plan.reclaim).toEqual([old]);
    expect(plan.spare).toEqual([fresh]);
  });
});

// ---------- planFeedbackWorktreeJanitor ----------

describe("planFeedbackWorktreeJanitor", () => {
  it("returns empty plans when there are no entries", () => {
    expect(planFeedbackWorktreeJanitor([], NOW)).toEqual({ reclaim: [], spare: [] });
  });

  it("reclaims a feedback worktree entry past the mtime TTL", () => {
    const e = entry("/red/tmp/worktrees/feedback/afk-123", FEEDBACK_TTL_S + 1);
    expect(planFeedbackWorktreeJanitor([e], NOW)).toEqual({ reclaim: [e], spare: [] });
  });

  it("spares a feedback worktree entry within the mtime TTL", () => {
    const e = entry("/red/tmp/worktrees/feedback/afk-456", FEEDBACK_TTL_S - 1);
    expect(planFeedbackWorktreeJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("spares a feedback worktree entry at exactly the mtime TTL", () => {
    const e = entry("/red/tmp/worktrees/feedback/afk-789", FEEDBACK_TTL_S);
    expect(planFeedbackWorktreeJanitor([e], NOW)).toEqual({ reclaim: [], spare: [e] });
  });

  it("makes the mtime decision independently of SHA state (no git call)", () => {
    // A fresh-by-mtime entry is spared even if its SHA might be stale;
    // SHA invalidation is the caller's responsibility, not this planner's.
    const freshByMtime = entry("/red/tmp/worktrees/feedback/stale-sha-branch", FEEDBACK_TTL_S - 1);
    expect(planFeedbackWorktreeJanitor([freshByMtime], NOW)).toEqual({
      reclaim: [],
      spare: [freshByMtime],
    });
  });

  it("partitions a mixed set of feedback entries", () => {
    const stale = entry("/red/tmp/worktrees/feedback/old-branch", FEEDBACK_TTL_S + 3600);
    const live = entry("/red/tmp/worktrees/feedback/active-branch", 300);
    const plan = planFeedbackWorktreeJanitor([stale, live], NOW);
    expect(plan.reclaim).toEqual([stale]);
    expect(plan.spare).toEqual([live]);
  });
});

// ---------- auditTmpRoot ----------

describe("auditTmpRoot", () => {
  it("returns no unknowns when names is empty", () => {
    expect(auditTmpRoot([]).unknown).toEqual([]);
  });

  it("returns no unknowns when all names are in KNOWN_TMP_LANES", () => {
    expect(auditTmpRoot([...KNOWN_TMP_LANES]).unknown).toEqual([]);
  });

  it("flags a dir at the tmp root that is not in the registry", () => {
    expect(auditTmpRoot(["rogue-lane"]).unknown).toEqual(["rogue-lane"]);
  });

  it("flags a loose file at the tmp root", () => {
    expect(auditTmpRoot(["debug.log"]).unknown).toEqual(["debug.log"]);
  });

  it("does not flag legacy supervisor slot logs while they age out", () => {
    expect(auditTmpRoot(["afk-supervisor-slot-0.log", "debug.log"]).unknown).toEqual(["debug.log"]);
  });

  it("passes known lanes through without flagging them", () => {
    const names = ["workers", "claims"];
    expect(auditTmpRoot(names).unknown).toEqual([]);
  });

  it("flags multiple unknowns preserving input order", () => {
    const names = ["workers", "unknown-a", "claims", "unknown-b"];
    expect(auditTmpRoot(names).unknown).toEqual(["unknown-a", "unknown-b"]);
  });

  it("does not delete unknown entries — the result is report-only", () => {
    // This is a design invariant: auditTmpRoot returns a report; the caller
    // applies no deletions based on it. The test asserts the function
    // returns a TmpRootAudit with only an `unknown` list, nothing else.
    const result = auditTmpRoot(["stray-dir"]);
    expect(Object.keys(result)).toEqual(["unknown"]);
  });
});

// ---------- planTmpJanitor (combined) ----------

describe("planTmpJanitor", () => {
  it("returns empty plans and no unknowns for a clean state", () => {
    const plan = planTmpJanitor({
      nowS: NOW,
      logEntries: [],
      scratchEntries: [],
      diagnosticsEntries: [],
      feedbackEntries: [],
      legacySlotLogEntries: [],
      tmpRootNames: [...KNOWN_TMP_LANES],
    });
    expect(plan.logs).toEqual({ reclaim: [], spare: [] });
    expect(plan.scratch).toEqual({ reclaim: [], spare: [] });
    expect(plan.diagnostics).toEqual({ reclaim: [], spare: [] });
    expect(plan.feedbackWorktrees).toEqual({ reclaim: [], spare: [] });
    expect(plan.unknownTmpRoots).toEqual([]);
  });

  it("plans across all lanes and surfaces unknown tmp root entries", () => {
    const oldLog = entry("/red/tmp/logs/2020-01-01", LOGS_TTL_S + 1);
    const freshLog = entry("/red/tmp/logs/2020-01-08", 1);
    const oldScratch = entry("/red/tmp/scratch/old.txt", SCRATCH_TTL_S + 1);
    const freshDiag = entry("/red/tmp/diagnostics/recent.log", 1);
    const oldFeedback = entry("/red/tmp/worktrees/feedback/stale", FEEDBACK_TTL_S + 1);
    const freshFeedback = entry("/red/tmp/worktrees/feedback/current", 1);

    const plan = planTmpJanitor({
      nowS: NOW,
      logEntries: [oldLog, freshLog],
      scratchEntries: [oldScratch],
      diagnosticsEntries: [freshDiag],
      feedbackEntries: [oldFeedback, freshFeedback],
      legacySlotLogEntries: [],
      tmpRootNames: ["workers", "logs", "rogue-dir", "scratch"],
    });

    expect(plan.logs.reclaim).toEqual([oldLog]);
    expect(plan.logs.spare).toEqual([freshLog]);
    expect(plan.scratch.reclaim).toEqual([oldScratch]);
    expect(plan.scratch.spare).toEqual([]);
    expect(plan.diagnostics.reclaim).toEqual([]);
    expect(plan.diagnostics.spare).toEqual([freshDiag]);
    expect(plan.feedbackWorktrees.reclaim).toEqual([oldFeedback]);
    expect(plan.feedbackWorktrees.spare).toEqual([freshFeedback]);
    expect(plan.unknownTmpRoots).toEqual(["rogue-dir"]);
  });

  it("reclaims legacy tmp-root supervisor slot logs on the logs TTL", () => {
    const oldSlotLog = entry("/red/tmp/afk-supervisor-slot-0.log", LOGS_TTL_S + 1);
    const freshSlotLog = entry("/red/tmp/afk-supervisor-slot-1.log", LOGS_TTL_S - 1);

    const plan = planTmpJanitor({
      nowS: NOW,
      logEntries: [],
      scratchEntries: [],
      diagnosticsEntries: [],
      feedbackEntries: [],
      legacySlotLogEntries: [oldSlotLog, freshSlotLog],
      tmpRootNames: ["afk-supervisor-slot-0.log", "afk-supervisor-slot-1.log", "debug.log"],
    });

    expect(plan.legacySlotLogs.reclaim).toEqual([oldSlotLog]);
    expect(plan.legacySlotLogs.spare).toEqual([freshSlotLog]);
    expect(plan.unknownTmpRoots).toEqual(["debug.log"]);
  });

  it("does not reclaim entries in unmanaged lanes (workers, claims, waits, worktrees)", () => {
    // The janitor only acts on its four lanes. Known lanes at the tmp root
    // do not produce unknownTmpRoots entries even though their contents
    // are outside this sweep's scope.
    const plan = planTmpJanitor({
      nowS: NOW,
      logEntries: [],
      scratchEntries: [],
      diagnosticsEntries: [],
      feedbackEntries: [],
      legacySlotLogEntries: [],
      tmpRootNames: ["workers", "go-workers", "claims", "waits", "worktrees"],
    });
    expect(plan.unknownTmpRoots).toEqual([]);
  });
});

describe("planWorkerDirJanitor", () => {
  function worker(over: Partial<WorkerDirJanitorEntry>): WorkerDirJanitorEntry {
    return {
      path: "/red/tmp/workers/w1",
      workerPidLive: false,
      issues: [{ issue: 1, state: "CLOSED" }],
      ...over,
    };
  }

  it("reclaims dead worker dirs when every represented issue is closed", () => {
    const entry = worker({ issues: [{ issue: 10, state: "CLOSED" }, { issue: 11, state: "CLOSED" }] });
    expect(planWorkerDirJanitor([entry])).toEqual({ reclaim: [entry], spare: [] });
  });

  it("spares worker dirs with a live worker.pid", () => {
    const entry = worker({ workerPidLive: true });
    expect(planWorkerDirJanitor([entry])).toEqual({ reclaim: [], spare: [entry] });
  });

  it("spares worker dirs with open or unknown issues", () => {
    const open = worker({ path: "/red/tmp/workers/w-open", issues: [{ issue: 1, state: "OPEN" }] });
    const unknown = worker({ path: "/red/tmp/workers/w-unknown", issues: [{ issue: 2, state: "UNKNOWN" }] });
    expect(planWorkerDirJanitor([open, unknown])).toEqual({ reclaim: [], spare: [open, unknown] });
  });

  it("spares dead worker dirs with no issue-bearing attempts", () => {
    const entry = worker({ issues: [] });
    expect(planWorkerDirJanitor([entry])).toEqual({ reclaim: [], spare: [entry] });
  });
});

// ---------- parseFeedbackWorktreeWorkerSlug ----------

describe("parseFeedbackWorktreeWorkerSlug", () => {
  it("extracts the worker ID from a canonical AFK feedback worktree slug", () => {
    expect(parseFeedbackWorktreeWorkerSlug("afk-wOF09-2379-tmp-janitor-fix")).toBe("wOF09");
  });

  it("extracts the worker ID from a minimal valid slug", () => {
    expect(parseFeedbackWorktreeWorkerSlug("afk-w1-42-fix")).toBe("w1");
  });

  it("extracts the worker ID when the slug has uppercase letters", () => {
    expect(parseFeedbackWorktreeWorkerSlug("afk-W5LB-1234-some-slug")).toBe("W5LB");
  });

  it("returns null for the trunk/baseline worktree (no 'afk-' prefix)", () => {
    expect(parseFeedbackWorktreeWorkerSlug("main")).toBeNull();
  });

  it("returns null for a feature branch slug without an issue number", () => {
    // 'afk-worker' lacks the '<issueN>-' part
    expect(parseFeedbackWorktreeWorkerSlug("afk-worker")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseFeedbackWorktreeWorkerSlug("")).toBeNull();
  });

  it("returns null for a non-AFK slug", () => {
    expect(parseFeedbackWorktreeWorkerSlug("feature-123-fix")).toBeNull();
  });
});

// ---------- planOrphanFeedbackWorktreeSweep ----------

describe("planOrphanFeedbackWorktreeSweep", () => {
  function fbEntry(basename: string, ownerAlive: boolean | null): OrphanFeedbackEntry {
    return { path: `/red/tmp/worktrees/feedback/${basename}`, basename, mtimeS: NOW, ownerAlive };
  }

  it("returns empty plans for an empty entry list", () => {
    expect(planOrphanFeedbackWorktreeSweep([], false)).toEqual({ reclaim: [], spare: [] });
  });

  it("reclaims an AFK worker entry whose owning worker is dead (ownerAlive: false)", () => {
    const dead = fbEntry("afk-wOF09-2379-fix", false);
    expect(planOrphanFeedbackWorktreeSweep([dead], false)).toEqual({ reclaim: [dead], spare: [] });
  });

  it("spares an AFK worker entry whose owning worker is still alive (ownerAlive: true)", () => {
    const live = fbEntry("afk-wP5LB-2379-fix", true);
    expect(planOrphanFeedbackWorktreeSweep([live], true)).toEqual({ reclaim: [], spare: [live] });
  });

  it("reclaims a non-worker entry (e.g. main) when no workers are alive", () => {
    const main = fbEntry("main", null);
    expect(planOrphanFeedbackWorktreeSweep([main], false)).toEqual({ reclaim: [main], spare: [] });
  });

  it("spares a non-worker entry (e.g. main) when at least one worker is alive", () => {
    const main = fbEntry("main", null);
    expect(planOrphanFeedbackWorktreeSweep([main], true)).toEqual({ reclaim: [], spare: [main] });
  });

  it("partitions a mixed set: dead-owner reclaimed, live-owner spared, main reclaimed when no workers", () => {
    const dead = fbEntry("afk-wOLD-1-fix", false);
    const live = fbEntry("afk-wNEW-2-fix", true);
    const main = fbEntry("main", null);
    // anyWorkerAlive = true because wNEW is alive
    const plan = planOrphanFeedbackWorktreeSweep([dead, live, main], true);
    expect(plan.reclaim).toEqual([dead]);
    expect(plan.spare).toEqual([live, main]);
  });

  it("reclaims main alongside dead-owner entries when no workers alive at all", () => {
    const dead = fbEntry("afk-wOLD-1-fix", false);
    const main = fbEntry("main", null);
    const plan = planOrphanFeedbackWorktreeSweep([dead, main], false);
    expect(plan.reclaim).toEqual([dead, main]);
    expect(plan.spare).toEqual([]);
  });

  it("spares a live-owner entry even when anyWorkerAlive is false (ownerAlive: true wins)", () => {
    // Should not happen in practice, but the rule is clear: ownerAlive: true → spare.
    const live = fbEntry("afk-wABC-10-fix", true);
    expect(planOrphanFeedbackWorktreeSweep([live], false)).toEqual({ reclaim: [], spare: [live] });
  });
});
