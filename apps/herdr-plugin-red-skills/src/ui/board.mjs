/**
 * board — the statusline, given a pane's height. This file PRINTS.
 *
 * **Every cell on this screen was computed elsewhere.** The header, the Worker
 * rows, the pipeline bars and the counts all arrive finished from
 * `statusline-dashboard`, and behind that op sits `@reddb-io/redskilled-render`
 * — one layout, drawn at parameterized densities (ADR 0132 decision 1). Nothing
 * here recomputes a cell: a herdr pane and an editor panel each doing their own
 * Worker math would be two dashboards lying in two different ways about the same
 * instant.
 *
 * **The only judgement here is where a line goes.** Colour, the scroll window and
 * the key map belong to a terminal and to nothing else, so they live here; the
 * text does not, so it does not. A reader looking for why a number reads the way
 * it does will not find the answer in this file, which is correct — the answer is
 * in the daemon.
 *
 * PURE: every input is passed in, so a frame can be asserted without a daemon.
 */
import { displayWidth, style, truncate } from "./ansi.mjs";

/** How the daemon's `key=value` cells are tinted: light key, default value. */
function paintCell(cell) {
  const equals = cell.indexOf("=");
  if (equals <= 0) return cell;
  return `${style.gray(cell.slice(0, equals + 1))}${cell.slice(equals + 1)}`;
}

/**
 * One row line, tinted without being re-laid-out. PURE.
 *
 * The daemon's alignment survives because the tint is applied per WHITESPACE-
 * SEPARATED RUN and adds no visible character: a pane that re-padded the row
 * would be deciding a column width the daemon already decided, and the two would
 * drift the first time either changed.
 */
export function paintRow(line) {
  return line
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : paintCell(part)))
    .join("");
}

function rule(label, columns) {
  const text = label ? ` ${label} ` : "";
  const width = Math.max(0, columns - displayWidth(text) - 1);
  return style.gray(`─${text}${"─".repeat(width)}`);
}

/** The key map, which is the only documentation a pane can carry. PURE. */
export function renderBoardFooter({ columns, state }) {
  const keys = [
    ["q", "quit"],
    ["r", "refresh"],
    ["g", state.mode === "global" ? "local" : "global"],
  ];
  const map = keys.map(([key, label]) => `${style.bold(key)} ${style.gray(label)}`).join("  ");
  return [rule(null, columns), truncate(` ${map}`, columns)];
}

/** What to draw when nothing answered — an absence, said plainly. PURE. */
export function renderBoardAbsence({ columns, error, socketPath }) {
  return [
    rule("NO HOST ANSWERED", columns),
    truncate(` ${style.gray("socket")} ${style.white(socketPath ?? "?")}`, columns),
    "",
    truncate(` ${style.gray(error ?? "the daemon did not answer")}`, columns),
    "",
    truncate(
      ` ${style.gray("An empty host must mean an idle machine, never a failed lookup — so this pane")}`,
      columns,
    ),
    truncate(` ${style.gray("refuses to draw a table it did not read.")}`, columns),
    "",
    truncate(
      ` ${style.gray("Bring one up with")} ${style.white("redskilled provision")}${style.gray(".")}`,
      columns,
    ),
  ];
}

/**
 * One frame of the board. PURE.
 *
 * The daemon was already told the width and the row budget, so what arrives
 * fits; the clamp here is a belt against a pane resized between the read and the
 * paint, never a second layout.
 */
export function renderBoard({ dashboard, state, size, socketPath, error }) {
  const { columns } = size;
  if (!dashboard) {
    return [
      ` ${style.bold(style.brightRed("redskilled"))} ${style.gray("·")} ${style.brightRed("no host answered")}`,
      ...renderBoardAbsence({ columns, error, socketPath }),
      ...renderBoardFooter({ columns, state }),
    ];
  }

  const [header, ...rows] = dashboard.lines;
  const badge = dashboard.stale ? style.brightYellow("● stale") : style.brightGreen("● live");
  const lines = [
    truncate(` ${style.bold(style.brightRed(header ?? ""))}`, columns),
    truncate(` ${badge} ${style.gray(dashboard.generated_at)}`, columns),
    rule("WORKERS", columns),
  ];

  if (rows.length === 0) {
    lines.push(
      ` ${style.gray("no Workers here — the machine is idle, and this is the daemon saying so")}`,
    );
  } else {
    for (const row of rows) lines.push(truncate(` ${paintRow(row)}`, columns));
  }

  if (state.message) lines.push(truncate(` ${style.brightCyan(state.message)}`, columns));
  lines.push(...renderBoardFooter({ columns, state }));
  return lines;
}
