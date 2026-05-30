import { renderCompactDashboard } from "../core/monitor.js";
import { collectMonitorInputs } from "../runtime/wire.js";

/**
 * `monitor [--once]` — native compact dashboard. Globs the worker state files
 * and reads the history ledger (no bash), then renders via the pure
 * renderCompactDashboard.
 */
export async function monitorCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const { workers, events } = await collectMonitorInputs(cwd);
  const now = Math.floor(Date.now() / 1000);
  const dashboard = renderCompactDashboard(workers, events, now);
  stdout.write(`${dashboard}\n`);
  return 0;
}
