/**
 * panel — the middle density: a few rows, for a surface with height and no table.
 *
 * **A panel composes; it does not re-draw.** Its first row IS the statusline
 * line, produced by the line density, and its Worker rows are the dashboard's
 * identity columns without the table. That is the whole point of parameterizing
 * densities instead of shipping three renderers: a status-bar tooltip, a herdr
 * pane header and an editor hover want the same facts at three heights, and the
 * only thing that should differ between them is how many rows they may spend.
 *
 * **It is the density that fits where a table will not.** A `statusLine` entry
 * gets one row; a webview gets a screen; between them sits everything with four
 * to ten — a notification body, a tooltip, a narrow sidebar. Before this existed
 * those surfaces either printed the one-line render and lost the Workers, or
 * printed the dashboard and overflowed.
 *
 * PURE, like every other density: payload and options in, rows out.
 */
import {
  colourWorkerCell,
  isRepairWorker,
  workerCells,
  type RedskilledDashboardColumn,
} from "./dashboard.js";
import { clamp, formatBytes } from "./format.js";
import { BUDGET_BAND_MARK, BUDGET_SPENT_MARK, DEATH_MARK } from "./marks.js";
import { KEY, NOBG, RESET, SOFT, VAL } from "./palette.js";
import { type RedskilledRenderPayload, type RedskilledStatuslineMode } from "./payload.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  type RedskilledStatuslineRender,
} from "./line.js";
import { selectRenderProjects, selectRenderWorkers } from "./select.js";

export interface RedskilledPanelOptions {
  readonly mode: RedskilledStatuslineMode;
  /** The project this session belongs to; `null` when it declared none. */
  readonly project: string | null;
  /** The hard ceiling in characters. No row exceeds it. */
  readonly maxWidth: number;
  /** How many Worker rows may be drawn before the rest are counted instead. */
  readonly maxRows: number;
  /** Give each drawn Worker the last line it logged, under its own row. */
  readonly verbose: boolean;
}

export const REDSKILLED_PANEL_DEFAULTS: RedskilledPanelOptions = {
  mode: "local",
  project: null,
  maxWidth: 100,
  maxRows: 8,
  verbose: false,
};

/**
 * The panel, as rows plus the structure behind them.
 *
 * `head` is the whole statusline render rather than just its text, so a surface
 * showing one row and a surface showing eight read the same `detail`, the same
 * `project_match` and the same `stale` — three facts a consumer would otherwise
 * have to re-derive per density and would derive differently.
 */
export interface RedskilledPanel {
  readonly version: 1;
  readonly generated_at: string;
  readonly mode: RedskilledStatuslineMode;
  readonly project: string | null;
  readonly head: RedskilledStatuslineRender;
  /** One row per drawn Worker, identity first. */
  readonly worker_rows: readonly string[];
  /** One row per project, drawn only in `global` where they differ from the head. */
  readonly project_rows: readonly string[];
  /** Deaths, budget and staleness — what an operator must act on. */
  readonly notes: readonly string[];
  readonly lines: readonly string[];
  /** Workers the row budget left out — stated, never silently dropped. */
  readonly hidden_row_count: number;
  readonly stale: boolean;
}

/**
 * The finished panel. PURE — payload and options in, rows out.
 *
 * The head is asked for at the panel's own width and never at the line's default,
 * because a panel that showed a 120-column statusline inside an 80-column sidebar
 * would degrade in a place the operator cannot see.
 */
