/**
 * format — the numbers the daemon states, rendered the way an operator reads them.
 *
 * **An absence is never a zero.** `redskilled` is careful to send `null` for a
 * Worker nothing measured, and every helper here keeps that distinction: an
 * unmeasured Worker renders as `—`, never as `0 B`, because "nothing measured it"
 * and "it is using nothing" are opposite facts about a busy machine.
 */
import { style } from "./ansi.mjs";

const UNITS = ["B", "K", "M", "G", "T"];

/** Bytes at three significant columns, or `—` when there is no number. PURE. */
export function bytes(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = scaled >= 100 || unit === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)}${UNITS[unit]}`;
}

/** A duration as the largest two units that matter. PURE. */
export function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

/** How long ago an instant was, from a payload that dated itself. PURE. */
export function ago(iso, now = Date.now()) {
  if (typeof iso !== "string") return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return `${duration(Math.max(0, now - ms))} ago`;
}

/** A percentage, or `—`. PURE. */
export function percent(fraction) {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

/**
 * A meter for a fraction, coloured by how close it is to its ceiling. PURE.
 *
 * An unknown fraction draws an empty track rather than a full or an absent one:
 * a bar is read at a glance, and both alternatives read as a fact.
 */
export function meter(fraction, width = 12) {
  const track = Math.max(4, width);
  if (fraction == null || !Number.isFinite(fraction)) return style.gray("░".repeat(track));
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * track);
  const bar = `${"█".repeat(filled)}${"░".repeat(track - filled)}`;
  if (clamped >= 0.9) return style.brightRed(bar);
  if (clamped >= 0.7) return style.yellow(bar);
  return style.green(bar);
}

/** A count, or an em dash when the daemon deliberately sent no number. PURE. */
export function count(value) {
  return value == null || !Number.isFinite(value) ? "—" : String(value);
}

/**
 * A rate at pane resolution — `1.2k`, `8.4`, `0.2`; `—` when unmeasured. PURE.
 *
 * The first decimal is kept below ten because rounding it away turns a real
 * `0.4 issues/hour` into a `0` no reader can tell from an idle machine, which is
 * the one confusion every absence rule in this pane exists to prevent.
 */
export function rate(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value <= 0) return "0";
  if (value >= 1000) {
    const scaled = value >= 1e6 ? value / 1e6 : value / 1e3;
    const suffix = value >= 1e6 ? "M" : "k";
    return `${trim((Math.round(scaled * 10) / 10).toFixed(1))}${suffix}`;
  }
  if (value >= 10) return String(Math.round(value));
  return trim((Math.round(value * 10) / 10).toFixed(1));
}

function trim(text) {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** One line of text with its newlines and control characters flattened. PURE. */
export function oneLine(text) {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\r\n\t]+/g, " ").trim();
}
