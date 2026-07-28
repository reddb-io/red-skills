// attempt-retention.test.ts — the reclaim rule keyed on the attempt record
// (ADR 0128, issue #2705).
//
// Every case below states the same rule from a different angle: THE RECORD
// DECIDES. No test here supplies a pid, a pid file, or an mtime, because none
// of them is an input — keying on pid-file absence is what deleted the live
// supervisor's lane while the dead ones survived (#2679).

import { describe, expect, it } from "vitest";
import {
  CASTLE_RECLAIM_LIMIT_REASON,
  castleAttemptIsLive,
  castleRetentionTier,
  classifyCastleArtifact,
  planCastleReclaim,
  type CastleReclaimPlan,
} from "./attempt-retention.js";
import { foldCastleAttemptRecords } from "./attempt-record.js";
import {
  CASTLE_ATTEMPT_SCHEMA_ID,
  type CastleAttemptArtifact,
  type CastleAttemptEntry,
  type CastleAttemptOutcome,
  type CastleAttemptRecord,
} from "./contracts/index.js";

const NOW = "2026-07-28T18:00:00.000Z";

let clock = 0;

/** One narrative line, with only the fields a retention case cares about. */
function entry(over: Partial<CastleAttemptEntry>): CastleAttemptEntry {
  clock += 1;
  return {
    schema: CASTLE_ATTEMPT_SCHEMA_ID,
    attempt_id: "wA:2705:1",
    worker_id: "wA",
    issue: 2705,
    try: 1,
    at: `2026-07-28T17:00:${String(clock).padStart(2, "0")}.000Z`,
    event: "attempt.artifact",
    writer: "resident",
    ...over,
  };
}

interface AttemptShape {
  attempt_id?: string;
  worker_id?: string;
  issue?: number;
  branch?: string;
  pr?: number;
  commits?: readonly string[];
  outcome?: CastleAttemptOutcome;
  artifacts?: readonly CastleAttemptArtifact[];
}

/** Build a record the way the resident does — by folding the lane it wrote. */
function record(shape: AttemptShape = {}): CastleAttemptRecord {
  const identity = {
    attempt_id: shape.attempt_id ?? "wA:2705:1",
    worker_id: shape.worker_id ?? "wA",
    issue: shape.issue ?? 2705,
  };
  const entries: CastleAttemptEntry[] = [
    entry({ ...identity, event: "attempt.claimed", claim: { state: "claimed" } }),
  ];
  if (shape.branch) {
    entries.push(entry({ ...identity, event: "attempt.progressed", branch: shape.branch }));
  }
  for (const commit of shape.commits ?? []) {
    entries.push(entry({ ...identity, event: "attempt.committed", commit }));
  }
  if (shape.pr !== undefined) {
    entries.push(entry({ ...identity, event: "attempt.pr-opened", pr: shape.pr }));
  }
  for (const artifact of shape.artifacts ?? []) {
    entries.push(entry({ ...identity, event: "attempt.artifact", artifact }));
  }
  if (shape.outcome) {
    entries.push(entry({ ...identity, event: "attempt.closed", outcome: shape.outcome }));
  }
  return foldCastleAttemptRecords(entries)[0]!;
}

const worktree: CastleAttemptArtifact = {
  kind: "worktree",
  path: "/red/tmp/workers/wA/2705/worktree",
  reclaimable: true,
};
const nodeModules: CastleAttemptArtifact = {
  kind: "node_modules",
  path: "/red/tmp/workers/wA/2705/worktree/node_modules",
  reclaimable: true,
};
const log: CastleAttemptArtifact = {
  kind: "log",
  path: "/red/tmp/workers/wA/2705/worker.log.toonl",
  reclaimable: false,
};

