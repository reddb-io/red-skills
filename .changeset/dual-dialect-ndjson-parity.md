---
"@reddb-io/protocol-acp": patch
"@reddb-io/shared": patch
---

The ACP dual-dialect codec reaches behavioral parity with ndJsonStream (ADR 0170): JSON-RPC batch frames read as arrays instead of head-of-line-blocking the connection, a malformed frame is reported and skipped instead of tearing the connection down, frames decode strictly in their sniffed dialect, the dialect latch moves only on a decoded frame, cancel releases the socket reader, and the final unterminated frame is flushed at end of input.
