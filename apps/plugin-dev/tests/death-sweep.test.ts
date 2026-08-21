import { describe, expect, it } from "vitest";

import {
  DEATH_SWEEP_EVENT_KINDS,
  MEMORY_BUMP_FACTOR,
  MEMORY_BUMP_GRANULARITY_BYTES,
  deathEvidenceIn,
  deathVerdictIsActionable,
  escalateAfkModelTier,
  executeDeathSweep,
  hardDeathOutcome,
  planDeathSweep,
  planHardDeathRemedy,
  parseByteQuantity,
  planMemoryBump,
  renderDeathEvidence,
  renderDeathSweepAudit,
  runDeathSweep,
  type DeathSweepIO,
  type DeathSweepPort,
  type DeathSweepStep,
  type WorkerDeathEvidence,
} from "../src/core/death-sweep.js";
import type { ClaimedIssue } from "../src/core/claim-staleness.js";
import type { HistoryClock, HistoryRecord } from "../src/core/history.js";

const HOST = "host-abc:";
const WORKER_ID = "w-4136";
const OWNER = `${HOST}${WORKER_ID}`;
const CLOCK: HistoryClock = { ts: "2026-08-21T10:00:00.000Z", epoch: 1_787_048_400 };

const GIB = 1024 ** 3;

function oomDeath(overrides: Partial<WorkerDeathEvidence> = {}): WorkerDeathEvidence {
  return {
    worker_id: WORKER_ID,
    kind: "worker-death",
    ts: CLOCK.ts,
    sender_class: "oomd",
    confidence: "high",
    exit_code: null,
    signal: "SIGKILL",
    memory_peak_bytes: 4 * GIB,
    detail: "systemd result=oom-kill; memory peak=4.00 GiB",
    ...overrides,
  };
}

function claimedBy(worker: string, issue = 4136, kind: "claim" | "concede" = "claim"): ClaimedIssue {
  return {
    issue,
    records: [{ commentId: 10, worker, kind, createdAt: "2026-08-21T09:30:00.000Z" }],
  };
}

function terminalRows(issue: number, count: number): HistoryRecord[] {
  return Array.from({ length: count }, (_row, index) => ({
    ts: CLOCK.ts,
    epoch: CLOCK.epoch - index,
    worker: OWNER,
    issue,
    event: "blocked",
    duration_s: 0,
    runner: "claude",
  }));
}

interface RecordedIO extends DeathSweepIO {
  readonly calls: string[];
  readonly history: DeathSweepStep[];
}

function recordingIO(overrides: Partial<DeathSweepIO> = {}): RecordedIO {
  const calls: string[] = [];
  const history: DeathSweepStep[] = [];
  return {
    calls,
    history,
    async concede(issue, owner) {
      calls.push(`concede:${issue}:${owner}`);
    },
    async appendHistory(step) {
      calls.push(`history:${step.issue}:${step.historyEvent}:${step.historyReason}`);
      history.push(step);
    },
    async editLabels(issue, remove, add) {
      calls.push(`labels:${issue}:-${[...remove].join("+")}:+${[...add].join("+")}`);
    },
    async comment(issue) {
      calls.push(`comment:${issue}`);
    },
    ...overrides,
  };
}

describe("deathEvidenceIn — the lane is a history, not an inbox", () => {
  it("keeps the latest death per worker id", () => {
    const first = oomDeath({ detail: "first" });
    const second = oomDeath({ detail: "second" });

    expect(deathEvidenceIn([first, second]).map((death) => death.detail)).toEqual(["second"]);
  });

  it("lets a re-birth cancel a pending death, so a living Worker is never robbed", () => {
    const events: WorkerDeathEvidence[] = [
      oomDeath(),
      { worker_id: WORKER_ID, kind: "worker-birth" },
    ];

    expect(deathEvidenceIn(events)).toEqual([]);
  });

  it("reads both the `kind` and the `event` spelling, and ignores every other kind", () => {
    const events: WorkerDeathEvidence[] = [
      { worker_id: "w-1", event: "worker-budget-kill", sender_class: "teardown" },
      { worker_id: "w-2", kind: "worker-heartbeat" },
      { worker_id: "", kind: "worker-death" },
    ];

    expect(deathEvidenceIn(events).map((death) => death.worker_id)).toEqual(["w-1"]);
    expect(DEATH_SWEEP_EVENT_KINDS).toContain("worker-budget-kill");
  });
});

