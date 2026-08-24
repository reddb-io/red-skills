// dual-dialect-stream — the ACP socket's byte codec, speaking JSON-RPC 2.0 and
// TOON-RPC 1.0 on one stream.
//
// The ACP SDK's `Stream` is a pair of OBJECT streams: everything above it —
// the connection, the `_redskills/*` methods, compat — never sees wire bytes,
// so the dialect is decided here and nowhere else. The framing and the
// downgrade-safe rules are the resident wire's, reused rather than respelled
// (`@reddb-io/shared/resident-wire.js` owns them, and its tests prove them):
//
// 1. **Every frame is sniffed on its own bytes.** A frame opening with `{` or
//    `[` is one line of JSON (a `[` can only be a JSON-RPC batch); anything
//    else is a TOON document terminated by a blank line. No peer is told,
//    asked, or configured — which is what lets the five external agents keep
//    speaking plain JSON-RPC through the same door.
// 2. **The consumer always sees `jsonrpc: "2.0"` objects.** On the TOON wire
//    the envelope field is `toonrpc: "1.0"` (the TOON-RPC 1.0 spelling of the
//    same JSON-RPC 2.0 semantics); the codec rewrites the envelope at the
//    boundary in both directions, so the SDK stack rides either dialect
//    unmodified. A batch array passes through with each element normalized.
// 3. **Writes answer in kind.** Until the peer has proven a dialect by sending
//    a frame this codec could DECODE, writes use `preferred` — default
//    `"json"`, so shipping this codec changes nothing observable until a peer
//    that WRITES TOON exists. Flipping a single caller's `preferred` later is
//    the whole second slice, gated on porting the resident wire's downgrade
//    proof to this connection shape first.
//
// **Behavioral parity with the SDK's `ndJsonStream` is the contract.** The
// codec is under every ACP socket in the system, so anything it does that
// `ndJsonStream` did not is a regression wearing a feature's name: a malformed
// frame is reported and SKIPPED (never a torn-down connection), the final
// unterminated frame at end of input is flushed, and `cancel` releases the
// socket reader instead of leaking it.
import type { Stream } from "@agentclientprotocol/sdk";
import {
  encodeWireFrame,
  takeWireFrame,
  decodeWireFrameStrict,
  type ResidentWireDialect,
} from "@reddb-io/shared/resident-wire.js";

/** The envelope markers, spelled once: JSON-RPC 2.0 on JSON, TOON-RPC 1.0 on TOON. */
export const JSONRPC_ENVELOPE_VERSION = "2.0";
export const TOONRPC_ENVELOPE_VERSION = "1.0";

export interface DualDialectOptions {
  /** Dialect written before the peer has proven one. Default `"json"`. */
  preferred?: ResidentWireDialect;
}

type WireMessage = Record<string, unknown>;

/**
 * A drop-in for `ndJsonStream(output, input)` that reads both dialects and
 * answers in the one the peer last proved.
 */
export function dualDialectStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options?: DualDialectOptions,
): Stream {
  const preferred: ResidentWireDialect = options?.preferred ?? "json";
  let peerDialect: ResidentWireDialect | undefined;
  const textEncoder = new TextEncoder();
  const writer = output.getWriter();

  const writable = new WritableStream<WireMessage>({
    async write(message) {
      const dialect = peerDialect ?? preferred;
      await writer.write(textEncoder.encode(encodeWireFrame(outboundEnvelope(message, dialect), dialect)));
    },
    async close() {
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    },
    async abort(reason) {
      try {
        await writer.abort(reason as Error);
      } finally {
        writer.releaseLock();
      }
    },
  });

  let buffer = "";
  const reader = input.getReader();
  const decodeAndEnqueue = (
    controller: ReadableStreamDefaultController<WireMessage>,
    frame: string,
    dialect: ResidentWireDialect,
  ): void => {
    let decoded: unknown;
    try {
      decoded = decodeWireFrameStrict(frame, dialect);
    } catch (error) {
      // Parity with `ndJsonStream`: a frame this codec cannot read is reported
      // and skipped — one bad frame must never tear down a connection carrying
      // every other session's traffic.
      console.error(
        `dual-dialect stream: skipping an unreadable ${dialect} frame (${
          error instanceof Error ? error.message : String(error)}): ${frame.slice(0, 200)}`,
      );
      return;
    }
    // The latch moves only on PROOF — a frame that decoded. A garbage frame
    // that merely failed to open with `{` must never flip a JSON-only peer's
    // connection into receiving TOON it cannot read.
    if (peerDialect !== dialect) {
      if (peerDialect !== undefined) {
        console.error(`dual-dialect stream: peer moved from ${peerDialect} to ${dialect}`);
      }
      peerDialect = dialect;
    }
    controller.enqueue(inboundEnvelope(decoded));
  };
  const readable = new ReadableStream<WireMessage>({
    async start(controller) {
      const textDecoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += textDecoder.decode(value, { stream: true });
          for (;;) {
            const taken = takeWireFrame(buffer);
            if (taken === null) break;
            buffer = taken.rest;
            decodeAndEnqueue(controller, taken.frame, taken.dialect);
          }
        }
        // Parity with `ndJsonStream`'s flush: a final frame written without
        // its terminator before close is still a frame, not silence.
        const remainder = buffer.trim();
        if (remainder !== "") {
          decodeAndEnqueue(
            controller,
            remainder,
            remainder.startsWith("{") || remainder.startsWith("[") ? "json" : "toon",
          );
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      // The SDK cancels its reader on connection close; without this the
      // underlying socket reader lock was never released and the descriptor
      // outlived every session it served.
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return { writable, readable } as Stream;
}

/**
 * The envelope a message wears on the wire: `toonrpc: "1.0"` on TOON frames,
 * `jsonrpc: "2.0"` on JSON frames. Everything else travels untouched. A batch
 * array is left whole — `encodeWireFrame` writes any array as one JSON line.
 */
function outboundEnvelope(message: WireMessage, dialect: ResidentWireDialect): WireMessage {
  if (dialect !== "toon" || Array.isArray(message)) return message;
  const { jsonrpc: _jsonrpc, ...rest } = message;
  return { toonrpc: TOONRPC_ENVELOPE_VERSION, ...rest };
}

/**
 * The envelope the SDK expects, whatever the wire wore. A TOON frame that kept
 * a `jsonrpc` field (a peer that framed TOON without adopting the TOON-RPC
 * envelope) is normalized the same way. A JSON-RPC batch array is passed
 * through with each element normalized — the SDK's own batch handling takes it
 * from there.
 */
function inboundEnvelope(decoded: unknown): WireMessage {
  if (Array.isArray(decoded)) {
    return decoded.map((element) => inboundEnvelope(element)) as unknown as WireMessage;
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { jsonrpc: JSONRPC_ENVELOPE_VERSION, invalid: decoded } as WireMessage;
  }
  const { toonrpc: _toonrpc, jsonrpc: _jsonrpc, ...rest } = decoded as WireMessage;
  return { jsonrpc: JSONRPC_ENVELOPE_VERSION, ...rest };
}
