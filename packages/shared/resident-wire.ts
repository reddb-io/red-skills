/**
 * resident-wire — how a resident socket frames and encodes ONE message.
 *
 * `resident-core` owns the mechanics of the socket; this module owns what
 * travels on it. Both daemons behind that socket — `rsp`'s resident and
 * `redskilled` — share it, so the two cannot silently disagree about what a
 * frame is, which is the same reason the socket mechanics were shared in the
 * first place.
 *
 * ## The migration order, stated rather than inferred
 *
 * The wire used to be one line of JSON. It is TOON now, and one daemon serves
 * checkouts pinned to different bundle versions (ADR 0130 rule 3), so a new
 * client meeting an old daemon and an old client meeting a new daemon are both
 * ordinary states during a rollout, not accidents. Three rules make every
 * ordering of the two upgrades work, and they are listed in the order they take
 * effect on a single message:
 *
 * 1. **Every reader accepts both encodings.** The dialect is read off the bytes
 *    — a frame that opens with `{` is JSON, anything else is TOON — so no peer
 *    has to be told, asked, or configured. This is what makes an OLD client
 *    against a NEW daemon work: its JSON line is still a frame the new daemon
 *    understands.
 * 2. **A responder answers in the dialect it was addressed in.** The daemon
 *    never guesses what its caller can read; it already holds the proof in the
 *    request it just parsed. An old client therefore gets JSON back from a new
 *    daemon even though the daemon writes TOON to everyone else.
 * 3. **A client writes TOON, and downgrades to JSON for the rest of the process
 *    when a peer proves it could not read it.** This is what makes a NEW client
 *    against an OLD daemon work. The proof is exact rather than a string match:
 *    an old daemon fails at `JSON.parse` BEFORE it has a request, so its error
 *    response carries a fresh random id instead of the id it was sent
 *    (`isUnintelligibleResponse`). That same fact — the failure happens before
 *    the request exists — is what makes the retry safe: a request the peer never
 *    parsed is a request it never executed, so re-sending it cannot repeat a
 *    side effect.
 *
 * Rules 1 and 2 are what a daemon must ship BEFORE rule 3 costs nothing; rule 3
 * is written so it is correct even against a daemon that shipped none of them.
 *
 * ## Framing
 *
 * A JSON frame is one line — `JSON.stringify` never emits a raw newline, so the
 * first newline ends the message, which is exactly what the old wire assumed. A
 * TOON document is multi-line, so it is terminated by a BLANK line instead. That
 * is unambiguous rather than merely convenient: the TOON encoder escapes `\n`
 * inside strings, so a blank line cannot occur inside a document, only after it.
 */
import { decode, encode, type JsonValue } from "@reddb-io/toon";

/** The two encodings a resident socket carries during and after the migration. */
export type ResidentWireDialect = "json" | "toon";

/** The encoding written by default — rule 3 above. */
export const DEFAULT_RESIDENT_WIRE_DIALECT: ResidentWireDialect = "toon";

export interface ResidentWireFrame {
  /** The message body, without its terminator. */
  frame: string;
  /** The encoding the body is in, read off the bytes. */
  dialect: ResidentWireDialect;
  /** What is left of the buffer after this frame's terminator. */
  rest: string;
}

/**
 * The dialect a frame is written in, decided by its first meaningful byte.
 *
 * `{` or `[` means JSON: every request and response on this wire is an object
 * (a TOON document for one starts with its first key instead), and a `[` can
 * only be a JSON-RPC batch — which the SDK emits by default, and which a TOON
 * read would wait forever for a `\n\n` terminator on, wedging every frame
 * behind it. Arrays therefore always travel as JSON lines (see
 * `encodeWireFrame`), so a TOON root-form array is deliberately
 * unrepresentable on this wire.
 */
export function sniffWireDialect(text: string): ResidentWireDialect {
  const head = text.trimStart()[0];
  return head === "{" || head === "[" ? "json" : "toon";
}

/**
 * Take the first complete frame out of `buffer`, or `null` when more bytes are
 * still owed.
 *
 * Leading blank lines are dropped rather than treated as an empty frame, so a
 * peer that terminates generously cannot wedge the next message.
 */
/**
 * The most bytes one unterminated frame may buffer before the connection is
 * judged unrecoverable. A frame is delimited by a newline (JSON) or a blank
 * line (TOON); a peer that opens a frame and never terminates it grew the
 * reader's buffer without bound (leak audit 2026-08-25) — and past this point
 * there is no delimiter to resync on, so the honest answer is to refuse the
 * connection loudly rather than hold its bytes forever.
 */
export const MAX_WIRE_FRAME_BYTES = 8 * 1024 * 1024;

/** Thrown by readers when a peer exceeds {@link MAX_WIRE_FRAME_BYTES}. */
export class WireFrameOverflowError extends Error {
  constructor(heldBytes: number) {
    super(
      `wire frame exceeded ${MAX_WIRE_FRAME_BYTES} bytes without a terminator ` +
        `(${heldBytes} held) — the connection cannot resync and is refused`,
    );
    this.name = "WireFrameOverflowError";
  }
}