describe("deathVerdictIsActionable — a claim is never spent on a guess", () => {
  it("acts on a named sender the receipt proved", () => {
    expect(deathVerdictIsActionable(oomDeath())).toBeNull();
    expect(
      deathVerdictIsActionable(oomDeath({ sender_class: "user-signal", confidence: "medium" })),
    ).toBeNull();
  });

  it("defers an unattributed SIGKILL to the staleness clock", () => {
    expect(
      deathVerdictIsActionable(oomDeath({ sender_class: "unknown", confidence: "low" })),
    ).toBe("no-named-sender");
    expect(deathVerdictIsActionable(oomDeath({ sender_class: null, confidence: null }))).toBe(
      "no-named-sender",
    );
  });

  it("defers a named sender the evidence could only infer", () => {
    expect(deathVerdictIsActionable(oomDeath({ confidence: "low" }))).toBe("low-confidence");
    expect(deathVerdictIsActionable(oomDeath({ confidence: null }))).toBe("low-confidence");
  });
});

describe("the vocabulary is the one that already exists", () => {
  it("reads every hard death as the `signal-killed` outcome, inventing no sixth class", () => {
    expect(hardDeathOutcome("oomd")).toBe("signal-killed");
    expect(hardDeathOutcome("teardown")).toBe("signal-killed");
  });
});

describe("planMemoryBump — anchored on what the kernel measured", () => {
  it("raises the ceiling above the observed peak, rounded to the granularity", () => {
    const bump = planMemoryBump({ peakBytes: 4 * GIB, ceilingBytes: 4 * GIB });

    expect(bump).toBe(
      Math.ceil((4 * GIB * MEMORY_BUMP_FACTOR) / MEMORY_BUMP_GRANULARITY_BYTES) *
        MEMORY_BUMP_GRANULARITY_BYTES,
    );
    expect(bump! % MEMORY_BUMP_GRANULARITY_BYTES).toBe(0);
    expect(bump!).toBeGreaterThan(4 * GIB);
  });

  it("answers null when the receipt measured nothing to anchor on", () => {
    expect(planMemoryBump({ peakBytes: null, ceilingBytes: null })).toBeNull();
    expect(planMemoryBump({ peakBytes: 0, ceilingBytes: 0 })).toBeNull();
  });

  it("answers null when the host ceiling refuses the bump", () => {
    expect(planMemoryBump({ peakBytes: 4 * GIB, hostCeilingBytes: 5 * GIB })).toBeNull();
  });

  it("anchors on the higher of the peak and the ceiling, so the bump always clears the placement that died", () => {
    const bump = planMemoryBump({ peakBytes: GIB, ceilingBytes: 64 * GIB });

    expect(bump).toBeGreaterThan(64 * GIB);
  });
});

