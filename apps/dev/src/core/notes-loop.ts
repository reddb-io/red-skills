// notes-loop — Track C accumulative short-iteration inner loop (issue #997).
//
// Pure helpers for the opt-in OUTER loop around processIssue's single `runAgent`
// call. When `plugins.dev.afk.notes_loop.enabled` is true, the orchestrator
// makes several SHORT agent runs instead of one long one: each run is seeded
// with a `notes.md` summary of prior progress and is expected to commit one
// small incremental change. sandcastle's `run()` is re-invokable — with a
// branch strategy carrying prior commits it accumulates correctly — so no
// red-castle change is needed.
//
// This module owns only the PURE pieces: config resolution, the notes.md
// template, the per-iteration one-sentence summary derivation, and the
// notes-seeded prompt injection. The IO loop (repeated `runAgent` calls +
// between-call salvage-commits) lives in process-issue.ts (`runNotesLoop`),
// which composes these helpers through injected IO.

import { getConfig, type ConfigValues } from "./config.js";
import type { AgentOutcome, RunAgentResult } from "./execution.js";

/** Default cap on the number of short outer iterations. */
export const NOTES_LOOP_DEFAULT_MAX_ITERATIONS = 5;
/** Default per-iteration inner re-invocation ceiling (short runs). */
export const NOTES_LOOP_DEFAULT_PER_ITERATION_MAX_ITERATIONS = 8;

/**
 * Resolved `plugins.dev.afk.notes_loop.*` config. `enabled` defaults false, so
 * an absent block leaves processIssue on its single-`runAgent` path (byte-for-
 * byte no behaviour change). `tokenBudget`/`wallClockBudgetS` are undefined when
 * unset (unbounded). NOTE: the token budget is reliable only for codex/opencode,
 * which emit discrete per-turn token usage; claude folds thinking into output and
 * accrues usage at the iteration boundary, so a claude notes-loop should lean on
 * the iteration + wall-clock caps instead (documented in config-template.yaml).
 */
export interface NotesLoopConfig {
  enabled: boolean;
  maxIterations: number;
  perIterationMaxIterations: number;
  tokenBudget?: number;
  wallClockBudgetS?: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the notes-loop config from the folded `afk.notes_loop.*` accessor keys
 * (`loadConfig` folds `plugins.dev.afk.notes_loop.*` down to these, ADR 0042).
 * Absent/malformed values fall back to the documented defaults; `enabled` is
 * strictly opt-in (anything other than the literal `"true"` is disabled).
 */
export function resolveNotesLoopConfig(values: ConfigValues): NotesLoopConfig {
  return {
    enabled: getConfig(values, "afk.notes_loop.enabled") === "true",
    maxIterations: parsePositiveInt(
      getConfig(values, "afk.notes_loop.max_iterations") || undefined,
      NOTES_LOOP_DEFAULT_MAX_ITERATIONS,
    ),
    perIterationMaxIterations: parsePositiveInt(
      getConfig(values, "afk.notes_loop.per_iteration_max_iterations") || undefined,
      NOTES_LOOP_DEFAULT_PER_ITERATION_MAX_ITERATIONS,
    ),
    tokenBudget: parseOptionalPositiveInt(getConfig(values, "afk.notes_loop.token_budget") || undefined),
    wallClockBudgetS: parseOptionalPositiveInt(getConfig(values, "afk.notes_loop.wall_clock_budget_s") || undefined),
  };
}

/** One outer iteration's accumulated record, rendered into notes.md. */
export interface NoteEntry {
  /** 1-based outer iteration index. */
  iteration: number;
  /** The agent outcome that iteration returned. */
  outcome: AgentOutcome;
  /** Commits the iteration landed on the worker branch. */
  commits: number;
  /** One-sentence progress summary derived from the run. */
  summary: string;
}

/**
 * Only a `no-sentinel` outcome keeps the outer loop going (the agent produced a
 * short increment but did not signal DONE/BLOCKED). Every other outcome is
 * propagated verbatim to processIssue's existing routing: `done` → land tail,
 * `blocked` → terminal, runner-recoverable → fallback, budget/timeout/goal-moot
 * → their own terminals. This is what keeps the per-call guard (intra-call) and
 * the outer caps (between-call) from ever double-aborting the same attempt.
 */
export function isNotesLoopContinuable(outcome: AgentOutcome): boolean {
  return outcome === "no-sentinel";
}

/** The last non-blank line of the run's captured stdout, trimmed and clamped. */
function lastStdoutLine(stdout: string | undefined): string {
  const line = (stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .at(-1);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/**
 * Derive one iteration's one-sentence progress summary from its run result.
 * Deterministic and pure — no clock, no model call — so it is unit-testable and
 * cheap. Leans on the observable signals (commit count + last stdout line)
 * rather than an LLM summary, which keeps it reliable across all runners.
 */
export function deriveNoteSummary(run: RunAgentResult): string {
  const commits = run.commits.length;
  const tail = lastStdoutLine(run.stdout);
  const base =
    commits === 0
      ? "made no commit this iteration"
      : `committed ${commits} change${commits === 1 ? "" : "s"}`;
  return tail ? `${base}; last: ${tail}` : base;
}

/** Build a {@link NoteEntry} for the given outer iteration + run result. */
export function deriveNoteEntry(iteration: number, run: RunAgentResult): NoteEntry {
  return {
    iteration,
    outcome: run.outcome,
    commits: run.commits.length,
    summary: deriveNoteSummary(run),
  };
}

/**
 * Render the accumulated notes into the notes.md body — a stable, human- and
 * agent-readable summary of every prior short iteration. Returns "" for an empty
 * entry list so the first iteration injects nothing (a clean single-run handoff).
 */
export function renderNotes(entries: readonly NoteEntry[]): string {
  if (entries.length === 0) return "";
  const lines = [
    "# AFK notes-loop progress",
    "",
    "Accumulated summary of prior short iterations on this branch. Continue the",
    "work — do NOT redo what is already listed below.",
    "",
  ];
  for (const e of entries) {
    lines.push(`- iteration ${e.iteration} (${e.outcome}, ${e.commits} commit(s)): ${e.summary}`);
  }
  return lines.join("\n") + "\n";
}

export const NOTES_LOOP_SECTION_OPEN = "<notes-loop-progress>";
export const NOTES_LOOP_SECTION_CLOSE = "</notes-loop-progress>";

/**
 * Seed a handoff with the accumulated notes.md summary. Inserts a
 * `<notes-loop-progress>` section immediately before the trailing `<agent-notes>`
 * block (or appends it when that block is absent). An empty `notesMarkdown` (the
 * first iteration) returns the handoff unchanged, so iteration 1 is identical to
 * a normal single run.
 */
export function injectNotesIntoHandoff(handoff: string, notesMarkdown: string): string {
  if (notesMarkdown.trim().length === 0) return handoff;
  const block = [
    "",
    NOTES_LOOP_SECTION_OPEN,
    "You are running in accumulative notes-loop mode: several short iterations,",
    "each committing one small increment. The notes below summarise what prior",
    "iterations already did on this branch. Build on them; commit one focused",
    "increment, then stop. Emit <promise>DONE</promise> only when the whole",
    "acceptance criteria are met.",
    "",
    notesMarkdown.trimEnd(),
    NOTES_LOOP_SECTION_CLOSE,
    "",
  ].join("\n");
  const marker = "\n<agent-notes>";
  const idx = handoff.indexOf(marker);
  if (idx === -1) return `${handoff}\n${block}`;
  return `${handoff.slice(0, idx)}\n${block}${handoff.slice(idx)}`;
}
