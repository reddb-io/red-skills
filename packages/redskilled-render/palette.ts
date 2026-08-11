/**
 * palette — the brand role table, derived once from published tokens.
 *
 * **Every colour here is a published brand token** (ADR 0137): the constant
 * names are ROLES this render grammar owns; the values come from
 * `@reddb-io/brand-tokens`, the vendored derivation of `reddb-io/brand`'s
 * `tokens.json`. A surface that wants a colour asks for one of these roles; a
 * surface that mints its own SGR has forked the identity — the truecolor
 * extinction ratchet sweeps this package to hold that line.
 *
 * The role grammar (ADR 0137 decision 3): the project block is the one brand
 * field (`brand.primary` ground, `brand.on-primary` ink) because identity is
 * its subject; the model block recedes to `neutral.900`/paper; the transparent
 * zone is a neutral hierarchy (paper keys, `neutral.400` soft, `neutral.500`
 * dim, terminal-default values); the lifecycle bar is a pure intensity ramp;
 * and `red.500` is the ONE spotlight, spent on failure alone.
 *
 * **Colour is unconditional.** Nothing here reads `NO_COLOR`, probes `isTTY` or
 * sniffs an environment — the whole package is pure, and a renderer that decides
 * for itself whether to paint is a renderer that reads the world. A caller that
 * wants a plain string strips it at its own boundary with `stripAnsi`.
 */

import { tokenToAnsiBackground, tokenToAnsiForeground } from "@reddb-io/brand-tokens";

// ---------- identity zone ----------

/** The brand field: the project block's ground. Identity is the subject there. */
export const IDENTITY_BG = tokenToAnsiBackground("brand.primary");
/** Ink read against {@link IDENTITY_BG} — everything on the brand field wears it. */
export const IDENTITY_INK = tokenToAnsiForeground("brand.on-primary");
/** The receded second field: the model block, and state highlights that borrow it. */
export const MODEL_BG = tokenToAnsiBackground("neutral.900");
/** Ink read against {@link MODEL_BG}. */
export const PAPER = tokenToAnsiForeground("paper");

// ---------- transparent zone ----------

/** The `k` of every `k=v`: paper, near-white, high contrast. */
export const KEY = tokenToAnsiForeground("paper");
/** The `v` of every `k=v`: the terminal's own default foreground, deliberately. */
export const VAL = "\x1b[39m";
/** General transparent-zone text — runners, sigils, the bare phase cell. */
export const SOFT = tokenToAnsiForeground("neutral.400");
/** Recessed labels: ages, versions, the quiet half of a fact. Transparent zone
 * ONLY — `neutral.500` has no contrast against {@link IDENTITY_BG}. */
export const DIM = tokenToAnsiForeground("neutral.500");

// ---------- the lifecycle bar's intensity ramp ----------
//
// Three steps of the neutral ramp read as intensity: current is brightest,
// completed settles, future recedes. NOT a green/yellow traffic light (the
// brand publishes no feedback colours) and NOT brand red — ADR 0137 rejected a
// brand-red bar because the bar is rhythm, not a call for attention.

/** Completed cells: settled. */
export const BAR_DONE = tokenToAnsiForeground("neutral.300");
/** The healthy cursor: the brightest step in the ramp. */
export const BAR_CURRENT = tokenToAnsiForeground("neutral.0");
/** Future cells: receded. */
export const BAR_AHEAD = tokenToAnsiForeground("neutral.700");

// ---------- the one saturated tone ----------

/**
 * The failure cursor, and only that.
 *
 * `red.500` is the brand's one "look here". Spending it on anything routine
 * spends the contrast that makes a failure read at a glance.
 */
export const SPOTLIGHT = tokenToAnsiForeground("red.500");

// ---------- structure, not identity ----------

/** Drop the background to the terminal default — the start of the transparent zone. */
export const NOBG = "\x1b[49m";
/** Close everything. A line that opened a colour and did not reset paints every row after it. */
export const RESET = "\x1b[0m";
/** Bold on, and off — the emphasis a tone should not be spent on. */
export const BOLD = "\x1b[1m";
export const NOBOLD = "\x1b[22m";
