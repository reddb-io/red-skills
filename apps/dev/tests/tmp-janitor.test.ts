import { describe, expect, it } from "vitest";
import {
  auditTmpRoot,
  DIAGNOSTICS_TTL_S,
  FEEDBACK_TTL_S,
  KNOWN_TMP_LANES,
  parseFeedbackWorktreeWorkerSlug,
  planDiagnosticsJanitor,
  planFeedbackWorktreeJanitor,
  planOrphanFeedbackWorktreeSweep,
  planScratchJanitor,
  planSupervisorLaneJanitor,
  planTmpJanitor,
  planWorkerDirJanitor,
  removableUnknownTmpRoots,
  SCRATCH_TTL_S,
  supervisorLaneIsLive,
  type JanitorEntry,
  type OrphanFeedbackEntry,
  type SupervisorLaneEntry,
  type WorkerDirJanitorEntry,
} from "../src/core/tmp-janitor.js";

const NOW = 1_000_000_000;

function entry(path: string, ageS: number): JanitorEntry {
  return { path, mtimeS: NOW - ageS };
}

// ---------- planLogsJanitor ----------

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

  it("flags a stray supervisor slot log now that the logs lane is retired", () => {
    // Reported, never deleted: the lane that owned these files is gone, so a
    // leftover at the tmp root is exactly what the unknown-roots audit is for.
    expect(auditTmpRoot(["afk-supervisor-slot-0.log", "debug.log"]).unknown)
      .toEqual(["afk-supervisor-slot-0.log", "debug.log"]);
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

describe("planWorkerDirJanitor", () => {
  function worker(over: Partial<WorkerDirJanitorEntry>): WorkerDirJanitorEntry {
    return {
      path: "/red/tmp/workers/w1",
      mtimeS: NOW,
      liveness: "dead",
      issues: [{ issue: 1, state: "CLOSED" }],
      ...over,
    };
  }

  it("reclaims dead worker dirs when every represented issue is closed", () => {
    const entry = worker({ issues: [{ issue: 10, state: "CLOSED" }, { issue: 11, state: "CLOSED" }] });
    expect(planWorkerDirJanitor([entry], NOW)).toEqual({ reclaim: [entry], spare: [] });
  });

  it("spares worker dirs the daemon calls alive", () => {
    const entry = worker({ liveness: "alive" });
    expect(planWorkerDirJanitor([entry], NOW)).toEqual({ reclaim: [], spare: [entry] });
  });

  it("spares a worker dir the daemon could not answer for, closed issues and all", () => {
    // The pid-keyed predecessor read a missing pid file as death and reclaimed
    // exactly this dir. An unreachable authority is not evidence (#2679).
    const entry = worker({ liveness: "unknown" });
    expect(planWorkerDirJanitor([entry], NOW)).toEqual({ reclaim: [], spare: [entry] });
  });

  it("spares worker dirs with open or unknown issues", () => {
    const open = worker({ path: "/red/tmp/workers/w-open", issues: [{ issue: 1, state: "OPEN" }] });
    const unknown = worker({ path: "/red/tmp/workers/w-unknown", issues: [{ issue: 2, state: "UNKNOWN" }] });
    expect(planWorkerDirJanitor([open, unknown], NOW)).toEqual({ reclaim: [], spare: [open, unknown] });
  });

  it("spares dead worker dirs with no issue-bearing attempts", () => {
    const entry = worker({ issues: [] });
    expect(planWorkerDirJanitor([entry], NOW)).toEqual({ reclaim: [], spare: [entry] });
  });

  it("reclaims a dead worker dir whose every issue is closed", () => {
    const entry = worker({ issues: [{ issue: 1, state: "CLOSED" }] });
    expect(planWorkerDirJanitor([entry], NOW)).toEqual({ reclaim: [entry], spare: [] });
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

// ---------- planSupervisorLaneJanitor (#2679) ----------

describe("planSupervisorLaneJanitor", () => {
  function lane(over: Partial<SupervisorLaneEntry> = {}): SupervisorLaneEntry {
    return { path: "/red/tmp/supervisors/default", fleet: "default", pidAlive: false, ...over };
  }

  it("spares a fleet dir whose pid file names a live process", () => {
    const live = lane({ pidAlive: true });
    expect(planSupervisorLaneJanitor([live])).toEqual({ reclaim: [], spare: [live] });
  });

  it("spares a fleet dir whose state snapshot names a live pid and has no pid file", () => {
    const live = lane({ pidAlive: false, statePidAlive: true });
    expect(planSupervisorLaneJanitor([live])).toEqual({ reclaim: [], spare: [live] });
  });

  it("spares a fleet dir whose s<pid> log dir names a live pid and has no pid file", () => {
    const live = lane({ pidAlive: false, snapshotPidAlive: true });
    expect(planSupervisorLaneJanitor([live])).toEqual({ reclaim: [], spare: [live] });
  });

  it("reclaims a fleet dir whose every anchor is dead", () => {
    const dead = lane({ pidAlive: false, statePidAlive: false, snapshotPidAlive: false });
    expect(planSupervisorLaneJanitor([dead])).toEqual({ reclaim: [dead], spare: [] });
  });

  it("supervisorLaneIsLive is true when any single anchor is live", () => {
    expect(supervisorLaneIsLive(lane({ pidAlive: true }))).toBe(true);
    expect(supervisorLaneIsLive(lane({ statePidAlive: true }))).toBe(true);
    expect(supervisorLaneIsLive(lane({ snapshotPidAlive: true }))).toBe(true);
    expect(supervisorLaneIsLive(lane())).toBe(false);
  });
});

// ---------- removableUnknownTmpRoots (#2679) ----------

describe("removableUnknownTmpRoots", () => {
  it("never returns an entry named in KNOWN_TMP_LANES", () => {
    const lanes = [...KNOWN_TMP_LANES];
    expect(removableUnknownTmpRoots(lanes)).toEqual([]);
  });

  it("still returns genuinely unknown names", () => {
    expect(removableUnknownTmpRoots(["supervisors", "work-old", "workers"])).toEqual(["work-old"]);
  });
});
