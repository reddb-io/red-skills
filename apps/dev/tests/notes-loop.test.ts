import { describe, it, expect } from "vitest";
import {
  resolveNotesLoopConfig,
  runNotesLoop,
  renderNotesSection,
  appendNotesEntry,
  notesPath,
  NOTES_FILE_NAME,
  NOTES_LOOP_DEFAULT_MAX_ITERATIONS,
  type NotesLoopConfig,
  type NotesLoopIteration,
} from "../src/core/notes-loop.js";
import type { RunAgentResult, AgentOutcome, AgentOutput } from "../src/core/execution.js";

const cfg = (over: Partial<NotesLoopConfig> = {}): NotesLoopConfig => ({
  enabled: true,
  maxIterations: 3,
  innerMaxIterations: 0,
  tokenBudget: 0,
  wallClockS: 0,
  trunkSync: false,
  ...over,
});

const result = (outcome: AgentOutcome, over: Partial<RunAgentResult> = {}): RunAgentResult => ({
  outcome,
  branch: "afk/w/1-x",
  commits: [],
  stdout: "",
  ...over,
});

const structured = (over: Partial<AgentOutput> = {}): AgentOutput => ({
  success: false,
  summary: "made a small change",
  key_changes_made: ["edited a.ts"],
  key_learnings: [],
  should_fully_stop: false,
  ...over,
});

describe("resolveNotesLoopConfig", () => {
  it("defaults to disabled with the documented caps", () => {
    const c = resolveNotesLoopConfig({});
    expect(c.enabled).toBe(false);
    expect(c.maxIterations).toBe(NOTES_LOOP_DEFAULT_MAX_ITERATIONS);
    expect(c.innerMaxIterations).toBe(0);
    expect(c.tokenBudget).toBe(0);
    expect(c.wallClockS).toBe(0);
    // #2481: the sync is opt-OUT — never syncing is what produced stale bases.
    expect(c.trunkSync).toBe(true);
  });

  it("reads the folded accessor keys", () => {
    const c = resolveNotesLoopConfig({
      "afk.notes_loop.enabled": "true",
      "afk.notes_loop.max_iterations": "6",
      "afk.notes_loop.inner_max_iterations": "10",
      "afk.notes_loop.token_budget": "500000",
      "afk.notes_loop.wall_clock_s": "3600",
    });
    expect(c).toEqual({
      enabled: true,
      maxIterations: 6,
      innerMaxIterations: 10,
      tokenBudget: 500000,
      wallClockS: 3600,
      trunkSync: true,
    });
  });

  it("floors a non-numeric / zero max_iterations back to the default but keeps 0 as unlimited for resource caps", () => {
    const c = resolveNotesLoopConfig({
      "afk.notes_loop.max_iterations": "0", // invalid → default (never a zero-iteration loop)
      "afk.notes_loop.token_budget": "0", // valid → unlimited
      "afk.notes_loop.wall_clock_s": "nope", // invalid → default 0
    });
    expect(c.maxIterations).toBe(NOTES_LOOP_DEFAULT_MAX_ITERATIONS);
    expect(c.tokenBudget).toBe(0);
    expect(c.wallClockS).toBe(0);
  });
});

describe("notesPath", () => {
  it("materialises notes.md at the attempt dir", () => {
    expect(notesPath("/x/.red/tmp/a-1")).toBe(`/x/.red/tmp/a-1/${NOTES_FILE_NAME}`);
  });
});