export function renderRedskilledPanel(
  payload: RedskilledRenderPayload,
  options: RedskilledPanelOptions = REDSKILLED_PANEL_DEFAULTS,
): RedskilledPanel {
  const head = renderRedskilledStatusline(payload, {
    ...REDSKILLED_STATUSLINE_DEFAULTS,
    mode: options.mode,
    project: options.project,
    maxWidth: options.maxWidth,
    // The head is a HEAD here: the Workers get rows of their own below it, and a
    // line that also listed them would say everything twice on a surface whose
    // whole advantage over the statusline is that it has somewhere else to put
    // them.
    maxWorkers: 0,
    maxProjects: 0,
    verbose: false,
  });

  const selected = selectRenderWorkers(payload, options);
  const visible = selected.slice(0, Math.max(0, Math.floor(options.maxRows)));
  const hidden = selected.length - visible.length;

  const workerRows: string[] = [];
  for (const worker of visible) {
    workerRows.push(clamp(`  ${workerRow(worker, options.mode, payload.generated_at)}`, options.maxWidth));
    if (!options.verbose) continue;
    const logged = worker.log.last_line == null ? null : worker.log.last_line.replace(/\s+/g, " ").trim();
    if (logged == null || logged === "") continue;
    workerRows.push(clamp(`    ${logged}`, options.maxWidth));
  }
  if (hidden > 0) {
    workerRows.push(clamp(`  … ${hidden} more Worker(s) — the row budget is short, not the host`, options.maxWidth));
  }

  // Only in `global`: the local mode holds one project by construction, and a row
  // repeating the head verbatim is a row that costs height and says nothing.
  const projectRows = options.mode === "global"
    ? selectRenderProjects(payload, options).map((project) =>
      clamp(
        `  ${project.project_label} ${project.worker_count}w ${formatBytes(project.observed_rss_bytes)}`,
        options.maxWidth,
      )
    )
    : [];

  const notes = panelNotes(payload, options);

  return {
    version: 1,
    generated_at: payload.generated_at,
    mode: options.mode,
    project: options.project,
    head,
    worker_rows: workerRows,
    project_rows: projectRows,
    notes,
    lines: [head.line, ...workerRows, ...projectRows, ...notes],
    hidden_row_count: Math.max(0, hidden),
    stale: payload.staleness.stale,
  };
}

/**
 * One Worker in a row: who it is, what it is doing, and what it costs. PURE.
 *
 * The phase and the elapsed span come first because a panel is read to answer
 * "is this one stuck", and the memory figure last because it is the fact the
 * head already carries in aggregate. The estimate follows the elapsed span for
 * the same reason, and is absent — not `eta=?` — whenever the project declined
 * to make one.
 */
function workerRow(
  worker: RedskilledRenderPayload["workers"][number],
  mode: RedskilledStatuslineMode,
  generatedAt: string,
): string {
  const cells = workerCells(worker, { mode }, generatedAt);
  const columns: readonly RedskilledDashboardColumn[] = isRepairWorker(worker)
    ? ["wid", "org", "iss", "bar", "phase", "base", "elapsed", "eta"]
    : ["wid", "bar", "phase", "base", "elapsed", "eta"];
  const parts = columns
    .filter((column) => cells[column] !== "")
    .map((column) => colourWorkerCell(column, cells[column]));
  const used = worker.vitals.rss_bytes;
  // An unmeasured Worker says so. A zero here would read as an idle Worker, and
  // "nothing measured it" and "it is using nothing" are opposite facts.
  parts.push(`${KEY}mem=${VAL}${used == null ? "?" : formatBytes(used)}${SOFT}`);
  return `${NOBG}${SOFT}${parts.join(" ")}${RESET}`;
}

/**
 * What an operator must act on, and nothing they need not. PURE.
 *
 * A healthy machine produces no notes at all — a panel that always ended in
 * `deaths 0 · quota open` would train the reader to stop looking at the last
 * rows, which is the one place these lines have to be seen.
 */
function panelNotes(
  payload: RedskilledRenderPayload,
  options: RedskilledPanelOptions,
): readonly string[] {
  const notes: string[] = [];
  const deaths = payload.deaths;
  if (deaths != null && deaths.count > 0 && deaths.latest != null) {
    notes.push(
      clamp(
        `${DEATH_MARK} ${deaths.count} posed death(s) — newest ${deaths.latest.sender_class}/` +
          `${deaths.latest.confidence} on pid ${deaths.latest.pid}`,
        options.maxWidth,
      ),
    );
  }
  const balance = payload.github_balance;
  if (balance != null && (balance.posture === "spent" || balance.posture === "reserved")) {
    const mark = balance.posture === "spent" ? BUDGET_SPENT_MARK : BUDGET_BAND_MARK;
    notes.push(clamp(`${mark} github budget ${balance.posture} — ${balance.reason}`, options.maxWidth));
  }
  if (payload.staleness.stale) {
    notes.push(clamp(`! ${payload.staleness.reason}`, options.maxWidth));
  }
  return notes;
}
