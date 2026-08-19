/**
 * board — the statusline as a pane, and as a one-shot print.
 *
 * The whole document comes from the daemon's `statusline-dashboard` op, never
 * from this plugin's own reading of the payload. Behind that op is
 * `@reddb-io/redskilled-render`, the ONE layout every surface shares (ADR 0132
 * decision 1), so a pane that drew its own Worker rows would be a second
 * implementation of a module that already exists — the same reason `status`
 * prints `statusline-string` rather than rendering a line of its own.
 *
 * **What travels over the socket is taste already decided here.** Mode, width and
 * the row budget are resolved from config and flags before the read, because the
 * daemon must never learn what a config file is.
 *
 * `--once` prints the frame and returns, which is what an action and a script
 * want; without it the command holds a pane open and re-reads on the interval.
 */
import { createRedskilledClient } from "../redskilled/client.mjs";
import { resolveRedskilledPaths } from "../redskilled/paths.mjs";
import { resolveProjectLabel } from "../redskilled/project-identity.mjs";
import { notify } from "../herdr.mjs";
import { renderBoard } from "../ui/board.mjs";
import { runScreen } from "../ui/screen.mjs";

/** One read, as a total answer: a failure is rendered, never raised. */
export async function readBoard(client, { sessionProject, mode, maxWidth, maxRows }) {
  try {
    const dashboard = await client.statuslineDashboard(sessionProject, {
      mode,
      ...(sessionProject ? { project: sessionProject } : {}),
      ...(maxWidth ? { max_width: maxWidth } : {}),
      ...(maxRows ? { max_rows: maxRows } : {}),
    });
    return { dashboard, error: null };
  } catch (error) {
    return { dashboard: null, error: error?.message ?? String(error) };
  }
}

export async function runBoard({ config, flags = {} }) {
  const socket = resolveRedskilledPaths({ socketPath: flags.socket ?? config.socketPath });
  const client = createRedskilledClient({ socketPath: socket.socketPath, timeoutMs: config.timeoutMs });
  const localProject = await resolveProjectLabel(process.cwd()).catch(() => null);

  const state = { mode: flags.mode ?? config.mode, message: null };
  let read = { dashboard: null, error: null };

  function sessionProject() {
    return state.mode === "local" ? localProject ?? undefined : undefined;
  }

  /**
   * Re-read the daemon, telling it the pane's actual size.
   *
   * The budgets are stated on the REQUEST rather than applied to the answer: the
   * daemon degrades a crowded machine to an honest "N more Worker(s)" line, and a
   * pane that trimmed rows itself would drop them in silence instead.
   */
  async function refresh(size = { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 }) {
    read = await readBoard(client, {
      sessionProject: sessionProject(),
      mode: state.mode,
      maxWidth: flags.maxWidth ?? Math.max(40, size.columns - 2),
      maxRows: Math.max(1, size.rows - 6),
    });
  }

  if (flags.once || flags.json || flags.notify) {
    await refresh({ columns: flags.maxWidth ?? 200, rows: 32 });

    if (flags.json) {
      // Behind an explicit flag, which is where the TOON mandate leaves JSON: the
      // DEFAULT render is the daemon's own lines, and this is the escape hatch a
      // script asked for by name.
      process.stdout.write(`${JSON.stringify({ socket: socket.socketPath, ...read }, null, 2)}\n`);
      return read.error ? 1 : 0;
    }

    const lines = read.dashboard?.lines ?? [read.error ?? "redskilled: no host answered"];
    if (flags.notify) {
      await notify("redskilled", {
        body: read.dashboard?.header?.line ?? lines[0],
        position: config.notifications.position,
        sound: config.notifications.sound,
      });
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return read.error ? 1 : 0;
  }

  await runScreen({
    title: "red-skills board",
    refreshMs: flags.refreshMs ?? config.refreshMs,
    onTick: refresh,
    render: (size) =>
      renderBoard({ dashboard: read.dashboard, state, size, socketPath: socket.socketPath, error: read.error }),
    onKey: async (key) => {
      switch (key.name) {
        case "q":
        case "escape":
        case "ctrl-c":
          return "quit";
        case "r":
          state.message = null;
          await refresh();
          return;
        case "g":
          state.mode = state.mode === "global" ? "local" : "global";
          state.message =
            state.mode === "local" && localProject == null
              ? "this directory resolves to no project label, so local mode has nothing to scope to"
              : null;
          await refresh();
          return;
        default:
          return;
      }
    },
  });
  return 0;
}
