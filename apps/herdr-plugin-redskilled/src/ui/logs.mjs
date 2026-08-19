/**
 * logs — the two log surfaces this plugin can show, drawn the same way.
 *
 * A Worker's log is the project's own file, tailed from the path the daemon was
 * handed at spawn. The host event lane is the daemon's own memory: birth, death
 * and budget-kill, and nothing else (ADR 0130 rule 8). They are different
 * authorities on purpose — the first says what the work is doing, the second
 * says what the machine did to it — and this view keeps them apart rather than
 * interleaving them into one stream nobody owns.
 *
 * PURE.
 */
import { displayWidth, padEnd, padStart, style, truncate } from "./ansi.mjs";
import { ago, bytes, duration } from "./format.mjs";

function rule(label, columns) {
  const text = label ? ` ${label} ` : "";
  return style.gray(`─${text}${"─".repeat(Math.max(0, columns - displayWidth(text) - 1))}`);
}

/** Colour a log line by the level it announces, and by nothing else. PURE. */
export function colourLogLine(line) {
  if (/\b(error|fatal|refused|failed|panic)\b/i.test(line)) return style.red(line);
  if (/\b(warn|warning|degraded|stale|retry)\b/i.test(line)) return style.bold(line);
  if (/\b(ok|done|passed|merged|landed|green)\b/i.test(line)) return style.dim(line);
  return line;
}

/** One host event as a row: what happened, to whom, and how it ended. PURE. */
export function renderEventRow(record, { columns }) {
  if (record._undecoded) return style.gray(truncate(`   ${record._raw}`, columns));

  const at = typeof record.ts === "string" ? record.ts.slice(11, 19) : "--:--:--";
  const kind =
    record.event === "worker-birth"
      ? style.dim(padEnd("+ birth", 13))
      : record.event === "worker-budget-kill"
        ? style.red(padEnd("! budget-kill", 13))
        : style.bold(padEnd("† death", 13));

  const ending =
    record.event === "worker-birth"
      ? style.gray(`pid ${record.pid ?? "—"}${record.unit ? ` · ${record.unit}` : " · no unit"}`)
      : record.signal
        ? style.red(`! signal ${record.signal}`)
        : record.exit_code === 0
          ? style.dim("exit 0")
          : record.exit_code == null
            ? style.gray("exit —")
            : style.red(`! exit ${record.exit_code}`);

  const detail = record.detail ? ` ${style.gray("·")} ${style.dim(String(record.detail))}` : "";

  return truncate(
    `   ${style.gray(at)} ${kind} ${padEnd(truncate(String(record.worker_id ?? "?"), 14), 14)}` +
      ` ${padEnd(truncate(String(record.project_label ?? "—"), 26), 26)} ${ending}${detail}`,
    columns,
  );
}

/**
 * One frame of a log view. PURE.
 *
 * `offset` counts rows back from the newest line, so following is `offset === 0`
 * and scrolling up simply stops following. Storing the anchor at the end rather
 * than the start is what keeps a growing file from sliding under the reader.
 */
export function renderLogView({ title, subtitle, lines, offset, follow, size, empty, render = colourLogLine }) {
  const { columns, rows } = size;
  const head = [
    truncate(` ${style.bold(style.identity("red-skills"))} ${style.gray("·")} ${style.bold(title)}`, columns),
    truncate(` ${style.gray(subtitle)}`, columns),
    rule(null, columns),
  ];
  // The follow badge leads the footer rather than closing it: on a narrow pane
  // the key map is what gets truncated, and "am I still tailing this" is the one
  // fact a reader must never lose to the width.
  const foot = [
    rule(null, columns),
    truncate(
      ` ${follow ? style.dim("● following") : style.red("▲ paused")}` +
        `  ${style.bold("q")} ${style.gray("back")}  ${style.bold("f")} ${style.gray(follow ? "unfollow" : "follow")}` +
        `  ${style.bold("j/k")} ${style.gray("scroll")}  ${style.bold("g/G")} ${style.gray("top/end")}` +
        `  ${style.bold("r")} ${style.gray("refresh")}`,
      columns,
    ),
  ];

  const height = Math.max(1, rows - head.length - foot.length);
  if (lines.length === 0) {
    return [...head, truncate(` ${style.gray(empty)}`, columns), ...Array(Math.max(0, height - 1)).fill(""), ...foot];
  }

  const end = Math.max(0, lines.length - offset);
  const start = Math.max(0, end - height);
  const page = lines.slice(start, end).map((line) => truncate(render(line, { columns }), columns));
  while (page.length < height) page.push("");
  return [...head, ...page, ...foot];
}

/** The subtitle for a Worker's log: whose it is, and what state it is in. PURE. */
export function workerLogSubtitle(worker, tail) {
  if (!worker) return "no Worker selected";
  const where = tail?.exists
    ? `${tail.path}${tail.truncated ? style.gray(" (tail)") : ""} · ${bytes(tail.size)}`
    : worker.workspace_path
      ? style.red(`⚠ no readable log — the client declared ${tail?.path ? tail.path : "none"} at spawn`)
      : style.red("⚠ no log path was declared for this Worker");
  return `${worker.worker_id} · ${worker.project_label} · up ${duration(worker.uptime_ms)} · ${where}`;
}
