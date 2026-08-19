---
"@reddb-io/red-skills": patch
---

The dev bundle stops pulling the daemon body through a barrel import

Five modules took `socketAnswers` — a twenty-line socket probe — from
`./daemon.js`, the barrel that re-exports the whole lifecycle. The dev CLI
reaches one of them from `runtime/gh/band.ts`, so the daemon lifecycle, the ACP
control plane and the MCP client SDK all landed in `dist/dev.bundle.min.mjs`.
When #4026 gave the control plane a brain-store import, the SDK's bundled `ajv`
came with it and left five bare `require("ajv/dist/runtime/…")` calls in the
bundle — which the dev bundle contract forbids, so `main` went red on
`test-shard (4)` and the 3.22.0 release PR could not merge.

Each of the five now imports `./daemon/socket.js` directly. Same function, same
behaviour; the dev CLI's module graph no longer contains the daemon body.
