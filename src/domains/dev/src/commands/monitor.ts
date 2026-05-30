import { renderCompactDashboard } from "../core/monitor.js";
import { collectMonitorInputs } from "../runtime/wire.js";
import { runLegacy } from "../platform/legacy.js";

/**
 * `monitor [--once]` — native compact dashboard. Globs the worker state files
 * and reads the history ledger (no bash), then renders via the pure
 * renderCompactDashboard. `RED_AFK_LEGACY=1` falls back to monitor.sh.
 */
export async function monitorCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  if (process.env.RED_AFK_LEGACY === "1") {
    return runLegacy("monitor", args, cwd);
  }

  const { workers, events } = await collectMonitorInputs(cwd);
  const now = Math.floor(Date.now() / 1000);
  const dashboard = renderCompactDashboard(workers, events, now);
  stdout.write(`${dashboard}\n`);
  return 0;
}