/** Nothing may vanish between the input and the plan. */
function expectFullAccounting(plan: CastleReclaimPlan, considered: number): void {
  expect(plan.totals).toEqual({
    considered,
    reclaim: plan.reclaim.length,
    retain: plan.retain.length,
    dropped: plan.dropped.length,
  });
  expect(plan.reclaim.length + plan.retain.length + plan.dropped.length).toBe(considered);
}

function paths(verdicts: readonly { artifact: CastleAttemptArtifact }[]): (string | undefined)[] {
  return verdicts.map((verdict) => verdict.artifact.path);
}

// ---------- the liveness anchor ----------

describe("castleAttemptIsLive", () => {
  it("reads liveness off the record's terminal outcome, the single anchor", () => {
    expect(castleAttemptIsLive(record())).toBe(true);
    expect(castleAttemptIsLive(record({ outcome: { kind: "done" } }))).toBe(false);
  });
});

describe("castleRetentionTier", () => {
  it("maps an open record to the live tier", () => {
    expect(castleRetentionTier(record())).toBe("live");
  });

  it("maps a successful landing to the landed tier", () => {
    expect(castleRetentionTier(record({ outcome: { kind: "done" } }))).toBe("landed");
  });

  it("maps every non-landing terminal outcome to the failed tier", () => {
    for (const kind of ["blocked", "killed", "budget-exceeded", "runner-exploded"]) {
      expect(castleRetentionTier(record({ outcome: { kind } }))).toBe("failed");
    }
  });

  it("maps an explicit discard to the discarded tier", () => {
    expect(castleRetentionTier(record({ outcome: { kind: "discarded" } }))).toBe("discarded");
  });
});

describe("classifyCastleArtifact", () => {
  it("separates the expensive workspace from cheap evidence and pointers", () => {
    expect(classifyCastleArtifact("worktree")).toBe("workspace");
    expect(classifyCastleArtifact("node_modules")).toBe("workspace");
    expect(classifyCastleArtifact("log")).toBe("evidence");
    expect(classifyCastleArtifact("branch")).toBe("pointer");
  });

  it("refuses to guess at an unrecognised kind", () => {
    expect(classifyCastleArtifact("something-new")).toBe("unknown");
  });
});

// ---------- the retention contract ----------

describe("planCastleReclaim — a live attempt", () => {
  it("never reclaims an artifact of a live attempt, whatever the artifact claims", () => {
    // `reclaimable: true` on both artifacts, and no pid file anywhere: the
    // record is open, so nothing it owns is reclaimable.
    const plan = planCastleReclaim([record({ artifacts: [worktree, nodeModules] })], {
      nowIso: NOW,
    });
    expect(plan.reclaim).toEqual([]);
    expect(plan.retain.map((verdict) => verdict.verdict)).toEqual([
      "attempt-live",
      "attempt-live",
    ]);
    expect(plan.attempts[0]?.tier).toBe("live");
    expectFullAccounting(plan, 2);
  });
});

describe("planCastleReclaim — a retry on the same workspace", () => {
  it("never reclaims a path a live attempt owns, whatever an older try's outcome says", () => {
    // A retry is a fresh attempt on the SAME path (ADR 0103). Reading try 1's
    // closed record on its own would hand the running try's bytes to the
    // janitor — liveness has to win at path granularity, not just per record.
    const plan = planCastleReclaim(
      [
        record({ attempt_id: "wA:2705:1", artifacts: [worktree], outcome: { kind: "blocked" } }),
        record({ attempt_id: "wA:2705:2", artifacts: [worktree] }),
      ],
      { nowIso: NOW },
    );
    expect(plan.reclaim).toEqual([]);
    expect(plan.retain.map((verdict) => verdict.verdict)).toEqual([
      "attempt-live",
      "attempt-live",
    ]);
    expect(plan.retain[0]?.reason).toMatch(/a live attempt owns this path/);
    expectFullAccounting(plan, 2);
  });
});

