/**
 * log-tail — a Worker's own log, read from the path the daemon was handed.
 *
 * **The path is given, never derived.** ADR 0130 rule 3 keeps the daemon from
 * learning repository layout, and the same restraint binds this reader: it opens
 * `worker.log_path` as reported and nothing else. Guessing a filename inside the
 * workspace would be the extension inventing the layout the daemon refuses to.
 *
 * Only the tail is read. A drain that has been running for hours is not a reason
 * to make one click load a hundred megabytes into a panel.
 */
import { open, stat } from "node:fs/promises";

export const DEFAULT_TAIL_BYTES = 128 * 1024;
export const DEFAULT_TAIL_LINES = 2_000;

export interface LogTail {
  readonly path: string | null;
  readonly exists: boolean;
  /** True when an earlier part of the file was not read. */
  readonly truncated: boolean;
  readonly size: number;
  readonly lines: readonly string[];
  /** Why the file could not be read, when it could not; `null` otherwise. */
  readonly reason: string | null;
}

export interface TailFileOptions {
  readonly tailBytes?: number;
  readonly limit?: number;
}

/** The last lines of `path`, newest last. An absent file is an absence, not a throw. */
export async function tailFile(
  path: string | null | undefined,
  options: TailFileOptions = {},
): Promise<LogTail> {
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  const limit = options.limit ?? DEFAULT_TAIL_LINES;

  if (typeof path !== "string" || path.trim() === "") {
    return { path: null, exists: false, truncated: false, size: 0, lines: [], reason: "this Worker declared no log path" };
  }

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") {
      return { path, exists: false, truncated: false, size: 0, lines: [], reason: code };
    }
    throw error;
  }

  const window = Math.min(size, tailBytes);
  const handle = await open(path, "r");
  let text: string;
  try {
    const chunk = Buffer.alloc(window);
    await handle.read(chunk, 0, window, size - window);
    text = chunk.toString("utf8");
  } finally {
    await handle.close();
  }

  const truncated = window < size;
  // The window usually opens mid-line, and half a log line reads as a log line
  // that says half a thing, so the partial first line is dropped rather than shown.
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
    reason: null,
  };
}
