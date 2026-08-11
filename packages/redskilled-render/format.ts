/**
 * format — the sentence-level primitives every density shares.
 *
 * **One spelling per figure, whatever draws it.** A line saying `14.4M` and a
 * table saying `14.36 MiB` for the same byte count is the drift this whole module
 * exists to end, so the formatters live once and are imported rather than
 * restated. They are the smallest pieces of layout there are, which is exactly
 * why four copies of them appeared before anyone noticed.
 *
 * PURE, to the last function: nothing here reads a clock, a directory or an
 * environment variable. **Colour is unconditional**: nothing here reads
 * `NO_COLOR` or probes a TTY, because a renderer that decides for itself is a
 * renderer that reads the world. A caller wanting a plain string calls
 * {@link stripAnsi} at its boundary.
 */
import { RESET } from "./palette.js";

/**
 * One SGR escape, matched whole. A colour is `\x1b[…m` and nothing else here
 * pretends to parse the wider CSI grammar: the palette emits SGR only, and a
 * measurement primitive that guessed at cursor moves would be measuring
 * something no line in this package carries.
 */
// eslint-disable-next-line no-control-regex
const SGR_GLOBAL = /\x1b\[[0-9;]*m/g;
/** The same pattern with a capture group, so `split` keeps the escapes as parts. */
// eslint-disable-next-line no-control-regex
const SGR_SPLIT = /(\x1b\[[0-9;]*m)/;
/** The same pattern anchored, to ask of one part whether it IS an escape. */
// eslint-disable-next-line no-control-regex
const SGR_WHOLE = /^\x1b\[[0-9;]*m$/;

/** A line with its colour removed — the plain string a colourless caller wants. PURE. */
export function stripAnsi(line: string): string {
  return line.replace(SGR_GLOBAL, "");
}

/**
 * Whether one SGR escape closes everything it could have opened.
 *
 * `\x1b[0m`, the bare `\x1b[m` and `\x1b[0;0m` all reset; `\x1b[39m` (default
 * foreground) does not, because it leaves a background standing. Reading it
 * loosely would be the expensive mistake — a line believed closed and not is a
 * terminal painted for every row that follows.
 */
function isReset(escape: string): boolean {
  const params = escape.slice(2, -1);
  return params.split(";").every((param) => param === "" || Number(param) === 0);
}

/**
 * The VISIBLE width: what the terminal draws, not what the string holds.
 *
 * An SGR escape occupies zero columns, so counting it is how a coloured line
 * "overflows" a budget it fits in — the degradation ladder drops detail nobody
 * was out of room for, and {@link clamp} cuts a line that never needed cutting.
 */
export function width(line: string): number {
  return [...stripAnsi(line)].length;
}

/**
 * A line cut to fit, with the cut made visible.
 *
 * The ellipsis is kept even at the tightest budget, because a line that ends
 * mid-word and says nothing about it reads as a shorter fact rather than as a
 * truncated one.
 *
 * **The cut lands between columns, never inside an escape, and always closes
 * what it opened.** Both halves of that are the same failure: a truncation that
 * splits a truecolor escape mid-parameters leaves the terminal reading the
 * severed tail as text, and one that swallows the terminator leaves every
 * subsequent row painted. The budget is spent on visible columns alone, so the
 * escapes that survive cost nothing against it.
 */
export function clamp(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (width(line) <= maxWidth) return line;
  if (maxWidth === 1) return "…";
  const budget = maxWidth - 1;
  let visible = 0;
  let opened = false;
  let cut = "";
  for (const part of line.split(SGR_SPLIT)) {
    if (part === "") continue;
    if (SGR_WHOLE.test(part)) {
      cut += part;
      opened = !isReset(part);
      continue;
    }
    for (const char of part) {
      if (visible === budget) return `${cut}…${opened ? RESET : ""}`;
      cut += char;
      visible += 1;
    }
  }
  return `${cut}…${opened ? RESET : ""}`;
}

/** One cell padded to a column width, counting columns the terminal draws. PURE. */
export function pad(text: string, target: number): string {
  return text + " ".repeat(Math.max(0, target - width(text)));
}

/**
 * A model identifier shortened to its family and human-readable version. PURE.
 *
 * Provider prefixes and trailing date stamps cost columns without identifying
 * the model: `claude-opus-4-8` → `opus-4.8`, `Opus` → `opus`, and
 * `claude-haiku-4-5-20251001` → `haiku-4.5`. An unrecognised model falls
 * through unchanged rather than rendering as nothing.
 */
export function shortModel(model: string): string {
  const lower = model.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku", "fable"]) {
    const familyIndex = lower.indexOf(family);
    if (familyIndex === -1) continue;

    const suffix = lower.slice(familyIndex + family.length);
    const version = suffix.match(/^-(\d+(?:[-.]\d+)*)/)?.[1]?.split(/[-.]/) ?? [];
    if (/^\d{8}$/.test(version.at(-1) ?? "")) version.pop();
    return version.length === 0 ? family : `${family}-${version.join(".")}`;
  }
  return model;
}

/**
 * Bytes at statusline resolution: three significant characters, never more.
 *
 * Exactness is the payload's job. A line that read `1.234567G` would spend the
 * width it does not have on precision nobody acts on.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "K", "M", "G", "T"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rendered = value >= 100 || unit === 0 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${rendered}${units[unit]}`;
}

/** A count at dashboard resolution: at most one decimal, no trailing `.0`. PURE. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const scale = (scaled: number, suffix: string): string => {
    const text = (Math.round(scaled * 10) / 10).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}${suffix}`;
  };
  if (value >= 1e9) return scale(value / 1e9, "B");
  if (value >= 1e6) return scale(value / 1e6, "M");
  if (value >= 1e3) return scale(value / 1e3, "k");
  return String(Math.round(value));
}

/**
 * A rate at dashboard resolution, keeping the digit that survives rounding. PURE.
 *
 * `formatCount` rounds a small figure to a whole number, which turns a real
 * `0.4 issues/hour` into a `0` indistinguishable from an idle machine — the one
 * confusion every surface here exists to prevent. Below ten the first decimal is
 * kept; above it the count formatting takes over, because nobody reads the tenth
 * of a thousand tokens per minute.
 */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 10) return formatCount(value);
  if (value <= 0) return "0";
  const text = (Math.round(value * 10) / 10).toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** An elapsed span in the two most significant units; `—` when unstated. PURE. */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** An age in whole seconds, the way every density states one. PURE. */
export function formatAgeSeconds(ageMs: number | null): string | null {
  if (ageMs == null || !Number.isFinite(ageMs)) return null;
  return `${Math.round(ageMs / 1000)}s`;
}

/**
 * A published line reduced to something that fits on one row. PURE.
 *
 * Whitespace — a newline included — is collapsed rather than escaped, and control
 * characters are dropped: the daemon stored the string a Worker published
 * verbatim, and this is the last moment before it becomes a terminal's line.
 * Returns `null` when nothing survives, which is the same absence as no publish.
 */
export function flattenPublishedLine(line: string | null | undefined): string | null {
  if (line == null) return null;
  const collapsed = line
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed === "" ? null : collapsed;
}
