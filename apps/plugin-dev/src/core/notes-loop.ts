// Intra-attempt notes-loop (Track C, #924). AFK's default attempt is ONE inner
// agent invocation: sandcastle spawns the agent on the worker branch, the agent
// works until it emits the completion block / sentinel, and the orchestrator
// lands the result. This module adds an OPT-IN outer loop around that single
// invocation. When enabled, each outer iteration makes one small committed
// change, the loop reads the run's real completion state from the
// structured-output adapter (ADR 0090), and — if the agent is not done — seeds
// the NEXT iteration with an accumulated `notes.md` describing prior progress.
// A `done` outcome short-circuits to land; a cap-hit hands the last partial run
// straight back so the caller salvages + lands it.
//
// Feasibility (GREEN): sandcastle `run()` is re-invokable on the same branch —
// commits accumulate — so the loop needs no red-castle change; it just calls the
// existing `runAgent` port N times with a varying handoff. The loop is DEFAULT
// OFF: `enabled:false` runs `runOnce` exactly once with the base handoff, byte
// for byte today's behaviour.
//
// Caps: `maxIterations` (outer re-invocation ceiling), `innerMaxIterations` (the
// per-iteration sandcastle ceiling), `tokenBudget`, and `wallClockS`. The two
// resource caps are checked BETWEEN iterations only — never mid-run — so they
// can never double-abort with the per-call attempt guard (execution.ts), which
// solely owns aborting a single in-flight iteration.
import { getConfig, type ConfigValues } from "./config.js";
import type { RunAgentResult, AgentOutcome } from "./execution.js";

/** The carried-notes file, materialised at the attempt dir (never committed). */
export const NOTES_FILE_NAME = "notes.md";

/** Outer re-invocation ceiling — how many agent calls the loop makes at most. */
export const NOTES_LOOP_DEFAULT_MAX_ITERATIONS = 4;
/** Per-iteration sandcastle ceiling override; `0` → leave the run's own default. */
export const NOTES_LOOP_DEFAULT_INNER_MAX_ITERATIONS = 0;
/** Cumulative token ceiling checked between iterations; `0` → unlimited. */
export const NOTES_LOOP_DEFAULT_TOKEN_BUDGET = 0;
/** Wall-clock ceiling (seconds) checked between iterations; `0` → unlimited. */
export const NOTES_LOOP_DEFAULT_WALL_CLOCK_S = 0;

/** Resolved `afk.notes_loop.*` knobs (ADR 0042 folding handled by loadConfig). */
export interface NotesLoopConfig {
  /** Master switch. `false` (default) → exactly one agent call, no notes. */
  enabled: boolean;
  /** Outer re-invocation ceiling (>= 1). */
  maxIterations: number;
  /** Per-iteration sandcastle re-invocation ceiling; `0` → no override. */
  innerMaxIterations: number;
  /** Cumulative input+output token ceiling; `0` → unlimited. */
  tokenBudget: number;
  /** Wall-clock ceiling in seconds; `0` → unlimited. */
  wallClockS: number;
  /**
   * Sync trunk into the working branch at every iteration boundary (#2481).
   * Default true: drift that is never pulled in only ever grows, and the
   * landing rebase pays for all of it at once.
   */
  trunkSync: boolean;
}

/**
 * Resolve the notes-loop config from the loaded `.red/config.yaml` values.
 * Mirrors the typo-safety used elsewhere (worktree-pool): a non-numeric or
 * negative cap floors back to its default so a config typo can never produce a
 * zero-iteration loop (which would run nothing) — while `0` stays meaningful for
 * the two resource caps, where it means "unlimited".
 */
export function resolveNotesLoopConfig(values: ConfigValues): NotesLoopConfig {
  const posInt = (key: string, fallback: number): number => {
    const raw = getConfig(values, key);
    if (/^[0-9]+$/.test(raw)) {
      const n = Number(raw);
      if (n > 0) return n;
    }
    return fallback;
  };
  // `0` is a valid value for the resource caps (unlimited); only a non-integer
  // floors back to the default.
  const nonNegInt = (key: string, fallback: number): number => {
    const raw = getConfig(values, key);
    return /^[0-9]+$/.test(raw) ? Number(raw) : fallback;
  };
  return {
    enabled: getConfig(values, "afk.notes_loop.enabled") === "true",
    maxIterations: posInt("afk.notes_loop.max_iterations", NOTES_LOOP_DEFAULT_MAX_ITERATIONS),
    innerMaxIterations: nonNegInt("afk.notes_loop.inner_max_iterations", NOTES_LOOP_DEFAULT_INNER_MAX_ITERATIONS),
    tokenBudget: nonNegInt("afk.notes_loop.token_budget", NOTES_LOOP_DEFAULT_TOKEN_BUDGET),
    wallClockS: nonNegInt("afk.notes_loop.wall_clock_s", NOTES_LOOP_DEFAULT_WALL_CLOCK_S),
    // Opt-OUT, unlike every other knob here: skipping the sync is what produced
    // the 65-commit stale-base branches (#2481), so only an explicit `false` does.
    trunkSync: getConfig(values, "afk.notes_loop.trunk_sync") !== "false",
  };
}

