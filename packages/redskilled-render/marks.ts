/**
 * marks — the one-character vocabulary every density shares.
 *
 * A mark is the cheapest thing a layout owns and the easiest to fork: a line
 * drawing `†` for a posed death while a table drew `x` would make an operator
 * learn two alphabets for one machine. They live here so that a density imports
 * a mark rather than spelling one.
 */

/**
 * The mark a known-by-name project carries, and the reason it carries one.
 *
 * `!` for the same reason the staleness mark has one: it is a state the operator
 * has to act on, not a detail, and it must survive being read at a glance next to
 * a Worker count that looks perfectly healthy. One word, because the head is the
 * part of the line that never degrades — a sentence here would push the Workers
 * off a narrow terminal to say something `project_status` says in full.
 */
export const UNREGISTERED_MARK = "!unregistered";

/** What a project with a recorded registration expiry carries. */
export const LAPSED_MARK = "!lapsed";

/** What a daemon that is not the current one appends to its version. */
export const ENGINE_BEHIND_MARK = "⇡";

/**
 * What a posed death is marked with — a dagger, and never a word.
 *
 * The head is the part of the line that never degrades, so a death has to fit
 * beside a Worker count on a narrow terminal; the class that follows is the
 * reason, and the lane holds the receipt.
 */
export const DEATH_MARK = "†";

/**
 * What a budget inside the reserved band is marked with, and what a spent one is.
 *
 * Two marks rather than one, because they call for opposite actions: inside the
 * band the machine is still landing work and refusing only convenience, and spent
 * means nothing goes out until the reset. A surface that drew one symbol for both
 * would make an operator read the sentence to learn which it was.
 */
export const BUDGET_BAND_MARK = "◐";
/** What a spent GitHub budget is marked with. */
export const BUDGET_SPENT_MARK = "◯";

/** The mark that says "this line belongs to the entry above it". */
export const LOG_LINE_MARK = "↳";

/** The one sentence an unreachable host renders as, at every density. */
export const REDSKILLED_RENDER_ABSENCE = "redskilled unreachable — Worker state unknown";
