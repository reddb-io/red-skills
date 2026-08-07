/** The terminal adapter for the daemon-owned dashboard projection. */
import {
  readRedskilledDashboardRender,
  type RedskilledClientConfig,
} from "./client.js";
import { runRedskilledDashboardTui, type RedskilledDashboardTuiOptions } from "./dashboard-tui.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import { readStatuslineProject } from "./statusline-project.js";
import {
  parseRedskilledStatuslineFlags,
  resolveRedskilledStatuslineOptions,
} from "./statusline-config.js";
import {
  stripAnsi,
  type RedskilledDashboardOptions,
} from "@reddb-io/redskilled-render";

export interface RunRedskilledDashboardIO {
  readonly cwd?: string;
  readonly paths?: RedskilledPaths;
  readonly write?: (line: string) => void;
  readonly warn?: (line: string) => void;
  readonly client?: RedskilledClientConfig;
  readonly now?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  /** `null` forces snapshot mode; omitted discovers the real stdout TTY. */
  readonly terminal?: true | null;
  readonly readDashboard?: typeof readRedskilledDashboardRender;
  readonly runTui?: (options: RedskilledDashboardTuiOptions) => Promise<void>;
}

/**
 * `redskilled dashboard [global] [--max-width N]` — a live TTY or one pipe snapshot.
 *
 * The shared pure renderer still decides every frame. This module owns only the
 * terminal lifecycle, resize input and the operator's detail toggle.
 */
export async function runDashboard(
  args: readonly string[],
  io: RunRedskilledDashboardIO = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line));
  const warn = io.warn ?? ((line: string) => process.stderr.write(line));
  const parsed = parseRedskilledStatuslineFlags(args);
  const project = readStatuslineProject(io.cwd ?? process.cwd());
  const resolved = resolveRedskilledStatuslineOptions({
    ...(project.configText == null ? {} : { configText: project.configText }),
    project: project.label,
    flags: parsed.flags,
  });
  for (const warning of [...resolved.warnings, ...parsed.warnings]) {
    warn(`redskilled dashboard: ignoring ${warning.key}=${warning.value} — ${warning.reason}\n`);
  }

  const paths = io.paths ?? resolveRedskilledPaths();
  const readDashboard = io.readDashboard ?? readRedskilledDashboardRender;
  const interactive = io.terminal === undefined ? process.stdout.isTTY === true : io.terminal === true;
  const noColor = (io.env ?? process.env).NO_COLOR !== undefined;
  const baseOptions: Partial<RedskilledDashboardOptions> = {
    ...(resolved.options.project == null ? {} : { project: resolved.options.project }),
    mode: resolved.options.mode,
    showDeathDetails: resolved.options.verbose,
  };

  const readFrame = async (
    options: Partial<RedskilledDashboardOptions>,
    warnOnFailure = true,
  ): Promise<readonly string[]> => {
    try {
      const render = await readDashboard(paths, options, {
        ...(io.client ?? {}),
        ...(resolved.options.project == null ? {} : { sessionProject: resolved.options.project }),
      });
      return noColor ? render.lines.map(stripAnsi) : render.lines;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (warnOnFailure) warn(`redskilled dashboard: ${reason}\n`);
      return [`redskilled unreachable — ${reason}`];
    }
  };

  if (!interactive) {
    const lines = await readFrame({
      ...baseOptions,
      ...(resolved.options.maxWidth == null ? {} : { maxWidth: resolved.options.maxWidth }),
    });
    write(`${lines.join("\n")}\n`);
    return 0;
  }

  await (io.runTui ?? runRedskilledDashboardTui)({
    initialShowDeathDetails: resolved.options.verbose,
    noColor,
    readFrame: async ({ columns, rows, showDeathDetails }) => {
      const maxWidth = Math.max(1, Math.min(resolved.options.maxWidth ?? columns, columns));
      const maxHeight = Math.max(1, rows);
      return await readFrame({
        ...baseOptions,
        maxWidth,
        maxHeight,
        maxRows: Math.max(0, maxHeight - 5),
        showDeathDetails,
      }, false);
    },
  });
  return 0;
}
