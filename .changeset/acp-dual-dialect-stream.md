---
"@reddb-io/protocol-acp": patch
"@reddb-io/redskilled": patch
---

The ACP socket reads both JSON-RPC 2.0 and TOON-RPC 1.0, and answers in kind

`socketStream` now rides a dual-dialect codec: every frame is sniffed on its
own bytes (a `{` opens one line of JSON; anything else is a TOON document
terminated by a blank line — the resident wire's proven framing, reused), the
SDK above the stream always sees `jsonrpc: "2.0"` objects whatever the wire
wore, and writes answer in the dialect the peer last used, opening in JSON.
Nothing is observable until a TOON-writing peer ships; flipping one caller's
`preferred` to `"toon"` is the whole second slice. External agents keep
speaking plain JSON-RPC through the same door, unconfigured.
