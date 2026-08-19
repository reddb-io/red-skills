/**
 * log-tail — a Worker's own log, read from the path the daemon was handed.
 *
 * **The path is given, never derived.** ADR 0130 rule 3 keeps the daemon from
 * learning repository layout, and the same restraint applies here: this reader
 * only ever opens `worker.log_path` as reported, and a Worker whose client
 * declared none simply has no log to open. Guessing a filename inside its
 * workspace would be this plugin inventing the layout the daemon refuses to.
 *
 * Only the tail is read. A drain that has been running for hours is not a reason
 * to make one keypress load a hundred megabytes into a pane.
 */
import { open, stat } from "node:fs/promises";

export const DEFAULT_TAIL_BYTES = 128 * 1024;

/** The last `limit` lines of `path`, newest last. An absent file is an absence. */
export async function tailFile(path, { tailBytes = DEFAULT_TAIL_BYTES, limit = 2_000 } = {}) {
  if (typeof path !== "string" || path.trim() === "") {
    return { path: null, exists: false, truncated: false, lines: [], size: 0 };
  }

  let size;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EISDIR") {
      return { path, exists: false, truncated: false, lines: [], size: 0, reason: error.code };
    }
    throw error;
  }

  const window = Math.min(size, tailBytes);
  const handle = await open(path, "r");
  let text;
  try {
    const chunk = Buffer.alloc(window);
    await handle.read(chunk, 0, window, size - window);
    text = chunk.toString("utf8");
  } finally {
    await handle.close();
  }

  const truncated = window < size;
  // The window usually opens mid-line; a partial first line is dropped rather
  // than shown, because half a log line reads as a log line that says half a
  // thing.
  if (truncated) {
    const newline = text.indexOf("\n");
    text = newline < 0 ? "" : text.slice(newline + 1);
  }

  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  return {
    path,
    exists: true,
    truncated,
    size,
    lines: all.slice(Math.max(0, all.length - limit)),
  };
}