describe("parseByteQuantity — the ceiling is a systemd string, not a number", () => {
  it("reads the suffixes systemd writes", () => {
    expect(parseByteQuantity("8G")).toBe(8 * GIB);
    expect(parseByteQuantity("16Gi")).toBe(16 * GIB);
    expect(parseByteQuantity("512M")).toBe(512 * 1024 ** 2);
    expect(parseByteQuantity("1024")).toBe(1024);
    expect(parseByteQuantity(4 * GIB)).toBe(4 * GIB);
  });

  it("refuses a ceiling that names no number of bytes", () => {
    for (const value of ["70%", "infinity", "", "  ", "8Q", null, undefined]) {
      expect(parseByteQuantity(value)).toBeNull();
    }
  });

  it("keeps a suffixed ceiling from planning a bump that is really a reduction", () => {
    const plan = planDeathSweep({
      deaths: [oomDeath({ memory_max: "16G", memory_peak_bytes: 4 * GIB })],
      claimed: [claimedBy(OWNER)],
      history: [],
      hostPrefix: HOST,
      env: { RED_AFK_RETRY_CRASH: "3" },
    });

    expect(plan.steps[0]!.remedy.memoryBumpBytes).toBeGreaterThan(16 * GIB);
  });
});

describe("escalateAfkModelTier — one step up, and null at the ceiling", () => {
  it("climbs the declared ladder", () => {
    expect(escalateAfkModelTier("validate")).toBe("simple");
    expect(escalateAfkModelTier("simple")).toBe("complex");
    expect(escalateAfkModelTier("complex")).toBe("think");
  });

  it("says null rather than returning itself at the top", () => {
    expect(escalateAfkModelTier("think")).toBeNull();
  });
});

describe("planHardDeathRemedy — only a memory kill earns a different placement", () => {
  it("bumps the ceiling for an OOM the receipt measured", () => {
    const remedy = planHardDeathRemedy({ senderClass: "oomd", peakBytes: 4 * GIB });

    expect(remedy.remedy).toBe("memory-bump");
    expect(remedy.memoryBumpBytes).toBeGreaterThan(4 * GIB);
    expect(remedy.note).toContain("memory ceiling raised");
  });

  it("escalates the tier for an OOM with no memory headroom left", () => {
    const remedy = planHardDeathRemedy({
      senderClass: "oomd",
      peakBytes: 4 * GIB,
      hostCeilingBytes: 5 * GIB,
      tier: "simple",
    });

    expect(remedy.remedy).toBe("tier-escalation");
    expect(remedy.escalatedTier).toBe("complex");
    expect(remedy.memoryBumpBytes).toBeNull();
  });

  it("falls back to a plain requeue when neither remedy is available", () => {
    const remedy = planHardDeathRemedy({
      senderClass: "oomd",
      peakBytes: 4 * GIB,
      hostCeilingBytes: 5 * GIB,
      tier: "think",
    });

    expect(remedy.remedy).toBe("plain");
  });

  it("never bumps on a requested stop or a host teardown", () => {
    for (const sender of ["user-signal", "teardown", "parent-death", "boot-refused"] as const) {
      const remedy = planHardDeathRemedy({ senderClass: sender, peakBytes: 4 * GIB });
      expect(remedy.remedy).toBe("plain");
      expect(remedy.memoryBumpBytes).toBeNull();
    }
  });
});

describe("renderDeathEvidence — the receipt, in one line", () => {
  it("names the sender, the confidence, the signal and the peak", () => {
    const line = renderDeathEvidence(oomDeath());

    expect(line).toContain("sender=oomd/high");
    expect(line).toContain("signal=SIGKILL");
    expect(line).toContain("memory peak=4.00 GiB");
  });

  it("falls back to the exit code when no signal ended it", () => {
    const line = renderDeathEvidence(
      oomDeath({ signal: null, exit_code: 78, memory_peak_bytes: null, detail: null }),
    );

    expect(line).toContain("exit code=78");
    expect(line).not.toContain("memory peak");
  });
});

