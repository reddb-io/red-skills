import { describe, expect, it } from "vitest";
import {
  deriveNoteEntry,
  deriveNoteSummary,
  injectNotesIntoHandoff,
  isNotesLoopContinuable,
  NOTES_LOOP_DEFAULT_MAX_ITERATIONS,
  NOTES_LOOP_DEFAULT_PER_ITERATION_MAX_ITERATIONS,
  NOTES_LOOP_SECTION_CLOSE,
  NOTES_LOOP_SECTION_OPEN,
  renderNotes,
  resolveNotesLoopConfig,
  type NoteEntry,
} from "../src/core/notes-loop.js";
import type { RunAgentResult } from "../src/core/execution.js";

function run(partial: Partial<RunAgentResult>): RunAgentResult {
  return {
    outcome: "no-sentinel",
    branch: "afk/w/1-slug",
    commits: [],
    stdout: "",
    ...partial,
  };
}

describe("resolveNotesLoopConfig", () => {
  it("defaults to disabled with documented caps when the block is absent", () => {
    const cfg = resolveNotesLoopConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxIterations).toBe(NOTES_LOOP_DEFAULT_MAX_ITERATIONS);
    expect(cfg.perIterationMaxIterations).toBe(NOTES_LOOP_DEFAULT_PER_ITERATION_MAX_ITERATIONS);
    expect(cfg.tokenBudget).toBeUndefined();
    expect(cfg.wallClockBudgetS).toBeUndefined();
  });

  it("reads the folded afk.notes_loop.* accessor keys", () => {
    const cfg = resolveNotesLoopConfig({
      "afk.notes_loop.enabled": "true",
      "afk.notes_loop.max_iterations": "3",
      "afk.notes_loop.per_iteration_max_iterations": "2",
      "afk.notes_loop.token_budget": "500000",
      "afk.notes_loop.wall_clock_budget_s": "1800",
    });
    expect(cfg).toEqual({
      enabled: true,
      maxIterations: 3,
      perIterationMaxIterations: 2,
      tokenBudget: 500000,
      wallClockBudgetS: 1800,
    });
  });

  it("treats non-`true` enabled and malformed caps as disabled/default", () => {
    const cfg = resolveNotesLoopConfig({
      "afk.notes_loop.enabled": "1",
      "afk.notes_loop.max_iterations": "0",
      "afk.notes_loop.per_iteration_max_iterations": "nope",
      "afk.notes_loop.token_budget": "-5",
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxIterations).toBe(NOTES_LOOP_DEFAULT_MAX_ITERATIONS);
    expect(cfg.perIterationMaxIterations).toBe(NOTES_LOOP_DEFAULT_PER_ITERATION_MAX_ITERATIONS);
    expect(cfg.tokenBudget).toBeUndefined();
  });
});

describe("deriveNoteSummary / deriveNoteEntry", () => {
  it("summarises a zero-commit iteration", () => {
    expect(deriveNoteSummary(run({ commits: [], stdout: "" }))).toBe("made no commit this iteration");
  });

  it("counts commits and appends the last stdout line", () => {
    const summary = deriveNoteSummary(
      run({ commits: [{ sha: "a" }, { sha: "b" }], stdout: "setup\nwrote failing test" }),
    );
    expect(summary).toBe("committed 2 changes; last: wrote failing test");
  });

  it("uses singular for a single commit", () => {
    expect(deriveNoteSummary(run({ commits: [{ sha: "a" }], stdout: "" }))).toBe("committed 1 change");
  });

  it("builds a full entry carrying iteration + outcome", () => {
    const entry = deriveNoteEntry(2, run({ outcome: "no-sentinel", commits: [{ sha: "a" }], stdout: "did x" }));
    expect(entry).toEqual({
      iteration: 2,
      outcome: "no-sentinel",
      commits: 1,
      summary: "committed 1 change; last: did x",
    });
  });
});

describe("renderNotes", () => {
  it("returns empty for no entries (first iteration seeds nothing)", () => {
    expect(renderNotes([])).toBe("");
  });

  it("renders one bullet per iteration in order", () => {
    const entries: NoteEntry[] = [
      { iteration: 1, outcome: "no-sentinel", commits: 2, summary: "committed 2 changes; last: added scaffold" },
      { iteration: 2, outcome: "no-sentinel", commits: 1, summary: "committed 1 change; last: wired config" },
    ];
    const out = renderNotes(entries);
    expect(out).toContain("# AFK notes-loop progress");
    expect(out).toContain("- iteration 1 (no-sentinel, 2 commit(s)): committed 2 changes; last: added scaffold");
    expect(out).toContain("- iteration 2 (no-sentinel, 1 commit(s)): committed 1 change; last: wired config");
    // iteration order preserved
    expect(out.indexOf("iteration 1")).toBeLessThan(out.indexOf("iteration 2"));
  });
});

describe("injectNotesIntoHandoff", () => {
  const handoff = ["# Issue #1 — x [AFK]", "", "body here", "", "<agent-notes>", "<!-- x -->", "</agent-notes>", ""].join(
    "\n",
  );

  it("returns the handoff unchanged for empty notes", () => {
    expect(injectNotesIntoHandoff(handoff, "")).toBe(handoff);
    expect(injectNotesIntoHandoff(handoff, "   \n  ")).toBe(handoff);
  });

  it("inserts a notes-loop-progress section before <agent-notes>", () => {
    const notes = renderNotes([
      { iteration: 1, outcome: "no-sentinel", commits: 1, summary: "committed 1 change" },
    ]);
    const seeded = injectNotesIntoHandoff(handoff, notes);
    expect(seeded).toContain(NOTES_LOOP_SECTION_OPEN);
    expect(seeded).toContain(NOTES_LOOP_SECTION_CLOSE);
    expect(seeded).toContain("- iteration 1 (no-sentinel, 1 commit(s)): committed 1 change");
    // ordering: progress section precedes the agent-notes trailer
    expect(seeded.indexOf(NOTES_LOOP_SECTION_OPEN)).toBeLessThan(seeded.indexOf("<agent-notes>"));
    // original body preserved
    expect(seeded).toContain("body here");
  });

  it("appends the section when no <agent-notes> trailer exists", () => {
    const seeded = injectNotesIntoHandoff("just a prompt", "# notes\n\n- iteration 1 (done, 1 commit(s)): x\n");
    expect(seeded.startsWith("just a prompt")).toBe(true);
    expect(seeded).toContain(NOTES_LOOP_SECTION_OPEN);
  });
});

describe("isNotesLoopContinuable", () => {
  it("continues only on no-sentinel", () => {
    expect(isNotesLoopContinuable("no-sentinel")).toBe(true);
    for (const o of ["done", "blocked", "exhausted", "runner-transient", "timeout", "budget-exceeded", "goal-moot"] as const) {
      expect(isNotesLoopContinuable(o)).toBe(false);
    }
  });
});
