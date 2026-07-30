/**
 * worker-log — the last line a Worker logged, as a published string.
 *
 * **The Worker publishes; the daemon stores.** The line travels on the Worker's
 * heartbeat and the daemon never reads it for meaning — no level is parsed, no
 * progress is inferred, no field is extracted. That is what keeps the global
 * verbose view to ONE read: the line is already in the payload, so a statusline
 * never opens a log, and the daemon never learns what a repository's log layout
 * is (ADR 0130 rule 3).
 *
 * The rejected alternative looks easier and is worse: a statusline that read each
 * Worker's log file directly would cost a disk read per Worker per render, cross a
 * project boundary on every tick, and reintroduce exactly the private source the
 * single-anchor rule forbids — a second authority on a question the payload
 * already answers.
 *
 * **One bounded exception: a restart.** A daemon that has just come back holds
 * Workers it has never heard a heartbeat from, and for those it may read the log
 * ONCE — from the path it was GIVEN at spawn, never from a path it derives. A
 * Worker whose client gave no log path simply has no line until it publishes one;
 * guessing a filename inside its workspace would be the derived layout this whole
 * design refuses.
 */
import { open, stat } from "node:fs/promises";

/**
 * One Worker's last logged line, and where the daemon got it.
 *
 * `source` is stated rather than inferred: a line recovered from disk after a
 * restart is a bounded exception, and a reader that could not tell it from a
 * published one would not be able to see the exception happening.
 */
export interface RedskilledWorkerLogLine {
  /** Exactly what was published, unparsed and unclamped by the daemon. */
  readonly line: string;
  readonly published_at: string;
  readonly source: "heartbeat" | "rehydrated";
}

/** How the daemon recovers a line after a restart; injected so a test can refuse it. */
export type RedskilledLogTailProbe = (path: string) => Promise<string | null>;

/**
 * How much of a log's tail one recovery read may look at.
 *
 * A window rather than the whole file: the answer is one line, and a Worker's log
 * can be hundreds of megabytes by the time a daemon restarts.
 */
export const REDSKILLED_LOG_TAIL_BYTES = 16 * 1024;

/**
 * How long a published line may be on the wire.
 *
 * Clamped by the PUBLISHER, never by the daemon: the daemon storing a string it
 * shortened would be the daemon interpreting content, and the statusline clamps
 * to the terminal's width anyway. This bound exists so a runaway log line cannot
 * make a heartbeat expensive.
 */
export const REDSKILLED_LOG_LINE_MAX = 500;

/**
 * The last non-empty line of the file at `path`, or `null`.
 *
 * `null` covers every way this can come up empty — no such file, no permission,
 * nothing but blank lines — because they all mean the same thing to the caller:
 * this Worker has no line to show yet.
 */
export async function readLastLogLine(
  path: string,
  tailBytes: number = REDSKILLED_LOG_TAIL_BYTES,
): Promise<string | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (size <= 0) return null;

  const length = Math.min(tailBytes, size);
  let raw: string;
  try {
    const handle = await open(path, "r");
    try {
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, size - length);
      raw = chunk.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  return lastNonEmptyLine(raw);
}

/**
 * The last line of `raw` that carries anything. PURE.
 *
 * A trailing newline is a log at rest, not an empty last line, so it is skipped
 * rather than reported as a blank the statusline would then have to hide.
 */
export function lastNonEmptyLine(raw: string): string | null {
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.replace(/\r$/, "");
    if (line.trim() !== "") return line;
  }
  return null;
}

/** A line trimmed to what a heartbeat may carry. PURE — publisher-side only. */
export function clampPublishedLogLine(line: string, max: number = REDSKILLED_LOG_LINE_MAX): string {
  const chars = [...line];
  return chars.length <= max ? line : chars.slice(0, max).join("");
}