describe("planDeathSweep — the join only the checkout can perform", () => {
  it("joins worker id to the claim marker that carries the host prefix", () => {
    const plan = planDeathSweep({
      deaths: [oomDeath()],
      claimed: [claimedBy(OWNER)],
      history: [],
      hostPrefix: HOST,
      env: {},
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.issue).toBe(4136);
    expect(plan.steps[0]!.claimOwner).toBe(OWNER);
    expect(plan.steps[0]!.workerId).toBe(WORKER_ID);
  });

  it("defers a death whose Worker holds no claim here", () => {
    const plan = planDeathSweep({
      deaths: [oomDeath()],
      claimed: [claimedBy("other-host:w-999")],
      history: [],
      hostPrefix: HOST,
      env: {},
    });

    expect(plan.steps).toEqual([]);
    expect(plan.deferred).toEqual([
      { workerId: WORKER_ID, reason: "no-claim", evidence: oomDeath() },
    ]);
  });

  it("leaves a claim the Worker already conceded alone", () => {
    const plan = planDeathSweep({
      deaths: [oomDeath()],
      claimed: [claimedBy(OWNER, 4136, "concede")],
      history: [],
      hostPrefix: HOST,
      env: {},
    });

    expect(plan.steps).toEqual([]);
    expect(plan.deferred[0]!.reason).toBe("no-claim");
  });

  it("defers a low-confidence unknown to today's lazy boot-sweep behaviour", () => {
    const plan = planDeathSweep({
      deaths: [oomDeath({ sender_class: "unknown", confidence: "low" })],
      claimed: [claimedBy(OWNER)],
      history: [],
      hostPrefix: HOST,
      env: {},
    });

    expect(plan.steps).toEqual([]);
    expect(plan.deferred[0]!.reason).toBe("no-named-sender");
  });

  it("counts the requeue ordinal off the history ledger", () => {
    const plan = planDeathSweep({
      deaths: [oomDeath()],
      claimed: [claimedBy(OWNER)],
      history: terminalRows(4136, 2),
      hostPrefix: HOST,
      env: { RED_AFK_RETRY_CRASH: "9" },
    });

    expect(plan.steps[0]!.ordinal).toBe(3);
  });
});

describe("one sweep tick, end to end", () => {
  const facts = {
    deaths: [oomDeath()],
    claimed: [claimedBy(OWNER)],
    history: [] as HistoryRecord[],
    hostPrefix: HOST,
  };

  it("releases the claim, appends the history row and requeues with an escalation", async () => {
    const plan = planDeathSweep({ ...facts, env: { RED_AFK_RETRY_CRASH: "3" } });
    const io = recordingIO();

    const result = await executeDeathSweep(plan, io, CLOCK);

    // Every step of the acceptance criterion, in the order the executor owes.
    expect(io.calls).toEqual([
      `concede:4136:${OWNER}`,
      "history:4136:blocked:hard-death:oomd",
      "labels:4136:-running:+ready-for-agent",
      "comment:4136",
    ]);
    expect(result.released).toEqual([4136]);
    expect(result.requeued).toEqual([4136]);
    expect(result.parked).toEqual([]);
    expect(result.outcomes).toEqual([
      { issue: 4136, workerId: WORKER_ID, decision: "retry", remedy: "memory-bump" },
    ]);
    // The ledger row is non-`done`, so the next hard death counts one higher.
    expect(io.history[0]!.historyEvent).not.toBe("done");
    expect(plan.steps[0]!.comment).toContain("memory ceiling raised");
    expect(plan.steps[0]!.comment).toContain("sender=oomd/high");
  });

  it("parks with the death evidence quoted once the recoverable cap is spent", async () => {
    const plan = planDeathSweep({
      ...facts,
      history: terminalRows(4136, 1),
      env: { RED_AFK_RETRY_CRASH: "2" },
    });
    const io = recordingIO();

    const result = await executeDeathSweep(plan, io, CLOCK);

    expect(plan.steps[0]!.ordinal).toBe(2);
    expect(plan.steps[0]!.disposition.decision).toBe("escalate");
    expect(io.calls[2]).toBe("labels:4136:-running:+ready-for-human+blocked:signal-killed");
    expect(result.parked).toEqual([4136]);
    expect(result.requeued).toEqual([]);
    expect(plan.steps[0]!.comment).toContain("retry budget exhausted (attempt 2/2)");
    expect(plan.steps[0]!.comment).toContain("Death evidence: sender=oomd/high");
    expect(plan.steps[0]!.comment).toContain("memory peak=4.00 GiB");
  });

  it("parks the very first hard death under the shipped `crashed` cap of one", () => {
    const plan = planDeathSweep({ ...facts, env: {} });

    expect(plan.steps[0]!.ordinal).toBe(1);
    expect(plan.steps[0]!.disposition.decision).toBe("escalate");
    expect(plan.steps[0]!.disposition.cap).toBe(1);
  });

  it("skips an issue another writer already released", async () => {
    const plan = planDeathSweep({ ...facts, env: { RED_AFK_RETRY_CRASH: "3" } });
    const io = recordingIO({ viewLabels: async () => ["ready-for-agent"] });

    const result = await executeDeathSweep(plan, io, CLOCK);

    expect(io.calls).toEqual([]);
    expect(result.outcomes[0]!.decision).toBe("skipped");
    expect(result.released).toEqual([]);
  });

  it("records a failure and leaves the issue for the staleness sweep", async () => {
    const plan = planDeathSweep({ ...facts, env: { RED_AFK_RETRY_CRASH: "3" } });
    const io = recordingIO({
      editLabels: async () => {
        throw new Error("gh refused");
      },
    });

    const result = await executeDeathSweep(plan, io, CLOCK);

    expect(result.outcomes[0]!.decision).toBe("failed");
    expect(result.released).toEqual([]);
  });
});

describe("renderDeathSweepAudit — a retry says what changed, a park says what ran out", () => {
  it("names the requeue ordinal, the cap and the remedy on a retry", () => {
    const plan = planDeathSweep({
      deaths: [oomDeath()],
      claimed: [claimedBy(OWNER)],
      history: [],
      hostPrefix: HOST,
      env: { RED_AFK_RETRY_CRASH: "3" },
    });
    const step = plan.steps[0]!;

    const body = renderDeathSweepAudit({
      evidence: step.evidence,
      disposition: step.disposition,
      remedy: step.remedy,
      ordinal: step.ordinal,
      owner: step.claimOwner,
    });

    expect(body).toContain("died without saying goodbye");
    expect(body).toContain("released eagerly");
    expect(body).toContain("This is requeue 1 of 3");
  });
});

describe("runDeathSweep — one verb for the tick and the reap", () => {
  function port(overrides: Partial<DeathSweepPort> = {}): DeathSweepPort {
    const io = recordingIO();
    return {
      ...io,
      hostPrefix: HOST,
      deaths: async () => [oomDeath()],
      claimedIssues: async () => [claimedBy(OWNER)],
      history: async () => [],
      ...overrides,
    };
  }

  it("reads, plans and applies in one call", async () => {
    const lines: string[] = [];

    const result = await runDeathSweep(port(), {
      env: { RED_AFK_RETRY_CRASH: "3" },
      clock: CLOCK,
      log: (line) => lines.push(line),
    });

    expect(result.released).toEqual([4136]);
    expect(lines[0]).toContain("death sweep #4136: oomd → retry");
  });

  it("costs nothing when the lane holds no death", async () => {
    let claimReads = 0;

    const result = await runDeathSweep(
      port({
        deaths: async () => [],
        claimedIssues: async () => {
          claimReads += 1;
          return [];
        },
      }),
      { env: {}, clock: CLOCK },
    );

    expect(claimReads).toBe(0);
    expect(result.released).toEqual([]);
  });

  it("yields an empty tick when a read fails, leaving the staleness sweep to cover it", async () => {
    const result = await runDeathSweep(
      port({
        deaths: async () => {
          throw new Error("lane unreadable");
        },
      }),
      { env: {}, clock: CLOCK },
    );

    expect(result).toEqual({
      released: [],
      requeued: [],
      parked: [],
      deferred: [],
      outcomes: [],
    });
  });
});