describe("planCastleReclaim — a landed attempt", () => {
  const landed = record({
    branch: "afk/2705-retention",
    pr: 2711,
    commits: ["abc1234"],
    artifacts: [worktree, nodeModules, log],
    outcome: { kind: "done", detail: "landed on main" },
  });

  it("makes the workspace reclaimable", () => {
    const plan = planCastleReclaim([landed], { nowIso: NOW });
    expect(paths(plan.reclaim)).toContain(worktree.path);
    expect(paths(plan.reclaim)).toContain(nodeModules.path);
    expect(
      plan.reclaim.filter((verdict) => verdict.class === "workspace").map((v) => v.verdict),
    ).toEqual(["workspace-reclaimable", "workspace-reclaimable"]);
    expectFullAccounting(plan, 3);
  });

  it("retains the record: its pointers and its outcome survive the reclaim", () => {
    const plan = planCastleReclaim([landed], { nowIso: NOW });
    expect(plan.attempts[0]).toMatchObject({
      attempt_id: "wA:2705:1",
      tier: "landed",
      outcome: "done",
      pointers: { branch: "afk/2705-retention", pr: 2711, commits: ["abc1234"] },
    });
  });
});

describe("planCastleReclaim — a failed attempt", () => {
  const failed = record({
    branch: "afk/2705-retention",
    pr: 2711,
    commits: ["abc1234"],
    artifacts: [worktree, { ...log, reclaimable: true }],
    outcome: { kind: "budget-exceeded", budget: "wall-clock 2700s" },
  });

  it("retains the branch and PR pointers the rescue needs", () => {
    const plan = planCastleReclaim([failed], { nowIso: NOW });
    expect(plan.attempts[0]?.pointers).toEqual({
      branch: "afk/2705-retention",
      pr: 2711,
      commits: ["abc1234"],
    });
  });

  it("retains cheap evidence even when the artifact says it is reclaimable", () => {
    const plan = planCastleReclaim([failed], { nowIso: NOW });
    const evidence = plan.retain.find((verdict) => verdict.class === "evidence");
    expect(evidence?.verdict).toBe("evidence-retained");
    expect(paths(plan.reclaim)).not.toContain(log.path);
  });

  it("names the expensive part it reclaims instead of reclaiming silently", () => {
    const plan = planCastleReclaim([failed], { nowIso: NOW });
    expect(plan.reclaim).toHaveLength(1);
    expect(plan.reclaim[0]).toMatchObject({
      class: "workspace",
      verdict: "workspace-reclaimable",
      reclaim: true,
    });
    expect(plan.reclaim[0]?.reason).toMatch(/failed/);
    expectFullAccounting(plan, 2);
  });
});

describe("planCastleReclaim — explicit verdicts inside a tier", () => {
  it("pins an artifact the record forbids reclaiming", () => {
    const plan = planCastleReclaim(
      [
        record({
          artifacts: [{ ...worktree, reclaimable: false, reason: "held for the post-mortem" }],
          outcome: { kind: "done" },
        }),
      ],
      { nowIso: NOW },
    );
    expect(plan.reclaim).toEqual([]);
    expect(plan.retain[0]?.verdict).toBe("record-forbids");
  });

  it("holds an artifact until its reclaim_after grace has passed", () => {
    const held = { ...worktree, reclaim_after: "2026-07-28T19:00:00.000Z" };
    const before = planCastleReclaim([record({ artifacts: [held], outcome: { kind: "done" } })], {
      nowIso: NOW,
    });
    expect(before.retain[0]?.verdict).toBe("grace-period");

    const after = planCastleReclaim([record({ artifacts: [held], outcome: { kind: "done" } })], {
      nowIso: "2026-07-28T19:00:01.000Z",
    });
    expect(after.reclaim[0]?.verdict).toBe("workspace-reclaimable");
  });

  it("retains a pointer artifact: a branch has no bytes to reclaim", () => {
    const plan = planCastleReclaim(
      [
        record({
          artifacts: [{ kind: "branch", ref: "afk/2705", reclaimable: true }],
          outcome: { kind: "done" },
        }),
      ],
      { nowIso: NOW },
    );
    expect(plan.reclaim).toEqual([]);
    expect(plan.retain[0]?.verdict).toBe("pointer-retained");
  });

  it("retains an artifact it cannot classify rather than guessing", () => {
    const plan = planCastleReclaim(
      [
        record({
          artifacts: [{ kind: "sandbox-image", path: "/red/tmp/x", reclaimable: true }],
          outcome: { kind: "done" },
        }),
      ],
      { nowIso: NOW },
    );
    expect(plan.reclaim).toEqual([]);
    expect(plan.retain[0]).toMatchObject({ class: "unknown", verdict: "unclassified" });
  });
});

