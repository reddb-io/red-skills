/**
 * The interactive terminal adapter for the pure redskilled dashboard.
 *
 * The daemon still owns facts and `@reddb-io/redskilled-render` still owns the
 * dashboard layout. Tuiuiu owns only the process-level terminal lifecycle:
 * one alternate screen, resize, input, incremental paint and cleanup. Keeping
 * those boundaries separate lets the CLI, Herdr and VS Code continue to draw
 * one answer without teaching the daemon about a terminal.
 */
import {
  Box,
  Text,
  render,
  useApp,
  useEffect,
  useInput,
  useInterval,
  useState,
  useTerminalSize,
  type VNode,
} from "tuiuiu.js/minimal";
import { Table, type TableColumn } from "tuiuiu.js/molecules";
import {
  stripAnsi,
  type RedskilledDashboard,
} from "@reddb-io/redskilled-render";

export interface RedskilledDashboardViewport {
  readonly columns: number;
  /** Rows available to the domain renderer; the TUI reserves its own footer. */
  readonly rows: number;
  readonly showDeathDetails: boolean;
}

export interface RedskilledDashboardTuiOptions {
  readonly readFrame: (
    viewport: RedskilledDashboardViewport,
  ) => Promise<RedskilledDashboardTuiFrame>;
  readonly initialShowDeathDetails: boolean;
  readonly refreshMs?: number;
  readonly noColor?: boolean;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

export interface RedskilledDashboardTuiFrame {
  readonly lines: readonly string[];
  readonly dashboard?: RedskilledDashboard;
}

export interface RedskilledDashboardFrameOptions {
  readonly frame: RedskilledDashboardTuiFrame;
  readonly columns: number;
  readonly rows: number;
  readonly showDeathDetails: boolean;
  readonly noColor?: boolean;
}

function paintedLine(line: string, noColor: boolean): VNode {
  return Text({ wrap: "truncate-end" }, noColor ? stripAnsi(line) : line);
}

function dashboardBody(
  dashboard: RedskilledDashboard,
  columns: number,
  noColor: boolean,
): VNode[] {
  if (dashboard.rows.length === 0 || dashboard.table == null) {
    return dashboard.lines.map((line) => paintedLine(line, noColor));
  }

  const firstWorkerIndex = dashboard.lines.indexOf(dashboard.rows[0]!.line);
  const lastWorkerIndex = dashboard.lines.lastIndexOf(dashboard.rows.at(-1)!.line);
  const before = firstWorkerIndex < 0 ? dashboard.lines : dashboard.lines.slice(0, firstWorkerIndex);
  const after = lastWorkerIndex < 0 ? [] : dashboard.lines.slice(lastWorkerIndex + 1);
  const tableColumns: TableColumn[] = dashboard.table.columns.map((column) => ({ ...column }));
  const tableRows = dashboard.table.rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, noColor ? stripAnsi(value) : value]),
  ));

  return [
    ...before.map((line) => paintedLine(line, noColor)),
    Table({
      columns: tableColumns,
      data: tableRows,
      borderStyle: "round",
      availableWidth: Math.max(1, columns - 1),
      maxWidth: Math.max(1, columns - 1),
      compact: true,
      rowSeparator: false,
      borderColor: noColor ? "" : "gray",
      headerStyle: { bold: !noColor, color: noColor ? "" : "cyan" },
      accessibilityLabel: `redskilled Workers — ${dashboard.table.variant} table`,
      striped: !noColor,
    }),
    ...after.map((line) => paintedLine(line, noColor)),
  ];
}

/** One complete frame, independently renderable for fixture tests. PURE. */
export function redskilledDashboardFrame(
  options: RedskilledDashboardFrameOptions,
): VNode {
  const columns = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(1, Math.floor(options.rows));
  const bodyRows = Math.max(0, rows - 1);
  const footer = `q quit · r refresh · v deaths: ${options.showDeathDetails ? "details" : "summary"} · live 1s`;
  const noColor = options.noColor === true;
  const body = options.frame.dashboard == null
    ? options.frame.lines.map((line) => paintedLine(line, noColor))
    : dashboardBody(options.frame.dashboard, columns, noColor);

  return Box(
    {
      flexDirection: "column",
      width: columns,
      height: rows,
      overflow: "hidden",
    },
    Box(
      {
        flexDirection: "column",
        width: columns,
        height: bodyRows,
        overflow: "hidden",
      },
      ...body,
    ),
    Text({ dim: !noColor, wrap: "truncate-end" }, footer),
  );
}

/**
 * Own the terminal for the lifetime of `redskilled dashboard`.
 *
 * There is deliberately one `render()` call. Starting a second renderer after
 * leaving a view races terminal teardown and can leave raw mode, the cursor or
 * the alternate screen behind. `useApp().exit()` lets Tuiuiu restore all three.
 */
export async function runRedskilledDashboardTui(
  options: RedskilledDashboardTuiOptions,
): Promise<void> {
  let inFlight = false;

  function App(): VNode {
    const app = useApp();
    const size = useTerminalSize();
    const [frame, setFrame] = useState<RedskilledDashboardTuiFrame>({
      lines: ["redskilled · connecting to host…"],
    });
    const [showDeathDetails, setShowDeathDetails] = useState(options.initialShowDeathDetails);

    const refresh = (): void => {
      if (inFlight) return;
      inFlight = true;
      void options
        .readFrame({
          columns: Math.max(1, size.columns || 80),
          rows: Math.max(1, (size.rows || 24) - 1),
          showDeathDetails: showDeathDetails(),
        })
        .then(setFrame)
        .catch((error: unknown) => {
          setFrame({
            lines: [`redskilled dashboard failed — ${error instanceof Error ? error.message : String(error)}`],
          });
        })
        .finally(() => {
          inFlight = false;
        });
    };

    // Schedule the first fetch after component construction. Updating state
    // during render itself produces a warning and risks a frame before hooks
    // have finished registering their cleanup.
    useEffect(() => {
      const timer = setTimeout(refresh, 0);
      return () => clearTimeout(timer);
    });
    useInterval(refresh, options.refreshMs ?? 1_000);

    useInput((input, key) => {
      const command = input.toLowerCase();
      if (command === "q" || key.escape) {
        app.exit();
        return;
      }
      if (command === "r") {
        refresh();
        return;
      }
      if (command === "v") {
        setShowDeathDetails((current) => !current);
        setTimeout(refresh, 0);
      }
    });

    return redskilledDashboardFrame({
      frame: frame(),
      columns: size.columns || 80,
      rows: size.rows || 24,
      showDeathDetails: showDeathDetails(),
      noColor: options.noColor,
    });
  }

  const instance = render(App, {
    stdin: options.stdin,
    stdout: options.stdout,
    screenMode: "alternate",
    maxFps: 10,
    exitOnCtrlC: true,
    exitProcess: false,
    showCursor: false,
    useDeltaRenderer: true,
  });
  await instance.waitUntilExit();
}
