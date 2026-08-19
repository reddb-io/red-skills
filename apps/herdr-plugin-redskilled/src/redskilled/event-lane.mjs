/**
 * event-lane — the daemon's own memory, read from disk.
 *
 * ADR 0130 rule 8: birth, death and budget-kill are appended to a TOONL lane so
 * an incident can be read after the fact. The socket answers "what is running
 * NOW"; this file is the only surface that answers "what happened". A dashboard
 * without it can show a Worker vanish and never say whether it exited 0, was
 * killed over budget, or died with the daemon.
 *
 * **The decoder is `@reddb-io/toon`, never a local one.** This module used to
 * carry its own segment-header regex, trailer regex and quoted-cell splitter —
 * roughly sixty lines re-deriving a format the house package already owns and
 * this plugin already depends on. Two things made that costly rather than
 * merely redundant. A hand-written reader drifts from the writer it reads, and
 * the host lane legitimately carries SEVERAL segment arities in one file (35 and
 * 33 columns live side by side today), so a reader that mis-tracks a header
 * decodes every later row against the wrong fields.
 *
 * **A fault is reported, never absorbed.** The house decoder stops at a
 * malformed row and names it — `line 1600: row arity mismatch` — so this module
 * keeps every record decoded up to that point and hands the reason back in
 * `decodeError`. That is the tolerance this reader always wanted: the earlier
 * one kept an undecodable line as raw text and carried on, which reports a quiet
 * incident during exactly the format change that caused it. Loud and located
 * beats silent and complete.
 */
import { readFile, stat } from "node:fs/promises";
import { decodeLines } from "@reddb-io/toon";

/**
 * The largest lane this reader will decode whole.
 *
 * The writer compacts its lane at 4 MiB (`DEFAULT_REDSKILLED_EVENT_LANE_MAX_BYTES`),
 * so a bounded read is the writer's contract rather than this reader's guess,
 * and the headroom here covers a lane caught mid-append. Reading whole is what
 * keeps every segment header in view: a tail window opens AFTER the header its
 * rows are declared by, and rows without their header are not decodable by
 * anyone — the previous reader only appeared to survive that by keeping them as
 * raw text and calling it tolerance.
 */
export const DEFAULT_EVENT_LANE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Decode a lane's text into records, oldest first.
 *
 * Returns the records AND the reason decoding stopped, when it did. A caller
 * that wants only the rows can ignore `decodeError`; a viewer should show it,
 * because a truncated history that says nothing is indistinguishable from a
 * quiet one.
 */
export async function parseEventLane(raw) {
  const records = [];
  try {
    for await (const record of decodeLines(raw)) records.push(record);
  } catch (error) {
    return { records, decodeError: error?.message ?? String(error) };
  }
  return { records, decodeError: null };
}

/** True when a record is one of the three facts the lane carries. PURE. */
export function isHostEvent(record) {
  return (
    record != null &&
    typeof record.ts === "string" &&
    typeof record.worker_id === "string" &&
    (record.event === "worker-birth" || record.event === "worker-death" || record.event === "worker-budget-kill")
  );
}

/**
 * The lane's last records, newest last; an absent lane is an empty history.
 *
 * The lane is read WHOLE, bounded by the writer's own compaction ceiling rather
 * than by a window this reader invents. A tail window was the older shape and it
 * was quietly broken: it opened after the segment header its rows are declared
 * by, so every row in it was undecodable — survived only by keeping them as raw
 * text. Against the live 1.8 MB lane that window yielded ZERO decodable records.
 */
export async function readEventLane(path, { maxBytes = DEFAULT_EVENT_LANE_MAX_BYTES, limit = 500 } = {}) {
  let size;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { path, exists: false, records: [], truncated: false, decodeError: null };
    }
    throw error;
  }

  if (size > maxBytes) {
    // Past the writer's own ceiling the lane is not what this reader was told to
    // expect, and half of it is worse than none: rows whose header scrolled out
    // decode against nothing. Say so instead of showing a confident fragment.
    return {
      path,
      exists: true,
      truncated: true,
      decodeError: `the lane is ${size} bytes, past the ${maxBytes}-byte ceiling this reader decodes whole`,
      records: [],
    };
  }

  const raw = await readFile(path, "utf8");

  const { records, decodeError } = await parseEventLane(raw);
  return {
    path,
    exists: true,
    truncated: false,
    decodeError,
    records: records.slice(Math.max(0, records.length - limit)),
  };
}
