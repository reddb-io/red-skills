# 0170 — The ACP socket speaks dual-dialect at ndJson parity

- **Status**: accepted
- **Date**: 2026-08-24
- **Related**: ADR 0148 (the shared ACP wire); ADR 0145 (`_redskills/*` methods); the resident wire in `packages/shared/resident-wire.ts`
- **Source**: E2E-flow repair of 2026-08-24, after #4302 landed slice 1 of the TOON-RPC migration

## Context

#4302 replaced the SDK's `ndJsonStream` with `dualDialectStream` under every ACP socket (control plane, project client, worker admission, operator client, native worker), pinned to `preferred: "json"` so the swap was believed observable-neutral. It was not a behavioral drop-in: a `[`-leading JSON-RPC batch frame sniffed as TOON and waited forever for a `\n\n` terminator, head-of-line-blocking the connection with no error; a malformed frame tore the whole connection down in silence where `ndJsonStream` logged and skipped; the lenient cross-dialect decode could hand truncated JSON to the TOON parser and enqueue a plausible mis-decode; the dialect latch moved on any non-`{` frame, unlogged; `cancel()` and the end-of-input flush were dropped; and the writer lock was held for the process lifetime. The migration left no ADR, no tracking issue, and no grep-able marker — this document is that record.

## Decision

The codec stays, and **behavioral parity with `ndJsonStream` is its contract**: anything `dualDialectStream` does that `ndJsonStream` did not is a regression wearing a feature's name.

- **Sniff rule**: a frame opening with `{` or `[` is one JSON line; anything else is a TOON document terminated by a blank line. A `[` can only be a JSON-RPC batch.
- **Arrays always travel as JSON lines**, in either dialect (`encodeWireFrame`). A TOON root-form array is therefore deliberately unrepresentable on this wire; every envelope is an object, which the wire's rules already required.
- **Frames decode strictly in their sniffed dialect** (`decodeWireFrameStrict`). The lenient cross-dialect decode remains only on the trusted resident op socket, where rule 1 wants it.
- **A bad frame is reported and skipped, never fatal.** The dialect latch moves only on a frame that decoded; a latch change is logged.
- **`cancel` releases the socket reader; end-of-input flushes the final unterminated frame.**

## Slice 2 precondition (recorded, not implemented)

No caller flips `preferred: "toon"` until both hold:

1. The resident wire's rule-3 downgrade proof (`isUnintelligibleResponse` → `rememberJsonOnlyPeer`) has an ACP-connection analogue — the request/response shape does not port 1:1 to a long-lived bidirectional connection, and rule 3 is what makes writing TOON first survivable against a JSON-only peer.
2. The legacy op socket no longer answers a post-parse handler failure with a fresh id (`daemon/socket.ts`), which is byte-identical to the pre-parse proof and silently downgrades healthy TOON peers.

`packages/worker/src/acp/child-agent.ts` stays on `ndJsonStream` by design: the stdio edge to external agents is plain JSON-RPC and negotiates nothing.

## Consequences

The JSON-on-JSON path is exercised by every ACP suite; the parity behaviors are pinned in `apps/redskilled/tests/acp-dual-dialect-stream.test.ts`, and the framing rules in `packages/shared/resident-wire.test.ts`. TOON root arrays cannot cross this wire — accepted, envelopes are objects by prior rule.
