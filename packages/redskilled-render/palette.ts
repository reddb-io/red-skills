/**
 * palette — the wine identity family, stated once.
 *
 * **The family was chosen, not re-picked here.** Every tone below is lifted
 * verbatim from `apps/dev/src/core/statusline-style.ts`, the renderer this
 * package replaces, because two palettes for one product is exactly the drift
 * this package exists to end. A surface that wants a colour asks for one of
 * these; a surface that mints its own has forked the identity.
 *
 * **Colour is unconditional.** Nothing here reads `NO_COLOR`, probes `isTTY` or
 * sniffs an environment — the whole package is pure, and a renderer that decides
 * for itself whether to paint is a renderer that reads the world. A caller that
 * wants a plain string strips it at its own boundary with `stripAnsi`.
 *
 * PURE: string constants and nothing else.
 */

/**
 * One SGR escape from its parameters.
 *
 * Deliberately NOT exported: a palette whose helper is public is a palette
 * anyone can extend at the call site, which is the second palette arriving under
 * another name. Add a tone here, with a role, or use one that exists.
 */
const sgr = (params: string): string => `\x1b[${params}m`;

// ---------- identity zone ----------

/** Identity-zone background, the model block. */
export const WINE = sgr("48;2;114;47;55");
/** Identity-zone background, the project block — a half-step darker than {@link WINE}. */
export const WINE2 = sgr("48;2;88;36;42");
/** Identity-zone text, read against the two wine backgrounds. */
export const WHITE = sgr("38;2;255;255;255");
/** Version and branch: the identity zone's quieter half. */
export const DIM = sgr("38;2;201;150;158");

// ---------- transparent zone ----------

/** The `k` of every `k=v`: very light red, near-white, high contrast. */
export const KEY = sgr("38;2;255;214;214");
/** The `v` of every `k=v`: the terminal's own default foreground, deliberately. */
export const VAL = sgr("39");
/** General transparent-zone text — runners, sigils, the bare phase cell. */
export const SOFT = sgr("38;2;224;138;148");
/** The `»` identity accent. */
export const GOLD = sgr("38;2;240;200;120");

// ---------- the lifecycle bar's wine ramp ----------
//
// Three steps of the same family, so the bar reads as part of the identity zone
// instead of a green/yellow traffic light — a deliberate decision (`0befc448e`),
// not an oversight to be "fixed" by reintroducing one.

/** Completed cells: full-bodied red. */
export const BAR_DONE = sgr("38;2;240;110;120");
/** The healthy cursor: the brightest pale pink in the ramp. */
export const BAR_CURRENT = sgr("38;2;255;214;214");
/** Future cells: receded dark wine. */
export const BAR_AHEAD = sgr("38;2;146;84;94");

// ---------- the one saturated tone ----------

/**
 * The failure cursor, and only that.
 *
 * The single tone hotter than the wine family, which is what makes it read as a
 * failure at a glance. Spending it on anything routine spends the contrast.
 */
export const RED = sgr("38;2;255;95;95");

// ---------- structure, not identity ----------

/** Drop the background to the terminal default — the start of the transparent zone. */
export const NOBG = sgr("49");
/** Close everything. A line that opened a colour and did not reset paints every row after it. */
export const RESET = sgr("0");
/** Bold on, and off — the emphasis a tone should not be spent on. */
export const BOLD = sgr("1");
export const NOBOLD = sgr("22");
