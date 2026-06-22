// core/statusline-style.ts — the ANSI styling slice for the /afk statusline.
//
// core/statusline.ts is deliberately PURE plain-text. This sibling adds the
// optional "high-tech" theme the pure renderer leaves out: the whole line on a
// wine-red background in white, with every AFK KPI *number* drawn as a black
// chip (black background, white text) so the live counts pop against the wine.
//
// The chip is the terminal-feasible stand-in for a bordered badge: ANSI cannot
// draw a box around inline characters, so a reversed-contrast black chip is the
// closest "negative" highlight. Labels (wk/rq/#/…) stay on the wine field; only
// the value the eye tracks gets the chip.
//
// Everything here is PURE (input object → string). The IO half
// (commands/statusline.ts) decides whether to call this (colour on) or the
// plain renderProjectBlock/renderStatusline path (colour off, e.g. NO_COLOR).

import {
  afkTokens,
  renderContextBlock,
  renderModelBlock,
  renderProjectBlock,
  renderStatusline,
  type AfkInput,
  type StatuslineInput,
} from "./statusline.js";

/** Truecolor SGR helpers. Wine-red is `#722F37`; chips are pure black. */
const WINE_BG = "\x1b[48;2;114;47;55m";
const BLACK_BG = "\x1b[48;2;0;0;0m";
const WHITE_FG = "\x1b[38;2;255;255;255m";
const RESET = "\x1b[0m";

/**
 * Wrap a KPI value as a black chip, then restore the wine field so following
 * text stays on the line background. The foreground is already white from the
 * line wrapper, so the chip only toggles the background.
 */
function chip(value: string): string {
  return `${BLACK_BG}${value}${WINE_BG}`;
}

/**
 * The AFK block with each KPI value chipped. Shares {@link afkTokens} with the
 * plain renderer, so the mnemonics and emit order never drift. Empty string
 * when there are no live workers (caller drops the section).
 */
export function styleAfkBlock(afk: AfkInput | undefined): string {
  const tokens = afkTokens(afk);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t.label}${chip(t.value)}${t.suffix}`).join(" ");
}

/**
 * Assemble the full statusline with the high-tech theme: project / model /
 * context blocks plain on the wine field, the AFK block with chipped KPI
 * numbers, joined by ` · ` and wrapped in one wine-red/white run terminated by
 * a reset. Block presence and order match {@link renderStatusline} exactly, so
 * colour only ever changes how the line looks, never which sections appear.
 */
export function styleStatusline(input: StatuslineInput): string {
  const sections: string[] = [renderProjectBlock(input.project)];
  const model = renderModelBlock(input.claude);
  if (model !== null) sections.push(model);
  const context = renderContextBlock(input.claude);
  if (context !== null) sections.push(context);
  const afk = styleAfkBlock(input.afk);
  if (afk !== "") sections.push(afk);
  return `${WINE_BG}${WHITE_FG}${sections.join(" · ")}${RESET}`;
}

/**
 * Render the statusline, themed or plain. `color` is the single switch: true →
 * {@link styleStatusline} (ANSI), false → {@link renderStatusline} (the exact
 * plain line, for NO_COLOR / non-terminal consumers).
 */
export function renderStatuslineThemed(input: StatuslineInput, color: boolean): string {
  return color ? styleStatusline(input) : renderStatusline(input);
}