/** Absolute path to the attempt's carried-notes file. */
export function notesPath(attemptDir: string): string {
  return `${attemptDir}/${NOTES_FILE_NAME}`;
}

/** Why the loop stopped. */
export type NotesLoopStop =
  | "done" // the agent signalled completion (structured success or sentinel)
  | "blocked" // the agent explicitly declared the work impossible
  | "terminal" // a per-call terminal outcome (exhausted / timeout / …) — hand back as-is
  | "max-iterations" // outer re-invocation ceiling reached with partial work
  | "token-budget" // cumulative token ceiling reached between iterations
  | "wall-clock"; // wall-clock ceiling reached between iterations

/** The context handed to `runOnce` for a single outer iteration. */
export interface NotesLoopIteration {
  /** 1-based iteration index. */
  iteration: number;
  /** The handoff for this iteration: base handoff + carried notes (if any). */
  handoff: string;
  /** The accumulated `notes.md` content ("" on the first iteration). */
  notes: string;
}

export interface NotesLoopDeps {
  config: NotesLoopConfig;
  /** The base handoff every iteration starts from (before notes are appended). */
  baseHandoff: string;
  /** Run ONE inner-agent iteration and return its normalised result. */
  runOnce(iteration: NotesLoopIteration): Promise<RunAgentResult>;
  /** Persist the accumulated notes (the caller writes `notes.md` at attemptDir). */
  persistNotes?(content: string): void;
  /** Millisecond clock for the wall-clock cap; defaults to `Date.now`. */
  now?(): number;
  /** Cumulative input+output tokens spent this attempt; enables the token cap. */
  tokensSpent?(): number;
  /** Optional progress log sink. */
  log?(message: string): void;
  /**
   * Sync trunk into the working branch at an iteration boundary (#2481).
   * Returns the note to carry into the next iteration's handoff, or `undefined`
   * when nothing happened. Absent → no sync, exactly as before this existed.
   */
  syncTrunk?(iteration: number): Promise<string | undefined>;
}

export interface NotesLoopOutcome {
  /** The final run — the one the caller salvages / lands. */
  run: RunAgentResult;
  /** How many agent calls the loop made. */
  iterations: number;
  /** Why the loop stopped. */
  stoppedBy: NotesLoopStop;
  /** The final accumulated notes (empty when disabled or done on iteration 1). */
  notes: string;
}

/**
 * The only outcome that CONTINUES the loop: the agent ran, likely committed a
 * small change, but did not signal completion (`no-sentinel`). Every other
 * non-`done` outcome is terminal for the loop — `blocked` is an explicit
 * give-up, and the runner/predicate outcomes (`exhausted`, `runner-transient`,
 * `signal-killed`, `goal-moot`) are handled by the caller's
 * existing terminal policy and re-seeding them would not help.
 */
function isContinuable(outcome: AgentOutcome): boolean {
  return outcome === "no-sentinel";
}

/**
 * Render the carried-notes preamble prepended to the next iteration's handoff.
 * It tells the agent to continue from prior progress and to make ONE small
 * committed change — the notes-loop contract — rather than restarting.
 */
export function renderNotesSection(notes: string): string {
  return [
    "<carried-notes>",
    "Prior iterations of THIS attempt (same worker branch, commits accumulate)",
    "recorded the progress below. Continue from here — do NOT redo completed work.",
    "Make ONE small, committed change this iteration, then stop. The outer loop",
    "re-invokes you with updated notes until the whole issue is done; emit the",
    "completion block ONLY when the entire issue is complete.",
    "",
    notes.trim(),
    "</carried-notes>",
  ].join("\n");
}

/**
 * Append a structured entry for the just-finished iteration to the running
 * notes. Draws on the run's structured `AgentOutput` (ADR 0090) when present —
 * its `summary` / `key_changes_made` / `key_learnings` are exactly the
 * continuity signal the next iteration needs — and always records the outcome +
 * commit count so a cap-hit audit trail is legible even without a structured
 * block.
 */