// ---------- the planner reports what it dropped ----------

describe("planCastleReclaim — no silent truncation", () => {
  const landedWith = (n: number) =>
    record({
      artifacts: Array.from({ length: n }, (_, index) => ({
        kind: "worktree",
        path: `/red/tmp/workers/wA/2705/worktree-${index}`,
        reclaimable: true,
      })),
      outcome: { kind: "done" },
    });

  it("reports every artifact a reclaim limit held back", () => {
    const plan = planCastleReclaim([landedWith(3)], { nowIso: NOW, limit: 1 });
    expect(plan.reclaim).toHaveLength(1);
    expect(plan.truncated).toBe(true);
    expect(plan.dropped).toHaveLength(2);
    expect(plan.dropped.map((drop) => drop.reason)).toEqual([
      CASTLE_RECLAIM_LIMIT_REASON,
      CASTLE_RECLAIM_LIMIT_REASON,
    ]);
    expect(plan.dropped.map((drop) => drop.path)).toEqual([
      "/red/tmp/workers/wA/2705/worktree-1",
      "/red/tmp/workers/wA/2705/worktree-2",
    ]);
    expectFullAccounting(plan, 3);
  });

  it("leaves truncated false and dropped empty when nothing was held back", () => {
    const plan = planCastleReclaim([landedWith(3)], { nowIso: NOW });
    expect(plan.truncated).toBe(false);
    expect(plan.dropped).toEqual([]);
    expectFullAccounting(plan, 3);
  });

  it("reports an observed path no attempt record accounts for, and never reclaims it", () => {
    const plan = planCastleReclaim([record({ artifacts: [worktree], outcome: { kind: "done" } })], {
      nowIso: NOW,
      observedPaths: [worktree.path!, "/red/tmp/workers/wGONE/1234/worktree"],
    });
    expect(paths(plan.reclaim)).toEqual([worktree.path]);
    expect(plan.dropped).toEqual([
      {
        reason: "no-record",
        path: "/red/tmp/workers/wGONE/1234/worktree",
        detail: "no attempt record accounts for this path; the janitor leaves it alone",
      },
    ]);
    expectFullAccounting(plan, 2);
  });
});

describe("planCastleReclaim — many attempts", () => {
  it("plans each attempt separately and keeps the flattened view in step", () => {
    const plan = planCastleReclaim(
      [
        record({ attempt_id: "wA:2705:1", artifacts: [worktree] }),
        record({
          attempt_id: "wB:2706:1",
          worker_id: "wB",
          issue: 2706,
          artifacts: [{ ...worktree, path: "/red/tmp/workers/wB/2706/worktree" }],
          outcome: { kind: "done" },
        }),
      ],
      { nowIso: NOW },
    );
    expect(plan.attempts.map((attempt) => attempt.tier)).toEqual(["live", "landed"]);
    expect(plan.reclaim).toHaveLength(1);
    expect(plan.reclaim[0]?.attempt_id).toBe("wB:2706:1");
    expect(plan.attempts[1]?.reclaim).toEqual(plan.reclaim);
    expectFullAccounting(plan, 2);
  });
});
