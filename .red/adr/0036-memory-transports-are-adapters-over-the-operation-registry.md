# Memory transports are adapters over the operation registry, not hand-wired dispatch

## Context

Memory exposes ~80 read-only surfaces (the report + viewer pairs in the
`memory` glossary) over three transports: CLI, MCP, and an optional local HTTP
server. A seam for these already exists — `MemoryOperation<Input, Output>` in
`src/apps/memory/src/operations.ts`, indexed by
`createReadOnlyMemoryOperationRegistry`, carrying `inputSchema`, `outputSchema`,
`execute`, and `renderer.{cli,mcp}` metadata.

Only one transport actually consumes it. **MCP** is a pure adapter:
`mcp-server.ts` generates its tool list from
`listReadOnlyMemoryOperations()`, so a new operation yields an MCP tool for
free. **CLI** mostly bypasses the registry — ~58 hand-written
`runXxxReport` / `runXxxViewer` functions each re-open the store, re-parse argv,
call the `buildXxx` function directly, and format output. **HTTP** bypasses it
entirely — ~70 hand-written `url.pathname === "..."` route checks, no registry
import.

The cost is concrete drift surface, not just verbosity:

- An operation's input field names are written **three times** — the zod
  schema, the CLI flag parse, and the HTTP query parse — differing only by
  kebab (`--max-bytes`) vs snake (`max_bytes`) convention.
- The viewer output-path / file-write concern (`--out`) is re-implemented in
  every viewer function (34 occurrences).
- Transport wiring is largely untested across all the report/viewer pairs;
  a refactor can silently break output for any one of them.

A `/improve-codebase-architecture` review measured the binding vocabulary and
found it small and regular (`limit`, `query`/`q`, `max-bytes`, `stale-days`,
`depth`, `rid`, `path`, `kind`, ...), composed from shared schema bases
(`ScopeInputSchema.extend(...)`). The only genuinely irregular cases are ~2
(the joined-positional query, the hashed viewer output path).

## Decision

**The Memory operation registry is the single seam for all read-only Memory
surfaces. CLI, MCP, and HTTP are Transport adapters that consume it — they bind
input from their transport and route output to their sink, and never re-declare
dispatch per operation.**

To let CLI and HTTP become generic adapters (as MCP already is), the
`MemoryOperation` entry gains two declarative facets:

1. **Input binding** — a per-field descriptor of where each input comes from
   (`{ from: "positional" | "flag" | "param", name, type }`). The
   kebab/snake case transform is mechanical and owned by the adapter, not the
   operation. The ~2 irregular operations use a bounded escape hatch (a custom
   bind function) rather than forcing every operation to carry one.
2. **Output kind** — `report` (JSON or markdown to a stdout/response sink) vs
   `viewer` (a self-contained HTML artifact, with an optional file sink). This
   replaces the implicit `renderer.cli.supportsJson` + "type name ends in
   `…ViewerArtifact`" heuristic. `execute` stays pure: it returns the
   report/artifact; the adapter decides the sink.

**Scope boundary.** The registry covers only the read-only report/viewer
family. Mutating routes (e.g. `/api/autocure` POST) and infrastructure routes
(`/openapi.json`, `/health`, the workbench shell) stay hand-wired and outside
the registry. The registry's `assertReadOnlyOperation` guard already enforces
this on the read side.

The shared HTML helpers duplicated across viewers (`escapeHtml` ×34,
`metric` ×32, `jsonForScript` ×32) are extracted into one viewer-utils module.
That extraction lives behind `execute` and is independent of this decision — it
can land first as a low-risk quick win.

## Consequences

- **One registration, three transports.** Adding a report/viewer becomes a
  single registry entry; CLI command, MCP tool, and HTTP route follow
  automatically — the property MCP already has, generalised.
- **Drift dies.** Input field names exist once (the schema + binding); the
  CLI/HTTP hand-parses and the kebab/snake divergence go away. The `--out`
  file-sink logic exists once.
- **Test surface collapses.** Per-operation `execute` tests (input → output)
  remain the unit of coverage; transport correctness becomes one generic
  CLI-adapter test and one generic HTTP-adapter test instead of ~58 untested
  hand-wired paths.
- **Migration is incremental and reversible mid-flight.** Facets are added to
  the registry first; one operation is migrated end-to-end as the proof; then
  the HTTP family, then the CLI family. Un-migrated operations keep their
  hand-wired functions until converted, so the tree stays green throughout.
- **A future reader won't "fix" it backwards.** Without this record, the
  natural move when adding a surface is to copy the nearest hand-wired
  `runXxx`/route — re-growing exactly the duplication this removes.

## Status

Accepted; not yet implemented. Recorded ahead of the work so the direction is
fixed before slicing.

## Related

- ADR 0013 — dev owns the codebase-understanding surface (consumer of Memory
  read surfaces; unaffected).
- `.red/contexts/memory/CONTEXT.md` — defines **Memory operation**, **Memory
  operation registry**, and **Transport adapter**.
