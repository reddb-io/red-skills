/**
 * format — the handful of numbers a tree row shows, rendered once.
 *
 * Here rather than beside each view, because "1.4G" and "1.40 GiB" appearing in
 * two rows of the same panel is the kind of drift nobody files a bug about and
 * everybody notices. PURE.
 */

/** Bytes as the compact binary unit an operator reads at a glance; `—` for absent. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const units = ["K", "M", "G", "T"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
}

/** A duration as the coarsest unit that still says something; `—` for absent. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/**
 * A rate at panel resolution — `1.2k`, `8.4`, `0.2`; `—` for absent.
 *
 * The first decimal is kept below ten because rounding it away turns a real
 * `0.4 issues/hour` into a `0` no reader can tell from an idle machine, which is
 * the one confusion every absence rule in these views exists to prevent.
 */
export function formatRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value <= 0) return "0";
  if (value >= 1000) {
    const scaled = value >= 1e6 ? value / 1e6 : value / 1e3;
    return `${trimZero((Math.round(scaled * 10) / 10).toFixed(1))}${value >= 1e6 ? "M" : "k"}`;
  }
  if (value >= 10) return String(Math.round(value));
  return trimZero((Math.round(value * 10) / 10).toFixed(1));
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** A 0..1 fraction as whole percent; `—` for absent. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

/** An ISO instant as wall-clock `HH:MM:SS`; the raw string when it will not parse. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().slice(11, 19);
}
