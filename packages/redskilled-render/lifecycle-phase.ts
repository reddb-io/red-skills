/**
 * lifecycle-phase — where a live Worker stands in its pipeline, as two integers.
 *
 * **The bar was drawn once, declared successor-owned, and then drawn by nobody.**
 * `0f4f7acc8` gave the statusline a lifecycle bar in the dev bundle's themed
 * renderer; `911f83b66` deleted that renderer on the claim that "the Worker rows
 * are the daemon renderer's". The daemon renderer draws `wid`, `iss` and `hb`
 * and has never drawn a bar — the same cutover-to-a-successor-that-did-not-exist
 * defect PR #4274 found for the Bedrock. This module is the successor arriving.
 *
 * **A position, never a picture.** The glyphs, the cursor and the paint already
 * exist once in `./dashboard.js` (`progressBar`, `colourWorkerCell`), shared by
 * every density. What was missing is the only thing the daemon could not answer:
 * a Worker publishes a ticket STAGE on its pulse and no `phase_index`/
 * `phase_total`, so the numeric bar rendered empty for every live Worker. This
 * module turns the stage word into that pair and nothing else.
 *
 * **The mapping is a DECLARED TABLE, not a guess.** Two vocabularies exist and
 * both are already owned elsewhere: the macro phases the bar has always had five
 * cells for, and `TICKET_LOOP_STAGES` from `@reddb-io/worker`. Folding one into
 * the other in a table means a new stage lands as one row here rather than as a
 * silent misplacement of the cursor — and a stage NOBODY declared resolves to
 * `null`, which renders no bar at all. A bar of unknown position is worse than
 * no bar: it states a place in a pipeline this module cannot see.
 *
 * The stage a Worker publishes carries its own failure signal — the daemon's
 * demand turn appends `!` when the ticket stage reported `ok: false` — so the
 * cursor's colour is read off the same word as its position rather than from a
 * second channel that could disagree with it.
 *
 * PURE.
 */

/**
 * The five cells a lifecycle bar has, in order.
 *
 * These are the macro phases the deleted renderer drew and the dashboard's
 * `phase` column still spells; keeping them is what makes the rebuilt bar the
 * SAME bar rather than a second one beside it.
 */
export const REDSKILLED_MACRO_PHASES = [
  "setup",
  "coding",
  "validating",
  "merging",
  "done",
] as const;

export type RedskilledMacroPhase = (typeof REDSKILLED_MACRO_PHASES)[number];

/**
 * Every phase word a Worker may publish, folded onto its macro phase.
 *
 * Three vocabularies meet here and each row says which one it came from:
 *
 *   - `TICKET_LOOP_STAGES` (`@reddb-io/worker`) — what a native Worker pulses
 *     today. `publish` and `land` are ONE macro phase because the bar has five
 *     cells and both are the same answer to "where is this work": on its way to
 *     the trunk.
 *   - the macro phases themselves, so a project that already publishes them
 *     passes through instead of falling off the table.
 *   - the landing phases the deleted renderer folded into `merging`, kept
 *     verbatim so a bundle still spelling them keeps its cursor.
 *
 * Declared as data rather than as a `switch` so the guard tests can enumerate
 * it, and so adding a stage is one row rather than an edit to a control flow.
 */
export const REDSKILLED_PHASE_MACRO_TABLE: Readonly<Record<string, RedskilledMacroPhase>> = {
  // TICKET_LOOP_STAGES
  claim: "setup",
  implement: "coding",
  gate: "validating",
  publish: "merging",
  land: "merging",
  // the macro phases themselves
  setup: "setup",
  coding: "coding",
  validating: "validating",
  merging: "merging",
  done: "done",
  // the landing phases `0f4f7acc8` folded into `merging`
  "push-pr": "merging",
  merge: "merging",
  cascade: "merging",
};

/** Where one Worker stands, ready for the bar the dashboard already draws. */
export interface RedskilledLifecyclePosition {
  readonly macro: RedskilledMacroPhase;
  /** Completed cells ahead of the cursor. */
  readonly index: number;
  /** Always {@link REDSKILLED_MACRO_PHASES}.length — stated so the caller needs no import. */
  readonly total: number;
  /** The stage reported `ok: false`; the cursor turns to the failure glyph. */
  readonly failed: boolean;
}

/**
 * Resolve a published phase word to a bar position. PURE.
 *
 * `null` for an absent, empty or UNDECLARED word — the caller renders no bar.
 * The trailing `!` the daemon appends to a stage that reported `ok: false`
 * (`acp-demand-turn.ts`) is stripped before the lookup and returned as
 * {@link RedskilledLifecyclePosition.failed}, because a failed `gate` is still
 * at `gate`: losing its position to keep its alarm would tell the operator less.
 */
export function resolveLifecyclePosition(
  phase: string | null | undefined,
): RedskilledLifecyclePosition | null {
  if (phase == null) return null;
  const trimmed = phase.trim();
  if (trimmed === "") return null;
  const failed = trimmed.endsWith("!");
  const word = (failed ? trimmed.slice(0, -1) : trimmed).toLowerCase();
  const macro = REDSKILLED_PHASE_MACRO_TABLE[word];
  if (macro === undefined) return null;
  const total = REDSKILLED_MACRO_PHASES.length;
  const cell = REDSKILLED_MACRO_PHASES.indexOf(macro);
  // The TERMINAL phase has nothing ahead of it, so it completes the bar rather
  // than parking a cursor on the last cell: `done` with a step still to go would
  // draw the one state where there is no next step as though there were one.
  return { macro, index: cell === total - 1 ? total : cell, total, failed };
}
