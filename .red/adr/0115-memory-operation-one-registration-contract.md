# 0115 — One Memory operation registration owns the whole contract

- **Status**: accepted
- **Date**: 2026-07-20
- **Related**: ADR 0036 (Memory transports are adapters over the operation registry), ADR 0013 (dev owns the codebase-understanding surface; memory owns the graph), ADR 0089 (AXI + TOON doctrine for agent-facing CLIs)

## Context

ADR 0036 fixed the **direction**: the Memory operation registry is the single
seam, and CLI, MCP, and HTTP are Transport adapters that consume it. It named
two declarative facets — input binding and output kind — but stopped short of
the **shape**: exactly what one registration must own, and what a transport
adapter is still allowed to know.

#2239 asks that question directly, with a falsifiable test:

> Adding a new read-only Memory operation should touch **one registration and no
> transport file.**

Today that test fails. The registration already carries `execute`, `inputSchema`,
`outputSchema`, the two 0036 facets, and `renderer.{cli,mcp}` metadata — but the
transports still carry per-operation knowledge the registration does not own:

- `http-server.ts` hand-maintains an `ENDPOINTS` list, a per-path `openApiDocument`,
  a `REGISTRY_HTTP_EXCLUDED_OPERATION_IDS` set, and `httpRoutesForOperation` /
  `defaultHttpRouteForOperation` special cases (context-pack, smart-search,
  memory.health). A new operation must be hand-added there.
- Help/usage text is phrased per transport (CLI usage string, MCP tool
  description) rather than owned by the operation and rendered per transport.
- Which transports a given operation is even visible on is implicit — encoded by
  exclusion sets and route tables, not declared on the operation.

So the seam exists but the **contract boundary** is unstated, and a future reader
adding a surface still edits transport files.

## Decision

**A single Memory operation registration owns the complete operation contract.
A transport adapter owns only transport-mechanical concerns and carries no
per-operation logic.**

### The registration owns

1. **Behaviour** — `execute(ctx, input) → output`, pure: it returns the typed
   report/artifact and never touches a sink.
2. **Input schema** — the zod `inputSchema`, plus ADR 0036's per-field **input
   binding** facet (where each field comes from). Field names are declared once,
   here.
3. **Output kind** — ADR 0036's `report` (JSON/markdown) vs `viewer`
   (self-contained HTML, optional file sink) facet.
4. **Structured content** — *is* the report's typed output. This is **not a new
   facet**: MCP renders the typed `execute` result as its structured content
   directly. `outputSchema` already types it.
5. **Help / description** — operation-owned text. The operation states what it
   does once; each transport renders it its own way (CLI usage, MCP tool
   description, OpenAPI summary).
6. **Transport visibility** — a declarative `transports` field (e.g.
   `["cli", "mcp", "http"]`) on the registration. Which surfaces an operation
   appears on is a property of the operation, not a transport-side exclusion set.

### The adapter owns (and *only* this)

- The kebab (`--max-bytes`) ⟷ snake (`max_bytes`) case transform.
- Binding input from its own transport (argv / MCP arguments / query+body) into
  the operation's declared input.
- Routing output to its sink (stdout, MCP result, HTTP response, viewer file).
- Generic dispatch over the registry.
- Rendering the operation's owned help in its own idiom.

No transport file may branch on an operation id for behaviour, routing,
schema, or help.

### Net new over ADR 0036

Only two things join the two existing facets: the declarative **`transports`**
visibility field and the operation-owned **help/description**. Structured
content adds no facet (it is the typed report). The ~2 genuinely irregular
operations (the joined-positional query, the hashed viewer output path) keep
ADR 0036's **bounded custom-bind escape hatch** rather than forcing a
per-operation bind onto every registration.

### The test of the answer

Adding a new read-only Memory operation is one registry entry — behaviour,
schema, binding, output kind, help, and `transports`. CLI command, MCP tool, and
HTTP route + OpenAPI entry all follow from it. No transport file changes. That is
the property MCP already has (ADR 0036), now generalised to CLI and HTTP.

## Consequences

- **The boundary is now falsifiable, not aspirational.** "Touches one
  registration and no transport file" is the acceptance test for the
  implementation and for every future operation added.
- **Migration is expand → migrate → contract**, because the operation count
  (~80 report/viewer surfaces) warrants slicing:
  1. *Expand* — add the `transports` field and operation-owned help to the
     registration type as additive, backward-compatible facets (defaulted so
     un-migrated operations stay valid).
  2. *Migrate* — make the CLI and HTTP adapters generic over the registration
     (as MCP already is): derive routes, the OpenAPI document, `ENDPOINTS`, and
     help from the registry; retire the per-operation route tables, exclusion
     sets, and hand-written OpenAPI paths one family at a time. The tree stays
     green throughout because un-migrated operations keep their hand-wired paths
     until converted.
  3. *Contract* — remove the now-dead transport-side per-operation code and the
     defaults once every operation declares its facets.
- **Drift dies at the source.** Field names, help text, and transport visibility
  each exist once. The kebab/snake divergence and the parallel OpenAPI hand-list
  stop being edit sites.
- **Mutating and infrastructure routes stay outside** the registry (ADR 0036's
  scope boundary is unchanged): `/api/autocure` POST, `/openapi.json`,
  `/api/health`, and the workbench shell remain hand-wired.
- **A future reader won't re-grow the duplication.** Without this record the
  natural move when adding a surface is to copy the nearest hand-wired route or
  usage string — exactly what this contract forbids.

## Follow-up

The implementation is scheduled as expand→migrate→contract Tickets against this
ADR; #2239 records the decided shape. The `memory` glossary
(`.red/contexts/memory/CONTEXT.md`) definitions of **Memory operation** and
**Transport adapter** are extended to name the `transports` visibility field and
operation-owned help as part of the *expand* slice.
