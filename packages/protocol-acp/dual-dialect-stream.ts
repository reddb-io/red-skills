// dual-dialect-stream — the ACP socket's byte codec, speaking JSON-RPC 2.0 and
// TOON-RPC 1.0 on one stream.
//
// The ACP SDK's `Stream` is a pair of OBJECT streams: everything above it —
// the connection, the `_redskills/*` methods, compat — never sees wire bytes,
// so the dialect is decided here and nowhere else. The framing and the
// downgrade-safe rules are the resident wire's, reused rather than respelled
// (`@reddb-io/shared/resident-wire.js` owns them, and its tests prove them):
//
// 1. **Every frame is sniffed on its own bytes.** A frame opening with `{` is
//    one line of JSON; anything else is a TOON document terminated by a blank
//    line. No peer is told, asked, or configured — which is what lets the five
//    external agents keep speaking plain JSON-RPC through the same door.
// 2. **The consumer always sees `jsonrpc: "2.0"` objects.** On the TOON wire
//    the envelope field is `toonrpc: "1.0"` (the TOON-RPC 1.0 spelling of the
//    same JSON-RPC 2.0 semantics); the codec rewrites the envelope at the
//    boundary in both directions, so the SDK stack rides either dialect
//    unmodified.
// 3. **Writes answer in kind.** Until the peer has proven a dialect by sending
//    a frame, writes use `preferred` — default `"json"`, so shipping this
//    codec changes nothing observable until a peer that WRITES TOON exists.
//    Flipping a single caller's `preferred` later is the whole second slice.
import type { Stream } from "@agentclientprotocol/sdk";
import {
  encodeWireFrame,
  takeWireFrame,
  decodeWireFrame,
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
 * answers in the one the peer last used.
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
      await writer.close();
    },
    async abort(reason) {
      await writer.abort(reason as Error);
    },
  });

  let buffer = "";
  const readable = new ReadableStream<WireMessage>({
    async start(controller) {
      const textDecoder = new TextDecoder();
      const reader = input.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += textDecoder.decode(value, { stream: true });
          for (;;) {
            const taken = takeWireFrame(buffer);
            if (taken === null) break;
            buffer = taken.rest;
            peerDialect = taken.dialect;
            controller.enqueue(inboundEnvelope(decodeWireFrame(taken.frame)));
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return { writable, readable } as Stream;
}

/**
 * The envelope a message wears on the wire: `toonrpc: "1.0"` on TOON frames,
 * `jsonrpc: "2.0"` on JSON frames. Everything else travels untouched.
 */
function outboundEnvelope(message: WireMessage, dialect: ResidentWireDialect): WireMessage {
  if (dialect !== "toon") return message;
  const { jsonrpc: _jsonrpc, ...rest } = message;
  return { toonrpc: TOONRPC_ENVELOPE_VERSION, ...rest };
}

/**
 * The envelope the SDK expects, whatever the wire wore. A TOON frame that kept
 * a `jsonrpc` field (a peer that framed TOON without adopting the TOON-RPC
 * envelope) is normalized the same way.
 */
function inboundEnvelope(decoded: unknown): WireMessage {
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return { jsonrpc: JSONRPC_ENVELOPE_VERSION, invalid: decoded } as WireMessage;
  }
  const { toonrpc: _toonrpc, jsonrpc: _jsonrpc, ...rest } = decoded as WireMessage;
  return { jsonrpc: JSONRPC_ENVELOPE_VERSION, ...rest };
}