export function takeWireFrame(buffer: string): ResidentWireFrame | null {
  let start = 0;
  while (buffer[start] === "\n" || buffer[start] === "\r") start += 1;
  const pending = buffer.slice(start);
  if (pending === "") return null;
  const dialect = sniffWireDialect(pending);
  if (dialect === "json") {
    const newline = pending.indexOf("\n");
    if (newline < 0) return null;
    return { frame: pending.slice(0, newline), dialect, rest: pending.slice(newline + 1) };
  }
  const blank = pending.indexOf("\n\n");
  if (blank < 0) return null;
  return { frame: pending.slice(0, blank + 1), dialect, rest: pending.slice(blank + 2) };
}

/**
 * Decode one frame in either encoding.
 *
 * The sniff picks which parser goes first; the other is still tried if it fails,
 * because a reader that accepts both encodings should not fail on a message it
 * could have read.
 */
export function decodeWireFrame(frame: string): unknown {
  const first = sniffWireDialect(frame) === "json" ? readJson : readToon;
  const second = first === readJson ? readToon : readJson;
  try {
    return first(frame);
  } catch (err) {
    try {
      return second(frame);
    } catch {
      throw err;
    }
  }
}

/**
 * Decode one frame in exactly the dialect its bytes were sniffed as.
 *
 * The lenient {@link decodeWireFrame} exists for the trusted resident op
 * socket, where rule 1 wants a reader that accepts both encodings. On a
 * socket carrying third-party agents that leniency is a hazard: a truncated
 * JSON line handed to the TOON parser can come back as a plausible-looking
 * object instead of an error, and a mis-decoded message is worse than a
 * refused one.
 */
export function decodeWireFrameStrict(frame: string, dialect: ResidentWireDialect): unknown {
  return dialect === "json" ? readJson(frame) : readToon(frame);
}

function readJson(frame: string): unknown {
  return JSON.parse(frame) as unknown;
}

function readToon(frame: string): unknown {
  return decode(frame) as unknown;
}

/**
 * Encode one message, terminator included.
 *
 * TOON falls back to JSON for a value it cannot carry — an empty document has no
 * frame to terminate, and the encoder refuses a value JSON would have dropped.
 * The fallback is free rather than a degradation: by rule 1 every reader on this
 * wire accepts JSON too.
 */
export function encodeWireFrame(value: unknown, dialect: ResidentWireDialect): string {
  // The symmetric half of the sniff rule: a `[`-leading frame reads as JSON,
  // so an array is WRITTEN as one JSON line in either dialect — otherwise a
  // TOON-encoded batch answer would come back to us sniffed as JSON and fail.
  if (Array.isArray(value)) return `${JSON.stringify(value)}\n`;
  if (dialect === "toon") {
    const body = tryEncodeToon(value);
    if (body !== null) return body.endsWith("\n") ? `${body}\n` : `${body}\n\n`;
  }
  return `${JSON.stringify(value)}\n`;
}

function tryEncodeToon(value: unknown): string | null {
  try {
    // The JSON round trip is what drops `undefined` and applies `toJSON`, which
    // the TOON encoder refuses rather than silently omits. The messages here are
    // small control-plane envelopes, so the copy is not worth avoiding.
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    const body = encode(JSON.parse(json) as JsonValue);
    return body.trim() === "" ? null : body;
  } catch {
    return null;
  }
}

/**
 * True when `response` proves the peer never understood `request` — rule 3.
 *
 * Both daemons answer a frame they failed to parse with `{ ok: false }` and a
 * FRESH id, because at that point they hold no request to echo one from. An
 * error a daemon raised while handling a request it did parse echoes that id, so
 * this never mistakes a real refusal for a dialect it could not read.
 */
export function isUnintelligibleResponse(request: unknown, response: unknown): boolean {
  if (!isRecord(request) || !isRecord(response)) return false;
  if (response.ok !== false) return false;
  return typeof request.id === "string" && typeof response.id === "string" && response.id !== request.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Which socket paths have proven they only read JSON.
 *
 * Per process and one-way: a path only ever moves from "speaks TOON" to "speaks
 * JSON", never back. A daemon replaced by a newer one mid-process therefore keeps
 * being addressed in JSON, which by rule 1 it still reads — the stale direction
 * of this cache costs tokens, never a failed request.
 */
const jsonOnlyPeers = new Set<string>();

export function residentWireDialectFor(socketPath: string): ResidentWireDialect {
  return jsonOnlyPeers.has(socketPath) ? "json" : DEFAULT_RESIDENT_WIRE_DIALECT;
}

export function rememberJsonOnlyPeer(socketPath: string): void {
  jsonOnlyPeers.add(socketPath);
}

/** Forget every recorded downgrade. Tests own the process; nothing else should call this. */
export function resetResidentWireDialects(): void {
  jsonOnlyPeers.clear();
}
