/**
 * wire — how one message travels on the `redskilled` socket.
 *
 * The wire is TOON (issues #2947 and #2948, ADR 0131). A TOON document is
 * multi-line, so a frame is terminated by a BLANK line rather than by the first
 * newline: the encoder escapes `\n` inside strings, so a blank line cannot occur
 * inside a document, only after one.
 *
 * **TOON only, in both directions, on purpose.** The daemon answers in the
 * dialect it was addressed in, so a daemon new enough to read TOON answers TOON.
 * A daemon too old to read it cannot answer this plugin's questions either — its
 * reply would be a parse error, not an answer — so reading its JSON would buy a
 * decoded refusal instead of a rendered dashboard. The honest report is the one
 * the reach layer already gives: nothing intelligible answered. That keeps every
 * byte this plugin writes and reads TOON, with no JSON exception to carry.
 *
 * `@reddb-io/shared/resident-wire.js` is the same contract for the monorepo's
 * TypeScript surfaces. This module is not a second opinion about the format — it
 * is the same frame, written where a plain-ESM plugin can load it: Node refuses
 * to strip types from a file under `node_modules`, which is where a workspace
 * link to a `.ts` module lives.
 */
import { decode, encode } from "@reddb-io/toon";

/** Raised when bytes arrived but no frame could be read out of them. */
export class WireFormatError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "WireFormatError";
  }
}

/**
 * One message, terminator included. PURE.
 *
 * The blank line is appended rather than assumed: the encoder ends a document
 * with a single newline, and a frame needs two.
 */
export function encodeFrame(value) {
  const body = encode(value);
  if (body.trim() === "") throw new WireFormatError("an empty document is not a frame");
  return body.endsWith("\n") ? `${body}\n` : `${body}\n\n`;
}

/**
 * Take the first complete frame out of `buffer`, or `null` when more bytes are
 * still owed. PURE.
 *
 * Leading blank lines are dropped rather than read as an empty frame, so a peer
 * that terminates generously cannot wedge the message behind it.
 */
export function takeFrame(buffer) {
  let start = 0;
  while (buffer[start] === "\n" || buffer[start] === "\r") start += 1;
  const pending = buffer.slice(start);
  if (pending === "") return null;
  const blank = pending.indexOf("\n\n");
  if (blank < 0) return null;
  return { frame: pending.slice(0, blank + 1), rest: pending.slice(blank + 2) };
}

/** One frame as the value it carries. PURE. */
export function decodeFrame(frame) {
  try {
    return decode(frame);
  } catch (cause) {
    throw new WireFormatError("the peer answered with a frame that is not TOON", { cause });
  }
}
