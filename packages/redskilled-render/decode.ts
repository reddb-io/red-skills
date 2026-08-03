/**
 * decode — one payload, whatever encoding it arrived in.
 *
 * **The render is encoding-agnostic on the way IN** (ADR 0132 decision 1). The
 * same module has to serve a socket read, a piped file and a checked-in fixture,
 * and those three arrive as JSON, as TOON and as a single line of either; a
 * renderer that accepted only one of them would push a decoder into every surface
 * that wanted to draw from a file. The repo's TOON mandate governs WRITERS and is
 * untouched by this: what a reader tolerates and what a writer must emit are
 * different contracts, and conflating them is what makes a fixture unreadable.
 *
 * **A line-delimited lane yields its LAST complete record.** A `.toonl` or
 * `.jsonl` file of payload snapshots is a history, and the thing a surface draws
 * is the newest one; earlier rows are returned beside it so a caller that wants
 * the history has it without parsing twice.
 *
 * **A torn tail is skipped, never fatal.** These lanes are append-only and a
 * reader can land mid-write. A decoder that threw on the last half-written row
 * would blank a surface over a race that resolves itself on the next tick.
 *
 * PURE: text in, values out. Nothing here opens a file or a socket.
 */
import { decode as decodeToon } from "@reddb-io/toon";
import { isRedskilledRenderPayload, type RedskilledRenderPayload } from "./payload.js";

/** Which encoding a document turned out to be, stated rather than guessed twice. */
export type RedskilledRenderEncoding = "json" | "jsonl" | "toon" | "toonl";

export interface RedskilledRenderDecoded {
  /** The record a surface draws — the last complete one in a line-delimited lane. */
  readonly payload: RedskilledRenderPayload;
  readonly encoding: RedskilledRenderEncoding;
  /** Every record the document held, oldest first; one entry for a snapshot. */
  readonly records: readonly RedskilledRenderPayload[];
}

/**
 * The reason a document could not be drawn, as a sentence a surface can print.
 *
 * An Error rather than a `null` return: "this text is not a payload" and "this
 * payload has no Workers" are opposite facts, and a decoder that answered both
 * with an absence would let an unparseable document render as an idle machine.
 */
export class RedskilledRenderDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedskilledRenderDecodeError";
  }
}

/**
 * Decode one payload document. PURE.
 *
 * Accepts the already-parsed value too, because the socket path has one: a client
 * that decoded the frame itself must not have to re-encode it to reach the same
 * render.
 */
export function decodeRedskilledPayload(input: string | unknown): RedskilledRenderDecoded {
  if (typeof input !== "string") {
    if (!isRedskilledRenderPayload(input)) {
      throw new RedskilledRenderDecodeError("the value handed to the render is not a redskilled statusline payload");
    }
    return { payload: input, encoding: "json", records: [input] };
  }

  const text = input.trim();
  if (text === "") throw new RedskilledRenderDecodeError("the document handed to the render is empty");

  // A snapshot first, because a whole-document parse is the unambiguous case: a
  // JSON object and a TOON block both decode in one call, and only when neither
  // does is the document worth reading as a lane of lines.
  const snapshot = decodeSnapshot(text);
  if (snapshot != null) return snapshot;

  const lane = decodeLane(text);
  if (lane != null) return lane;

  throw new RedskilledRenderDecodeError(
    "the document handed to the render decoded as neither JSON, JSONL, TOON nor TOONL — or held no payload record",
  );
}

/** A whole-document parse, in either encoding; `null` when it is not one. */
function decodeSnapshot(text: string): RedskilledRenderDecoded | null {
  if (text.startsWith("{")) {
    const value = tryJson(text);
    if (isRedskilledRenderPayload(value)) return { payload: value, encoding: "json", records: [value] };
    // A single JSON object that is NOT a payload is still a decisive answer; it
    // falls through so the caller gets the "not a payload" sentence rather than a
    // TOON parse error about a brace.
    if (value !== undefined) return null;
  }
  const toon = tryToon(text);
  if (isRedskilledRenderPayload(toon)) return { payload: toon, encoding: "toon", records: [toon] };
  return null;
}

/**
 * A line-delimited lane, in either encoding; `null` when no row is a payload.
 *
 * TOONL rows share one header line, so a row is decoded by pairing it with the
 * header that preceded it — the same reading the repo's other TOONL lanes use.
 */
function decodeLane(text: string): RedskilledRenderDecoded | null {
  const records: RedskilledRenderPayload[] = [];
  let sawToonRow = false;
  let header = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("{")) {
      const value = tryJson(line);
      if (isRedskilledRenderPayload(value)) records.push(value);
      continue;
    }
    if (/^\[(?:[0-9]+)?\](?:\{[^}]+\}:|:)$/.test(line)) {
      header = line;
      continue;
    }
    if (header === "") continue;
    // A count in the header describes the whole lane, not this row, so it is
    // normalized to one: decoding a single row against `[42]` fails on a document
    // that is otherwise perfectly readable.
    const value = tryToon(`${header.replace(/^\[(?:[0-9]+)?\]/, "[1]")}\n${line}\n`);
    const row = Array.isArray(value) ? value[0] : value;
    if (isRedskilledRenderPayload(row)) {
      records.push(row);
      sawToonRow = true;
    }
  }
  const payload = records[records.length - 1];
  if (payload == null) return null;
  return { payload, encoding: sawToonRow ? "toonl" : "jsonl", records };
}

/** `undefined` when the text is not JSON at all — never a thrown parse error. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `undefined` when the text is not TOON at all — never a thrown parse error. */
function tryToon(text: string): unknown {
  try {
    return decodeToon(text);
  } catch {
    return undefined;
  }
}
