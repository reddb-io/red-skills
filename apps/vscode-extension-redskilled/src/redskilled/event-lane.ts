/**
 * event-lane — the daemon's own memory, read off disk.
 *
 * ADR 0130 rule 8 appends birth, death, budget-kill and the daemon's own stop to
 * a TOONL lane. The socket answers "what is running NOW"; this file is the only
 * surface that answers "what happened". A view without it can show a Worker
 * vanish and never say whether it exited 0, was killed over its ceiling, or went
 * down with the daemon — which is the whole difference an operator cares about.
 *
 * The decoder is the daemon's own `parseEventLane`, so the extension cannot drift
 * into a private idea of what a row means. What is added here is a bound: a lane
 * appended to for a week must not make one refresh read the session's entire
 * history.
 */
import { open, readFile, stat } from "node:fs/promises";
import { parseEventLane, type RedskilledHostEvent } from "@reddb-io/redskilled/event-lane";

/** Read the whole lane below this; above it, read the head and the tail. */
export const DEFAULT_LANE_WHOLE_FILE_BYTES = 512 * 1024;

/** How much of the end to read when the lane is longer than that. */
export const DEFAULT_LANE_TAIL_BYTES = 256 * 1024;

/**
 * How much of the START to read when the lane is long.
 *
 * A segment header is declared once per daemon process, so on a long-lived host
 * it sits at byte 0 and a tail window contains no header at all. Reading a small
 * head back gives the tail's positional rows the field names they were written
 * against; without it a long lane would decode to nothing and the view would
 * report a quiet host during exactly the incident it exists to narrate.
 */
export const DEFAULT_LANE_HEAD_BYTES = 8 * 1024;

/** A TOONL segment header: an optional tag, an optional count, then `{fields}:`. */
const SEGMENT_HEADER = /^\s*(?:#[A-Za-z0-9_.:-]+\s*)?(?:\[[^\]]*\])?\{[^}]*\}\s*:\s*$/;

export interface EventLaneRead {
  readonly path: string;
  readonly exists: boolean;
  /** True when only a window of a longer lane was decoded. */
  readonly truncated: boolean;
  /** Oldest first, exactly as the daemon appended them. */
  readonly events: readonly RedskilledHostEvent[];
}

export interface ReadEventLaneOptions {
  readonly wholeFileBytes?: number;
  readonly tailBytes?: number;
  readonly headBytes?: number;
  /** Keep at most this many events, newest kept. */
  readonly limit?: number;
}

/** The lane's most recent events, oldest first; an absent lane is an empty history. */
export async function readEventLane(
  path: string,
  options: ReadEventLaneOptions = {},
): Promise<EventLaneRead> {
  const wholeFileBytes = options.wholeFileBytes ?? DEFAULT_LANE_WHOLE_FILE_BYTES;
  const tailBytes = options.tailBytes ?? DEFAULT_LANE_TAIL_BYTES;
  const headBytes = options.headBytes ?? DEFAULT_LANE_HEAD_BYTES;
  const limit = options.limit ?? 500;

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") {
      return { path, exists: false, truncated: false, events: [] };
    }
    throw error;
  }

  if (size <= wholeFileBytes) {
    const raw = await readFile(path, "utf8");
    return { path, exists: true, truncated: false, events: lastN(parseEventLane(raw), limit) };
  }

  const { head, tail } = await readEnds(path, size, headBytes, tailBytes);
  return {
    path,
    exists: true,
    truncated: true,
    events: lastN(parseEventLane(spliceWindow(head, tail)), limit),
  };
}

/**
 * The head's last segment header, glued to the tail's complete lines. PURE.
 *
 * The tail's own first line is dropped: a window opens mid-row, and half a row is
 * not a record. A header inside the tail — a lane a restart re-declared — simply
 * supersedes the borrowed one as the decoder streams past it, so the splice is
 * correct for a rotated lane too.
 */
export function spliceWindow(head: string, tail: string): string {
  const header = lastSegmentHeader(head);
  const firstNewline = tail.indexOf("\n");
  const rows = firstNewline < 0 ? "" : tail.slice(firstNewline + 1);
  if (rows === "") return "";
  const body = rows.endsWith("\n") ? rows : `${rows}\n`;
  return header === null ? body : `${header}\n${body}`;
}

function lastSegmentHeader(head: string): string | null {
  let found: string | null = null;
  for (const line of head.split("\n")) {
    if (SEGMENT_HEADER.test(line)) found = line;
  }
  return found;
}

async function readEnds(
  path: string,
  size: number,
  headBytes: number,
  tailBytes: number,
): Promise<{ head: string; tail: string }> {
  const handle = await open(path, "r");
  try {
    const headLength = Math.min(headBytes, size);
    const headChunk = Buffer.alloc(headLength);
    await handle.read(headChunk, 0, headLength, 0);

    const tailLength = Math.min(tailBytes, size);
    const tailChunk = Buffer.alloc(tailLength);
    await handle.read(tailChunk, 0, tailLength, size - tailLength);

    return { head: headChunk.toString("utf8"), tail: tailChunk.toString("utf8") };
  } finally {
    await handle.close();
  }
}

function lastN<T>(items: readonly T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

export type { RedskilledHostEvent };
