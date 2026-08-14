---
name: guard-serialization
description: Keeps default structured data on TOON snapshots, TOONL streams, and TOON wire frames. Use when changing JavaScript or TypeScript source under apps or packages that reads, writes, or transports structured data.
paths:
  - "{apps,packages}/**/*.{js,cjs,mjs,ts,cts,mts,tsx}"
---

# Guard Serialization

<what-to-do>

**Use TOON for snapshots and TOONL for append streams** — encode structured
state with the shared TOON surface. Keep prose as prose; serialization applies
to structured payloads.

**Keep files truthful** — write every `*.toon` file with the TOON encoder and
read it with the sniffing decoder. Runtime JSON compatibility is a migration
aid, not permission to write JSON bytes under a TOON extension.

**Keep owned wires on TOON frames** — send with `encodeWireFrame` and receive
with `decodeWireFrame` from `@reddb-io/shared/resident-wire.js`. The decoder may
accept a legacy JSON frame while peers roll forward; the default writer emits
TOON.

**Classify an intentional JSON boundary** — prefer the explicit `--json` output
branch for a caller-requested format. For file or wire JSON that must remain,
record the site in `.red/contracts/toon-json-file-io-allowlist.json`; use
`external` with a one-line reason for a permanent external protocol, or
`migrate` for bounded conversion debt. Quoting a value inside an error message
is legibility rather than a payload.

**Finish with both dimensions green** — done means the touched flow defaults to
TOON on files and owned wires, every remaining JSON site is explicitly
classified, and `toon-json-guard.test.ts` passes.

</what-to-do>

<supporting-info>

The ratchet and its file/wire detection rules live in
`apps/dev/src/core/toon-json-guard.ts`. ADR 0097 owns the TOON and TOONL storage
formats; the shared resident-wire helpers own cross-process framing.

</supporting-info>