export function appendNotesEntry(prior: string, iteration: number, run: RunAgentResult): string {
  const lines: string[] = [`## Iteration ${iteration}`];
  lines.push(`- outcome: ${run.outcome}; commits this iteration: ${run.commits.length}`);
  const out = run.agentOutput;
  if (out) {
    if (out.summary.trim()) lines.push(`- summary: ${out.summary.trim()}`);
    for (const change of out.key_changes_made) lines.push(`- change: ${change}`);
    for (const learning of out.key_learnings) lines.push(`- learning: ${learning}`);
  }
  const entry = lines.join("\n");
  return prior ? `${prior}\n\n${entry}` : entry;
}

/**
 * Run the bounded intra-attempt notes-loop.
 *
 * Disabled (`config.enabled === false`): `runOnce` fires exactly once with the
 * base handoff and no notes — today's single-invocation behaviour, unchanged.
 *
 * Enabled: iterate up to `maxIterations`. Each iteration builds a handoff (base
 * handoff + carried notes), runs the agent, and reads the outcome. `done`
 * short-circuits to land; a terminal outcome is handed straight back; a
 * continuable `no-sentinel` accumulates a notes entry, persists it, and seeds
 * the next iteration. Reaching a cap (iterations / tokens / wall-clock) returns
 * the last partial run for the caller to salvage + land. The two resource caps
 * are checked only BETWEEN iterations, so the first iteration always runs and
 * the caps never race the per-call attempt guard.
 */
export async function runNotesLoop(deps: NotesLoopDeps): Promise<NotesLoopOutcome> {
  const cfg = deps.config;

  // Disabled → exactly one call, base handoff, no notes seeding or persistence.
  if (!cfg.enabled) {
    const run = await deps.runOnce({ iteration: 1, handoff: deps.baseHandoff, notes: "" });
    return { run, iterations: 1, stoppedBy: stopForOutcome(run.outcome), notes: "" };
  }

  const now = deps.now ?? (() => Date.now());
  const startMs = now();
  const cap = Math.max(1, cfg.maxIterations);

  let notes = "";
  let lastRun: RunAgentResult | undefined;
  let iteration = 0;

  while (iteration < cap) {
    // Resource caps are evaluated BETWEEN iterations only — the first iteration
    // always runs, and a mid-run iteration is never interrupted here (the
    // per-call attempt guard owns that). This is the "never double-abort"
    // guarantee.
    if (iteration > 0) {
      if (cfg.wallClockS > 0 && (now() - startMs) / 1000 >= cfg.wallClockS) {
        deps.log?.(`[afk] notes-loop: wall-clock cap ${cfg.wallClockS}s hit after ${iteration} iteration(s)`);
        return { run: lastRun!, iterations: iteration, stoppedBy: "wall-clock", notes };
      }
      if (cfg.tokenBudget > 0 && deps.tokensSpent && deps.tokensSpent() >= cfg.tokenBudget) {
        deps.log?.(`[afk] notes-loop: token budget ${cfg.tokenBudget} hit after ${iteration} iteration(s)`);
        return { run: lastRun!, iterations: iteration, stoppedBy: "token-budget", notes };
      }
    }

    iteration += 1;
    const handoff = notes ? `${deps.baseHandoff}\n\n${renderNotesSection(notes)}` : deps.baseHandoff;
    const run = await deps.runOnce({ iteration, handoff, notes });
    lastRun = run;

    if (run.outcome === "done") {
      return { run, iterations: iteration, stoppedBy: "done", notes };
    }
    if (!isContinuable(run.outcome)) {
      return { run, iterations: iteration, stoppedBy: run.outcome === "blocked" ? "blocked" : "terminal", notes };
    }

    // Continuable: record progress and seed the next iteration.
    notes = appendNotesEntry(notes, iteration, run);
    // Trunk sync at the iteration boundary (#2481): the branch just took a
    // committed step, so this is the one moment the worktree is quiet. Whatever
    // the sync has to say rides into the next handoff as a note — a conflict
    // becomes the agent's first instruction while the drift is still small.
    if (cfg.trunkSync && deps.syncTrunk) {
      const syncNote = await deps.syncTrunk(iteration);
      if (syncNote) {
        notes = `${notes}\n${syncNote}\n`;
        deps.log?.(`[afk] notes-loop: trunk sync after iteration ${iteration} — ${syncNote}`);
      }
    }
    deps.persistNotes?.(notes);
    deps.log?.(`[afk] notes-loop: iteration ${iteration}/${cap} produced no completion; carrying notes forward`);
  }

  return { run: lastRun!, iterations: iteration, stoppedBy: "max-iterations", notes };
}

/** Map a single-run outcome to the disabled-path stop reason. */
function stopForOutcome(outcome: AgentOutcome): NotesLoopStop {
  if (outcome === "done") return "done";
  if (outcome === "blocked") return "blocked";
  return "terminal";
}
