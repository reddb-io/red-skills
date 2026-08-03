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
 * environment variable.
 */

/** The visible width. One character is one column here — no line carries ANSI. */
export function width(line: string): number {
  return [...line].length;
}

/**
 * A line cut to fit, with the cut made visible.
 *
 * The ellipsis is kept even at the tightest budget, because a line that ends
 * mid-word and says nothing about it reads as a shorter fact rather than as a
 * truncated one.
 */
export function clamp(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const chars = [...line];
  if (chars.length <= maxWidth) return line;
  if (maxWidth === 1) return "…";
  return `${chars.slice(0, maxWidth - 1).join("")}…`;
}

/** One cell padded to a column width. PURE. */
export function pad(text: string, target: number): string {
  return text + " ".repeat(Math.max(0, target - width(text)));
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