describe("runNotesLoop — disabled (default off)", () => {
  it("enabled:false runs exactly one agent call with the base handoff and no notes", async () => {
    const calls: NotesLoopIteration[] = [];
    const persisted: string[] = [];
    const out = await runNotesLoop({
      config: cfg({ enabled: false }),
      baseHandoff: "BASE",
      runOnce: (it) => {
        calls.push(it);
        return Promise.resolve(result("done", { commits: [{ sha: "a" }] }));
      },
      persistNotes: (c) => persisted.push(c),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.handoff).toBe("BASE");
    expect(calls[0]!.notes).toBe("");
    expect(persisted).toHaveLength(0);
    expect(out.iterations).toBe(1);
    expect(out.stoppedBy).toBe("done");
  });
});

describe("runNotesLoop — enabled", () => {
  it("stops on DONE and short-circuits to land", async () => {
    let n = 0;
    const out = await runNotesLoop({
      config: cfg({ maxIterations: 5 }),
      baseHandoff: "BASE",
      runOnce: () => {
        n += 1;
        return Promise.resolve(n < 2 ? result("no-sentinel", { commits: [{ sha: "c1" }] }) : result("done", { commits: [{ sha: "c2" }] }));
      },
    });
    expect(n).toBe(2);
    expect(out.stoppedBy).toBe("done");
    expect(out.iterations).toBe(2);
    expect(out.run.outcome).toBe("done");
  });

  it("makes N calls when the agent never signals DONE, then caps out", async () => {
    let n = 0;
    const out = await runNotesLoop({
      config: cfg({ maxIterations: 3 }),
      baseHandoff: "BASE",
      runOnce: () => {
        n += 1;
        return Promise.resolve(result("no-sentinel", { commits: [{ sha: `c${n}` }] }));
      },
    });
    expect(n).toBe(3);
    expect(out.iterations).toBe(3);
    expect(out.stoppedBy).toBe("max-iterations");
  });

  it("#2481: syncs trunk at every iteration boundary and carries the note forward", async () => {
    const syncedAt: number[] = [];
    const handoffs: string[] = [];
    await runNotesLoop({
      config: cfg({ maxIterations: 3, trunkSync: true }),
      baseHandoff: "BASE",
      runOnce: (it) => {
        handoffs.push(it.handoff);
        return Promise.resolve(result("no-sentinel", { commits: [{ sha: "c1" }] }));
      },
      syncTrunk: (iteration) => {
        syncedAt.push(iteration);
        return Promise.resolve(`Trunk sync: merged ${iteration}`);
      },
    });
    // An attempt running >1 iteration syncs at least once — here after each.
    expect(syncedAt).toEqual([1, 2, 3]);
    expect(handoffs[1]).toContain("Trunk sync: merged 1");
    expect(handoffs[2]).toContain("Trunk sync: merged 2");
  });

  it("#2481: a sync that changed nothing adds no note", async () => {
    const handoffs: string[] = [];
    await runNotesLoop({
      config: cfg({ maxIterations: 2, trunkSync: true }),
      baseHandoff: "BASE",
      runOnce: (it) => {
        handoffs.push(it.handoff);
        return Promise.resolve(result("no-sentinel", { commits: [{ sha: "c1" }] }));
      },
      syncTrunk: () => Promise.resolve(undefined),
    });
    expect(handoffs[1]).not.toContain("Trunk sync");
  });

  it("#2481: trunkSync:false never touches the worktree", async () => {
    let synced = 0;
    await runNotesLoop({
      config: cfg({ maxIterations: 2, trunkSync: false }),
      baseHandoff: "BASE",
      runOnce: () => Promise.resolve(result("no-sentinel", { commits: [{ sha: "c1" }] })),
      syncTrunk: () => {
        synced += 1;
        return Promise.resolve("nope");
      },
    });
    expect(synced).toBe(0);
  });

  it("#2481: a single done iteration never syncs — there is no boundary to sync at", async () => {
    let synced = 0;
    await runNotesLoop({
      config: cfg({ maxIterations: 3, trunkSync: true }),
      baseHandoff: "BASE",
      runOnce: () => Promise.resolve(result("done")),
      syncTrunk: () => {
        synced += 1;
        return Promise.resolve("nope");
      },
    });
    expect(synced).toBe(0);
  });

  it("carries prior notes into each subsequent iteration's handoff", async () => {
    const handoffs: string[] = [];
    let n = 0;
    await runNotesLoop({
      config: cfg({ maxIterations: 3 }),
      baseHandoff: "BASE",
      runOnce: (it) => {
        handoffs.push(it.handoff);
        n += 1;
        return Promise.resolve(
          result("no-sentinel", {
            commits: [{ sha: `c${n}` }],
            agentOutput: structured({ summary: `did step ${n}`, key_changes_made: [`change ${n}`] }),
          }),
        );
      },
    });
    // First iteration: bare base handoff (no notes yet).
    expect(handoffs[0]).toBe("BASE");
    // Second iteration: base handoff PLUS a carried-notes section citing step 1.
    expect(handoffs[1]).toContain("BASE");
    expect(handoffs[1]).toContain("<carried-notes>");
    expect(handoffs[1]).toContain("did step 1");
    expect(handoffs[1]).toContain("change 1");
    // Third iteration: notes accumulate — both prior steps present.
    expect(handoffs[2]).toContain("did step 1");
    expect(handoffs[2]).toContain("did step 2");
  });

  it("cap-hit persists notes and hands back the last partial run for salvage + land", async () => {
    const persisted: string[] = [];
    let n = 0;
    const out = await runNotesLoop({
      config: cfg({ maxIterations: 2 }),
      baseHandoff: "BASE",
      runOnce: () => {
        n += 1;
        return Promise.resolve(result("no-sentinel", { commits: [{ sha: `c${n}` }], agentOutput: structured({ summary: `s${n}` }) }));
      },
      persistNotes: (c) => persisted.push(c),
    });
    expect(out.stoppedBy).toBe("max-iterations");
    // The returned run is the LAST partial run — with its commits — so the caller
    // salvages + lands it.
    expect(out.run.commits.map((c) => c.sha)).toEqual(["c2"]);
    // Notes were persisted at least once per completed continuable iteration.
    expect(persisted.length).toBeGreaterThanOrEqual(1);
    expect(persisted[persisted.length - 1]).toContain("s1");
  });

  it("treats a blocked outcome as terminal without re-seeding", async () => {
    let n = 0;
    const out = await runNotesLoop({
      config: cfg({ maxIterations: 5 }),
      baseHandoff: "BASE",
      runOnce: () => {
        n += 1;
        return Promise.resolve(result("blocked"));
      },
    });
    expect(n).toBe(1);
    expect(out.stoppedBy).toBe("blocked");
  });

  it("hands a per-call terminal outcome (exhausted) straight back after one iteration", async () => {
    let n = 0;
    const out = await runNotesLoop({
      config: cfg({ maxIterations: 5 }),
      baseHandoff: "BASE",
      runOnce: () => {
        n += 1;
        return Promise.resolve(result("exhausted"));
      },
    });
    expect(n).toBe(1);
    expect(out.stoppedBy).toBe("terminal");
    expect(out.run.outcome).toBe("exhausted");
  });

  it("stops at the wall-clock cap between iterations (never mid-run)", async () => {
    let clock = 0;
    let n = 0;
    const out = await runNotesLoop({
      config: cfg({ maxIterations: 10, wallClockS: 5 }),
      baseHandoff: "BASE",
      now: () => clock,
      runOnce: () => {
        n += 1;
        clock += 6000; // each iteration advances the wall clock past the 5s cap
        return Promise.resolve(result("no-sentinel", { commits: [{ sha: `c${n}` }] }));
      },
    });
    // Iteration 1 always runs; the cap is observed BEFORE iteration 2.
    expect(n).toBe(1);
    expect(out.stoppedBy).toBe("wall-clock");
  });

  it("stops at the token budget between iterations", async () => {
    let spent = 0;
    let n = 0;
    const out = await runNotesLoop({
      config: cfg({ maxIterations: 10, tokenBudget: 100 }),
      baseHandoff: "BASE",
      tokensSpent: () => spent,
      runOnce: () => {
        n += 1;
        spent += 200; // blow the budget after the first iteration
        return Promise.resolve(result("no-sentinel", { commits: [{ sha: `c${n}` }] }));
      },
    });
    expect(n).toBe(1);
    expect(out.stoppedBy).toBe("token-budget");
  });
});

describe("notes formatting helpers", () => {
  it("renderNotesSection wraps the notes in a carried-notes block with continue guidance", () => {
    const s = renderNotesSection("## Iteration 1\n- did a thing");
    expect(s).toContain("<carried-notes>");
    expect(s).toContain("</carried-notes>");
    expect(s).toContain("ONE small, committed change");
    expect(s).toContain("did a thing");
  });

  it("appendNotesEntry records outcome, commits, and structured signal, accumulating across iterations", () => {
    const first = appendNotesEntry("", 1, result("no-sentinel", { commits: [{ sha: "a" }], agentOutput: structured({ summary: "step one", key_changes_made: ["c"], key_learnings: ["l"] }) }));
    expect(first).toContain("## Iteration 1");
    expect(first).toContain("commits this iteration: 1");
    expect(first).toContain("summary: step one");
    expect(first).toContain("change: c");
    expect(first).toContain("learning: l");
    const second = appendNotesEntry(first, 2, result("no-sentinel"));
    expect(second).toContain("## Iteration 1");
    expect(second).toContain("## Iteration 2");
  });
});
