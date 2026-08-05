/**
 * ansi — colour, and the width of text once colour is taken back out.
 *
 * Every layout decision in this plugin is made on `displayWidth`, never on
 * `String.length`: a styled cell is longer in bytes than it is on screen, and a
 * table padded by byte length is a table that drifts one column further right
 * with every colour added to it.
 */
import { tokenToAnsiForeground } from "@reddb-io/brand-tokens";

const enabled = !process.env.NO_COLOR && process.env.TERM !== "dumb";

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
  red: 31,
  white: 37,
  gray: 90,
};

/** The escape byte, written once here so no other module carries a raw one. */
export const ESC = "\u001b";

/** The bell byte, which terminates an OSC sequence. */
export const BEL = "\u0007";

function wrap(code) {
  return (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text));
}

function wrapAnsi(open) {
  return (text) => (enabled ? `${open}${text}\u001b[0m` : String(text));
}

export const style = {
  ...Object.fromEntries(Object.entries(CODES).map(([name, code]) => [name, wrap(code)])),
  // Identity is the only truecolor moment in a pane. The sequence and its value
  // both come from the package; this surface owns neither a copied hex nor an
  // ANSI derivation of its own.
  identity: wrapAnsi(tokenToAnsiForeground("brand.primary")),
};

export const colorEnabled = enabled;

const ANSI = /\u001b\[[0-9;]*m/g;

/** The text with every SGR sequence removed. PURE. */
export function stripAnsi(text) {
  return String(text).replace(ANSI, "");
}

/** How many columns the text occupies once styling is discounted. PURE. */
export function displayWidth(text) {
  return stripAnsi(text).length;
}

/** Pad to `width` columns, measuring the visible text. PURE. */
export function padEnd(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}

/** Right-align inside `width` columns, measuring the visible text. PURE. */
export function padStart(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${" ".repeat(gap)}${text}` : text;
}

/**
 * Cut to `width` columns without cutting an escape sequence in half. PURE.
 *
 * Styled text is truncated by walking the visible characters and carrying the
 * sequences along, then closing with a reset: a naive slice can end mid-escape
 * and paint the rest of the pane in whatever colour it happened to open.
 */
export function truncate(text, width) {
  if (width <= 0) return "";
  const raw = String(text);
  if (displayWidth(raw) <= width) return raw;

  let visible = 0;
  let out = "";
  let index = 0;
  let styled = false;
  while (index < raw.length && visible < width - 1) {
    if (raw[index] === "\u001b") {
      const match = /^\u001b\[[0-9;]*m/.exec(raw.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        styled = true;
        continue;
      }
    }
    out += raw[index];
    index += 1;
    visible += 1;
  }
  return `${out}…${styled && enabled ? "\u001b[0m" : ""}`;
}
