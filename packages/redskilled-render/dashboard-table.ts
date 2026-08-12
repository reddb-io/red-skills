/** Responsive table projection for the dashboard density. */
import type { RedskilledRenderWorker } from "./payload.js";

/** The terminal-width layout selected by the shared renderer, never by a surface. */
export type RedskilledDashboardTableVariant = "compact" | "operational";

export interface RedskilledDashboardTableColumn {
  readonly key: string;
  readonly header: string;
  readonly width?: number;
  readonly minWidth?: number;
  readonly flex?: number;
  readonly align?: "left" | "center" | "right";
  readonly truncate?: boolean;
}

/** A semantic table projection that terminal and editor surfaces can paint. */
export interface RedskilledDashboardTable {
  readonly variant: RedskilledDashboardTableVariant;
  readonly columns: readonly RedskilledDashboardTableColumn[];
  readonly rows: readonly Record<string, string>[];
}

interface DashboardTableSourceRow {
  readonly cells: {
    readonly wid: string;
    readonly run: string;
    readonly iss: string;
    readonly bar: string;
    readonly phase: string;
    readonly elapsed: string;
    readonly eta: string;
    readonly hb: string;
  };
}

const OPERATIONAL_TABLE_MIN_WIDTH = 110;

function withoutCellPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function presentCells(...values: readonly (string | null | undefined)[]): string {
  const joined = values.filter((value): value is string => value != null && value !== "").join(" · ");
  return joined === "" ? "—" : joined;
}

/** Choose and populate the table hierarchy from the already-decided Worker cells. PURE. */
export function dashboardTable(
  rows: readonly DashboardTableSourceRow[],
  workers: readonly RedskilledRenderWorker[],
  maxWidth: number,
): RedskilledDashboardTable {
  if (maxWidth < OPERATIONAL_TABLE_MIN_WIDTH) {
    return {
      variant: "compact",
      columns: [
        { key: "worker", header: "Worker", flex: 2, minWidth: 16, truncate: true },
        { key: "work", header: "Work", flex: 2, minWidth: 14, truncate: true },
        { key: "state", header: "State", flex: 2, minWidth: 14, truncate: true },
        { key: "activity", header: "Latest activity", flex: 3, minWidth: 18, truncate: true },
      ],
      rows: rows.map((row, index) => ({
        worker: row.cells.wid,
        work: presentCells(withoutCellPrefix(row.cells.iss, "iss="), row.cells.phase),
        state: presentCells(row.cells.bar, row.cells.elapsed, row.cells.eta),
        activity: presentCells(row.cells.hb, workers[index]?.log.last_line),
      })),
    };
  }

  return {
    variant: "operational",
    columns: [
      { key: "worker", header: "Worker", flex: 2, minWidth: 16, truncate: true },
      { key: "issue", header: "Issue", width: 7 },
      { key: "runner", header: "Runner", flex: 1, minWidth: 12, truncate: true },
      { key: "phase", header: "Phase", flex: 2, minWidth: 16, truncate: true },
      { key: "progress", header: "Progress", width: 9 },
      { key: "elapsed", header: "Clocks", width: 34, align: "right" },
      { key: "eta", header: "ETA", width: 8, align: "right" },
      { key: "activity", header: "Activity", flex: 2, minWidth: 16, truncate: true },
    ],
    rows: rows.map((row, index) => ({
      worker: row.cells.wid,
      issue: presentCells(withoutCellPrefix(row.cells.iss, "iss=")),
      runner: presentCells(withoutCellPrefix(row.cells.run, "run=")),
      phase: presentCells(row.cells.phase),
      progress: presentCells(row.cells.bar),
      elapsed: presentCells(row.cells.elapsed),
      eta: withoutCellPrefix(presentCells(row.cells.eta), "eta="),
      activity: presentCells(row.cells.hb, workers[index]?.log.last_line),
    })),
  };
}
