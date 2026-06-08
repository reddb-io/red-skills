# Dev owns the codebase understanding surface; memory owns the graph

## Status

accepted.

We want RedSkills to learn from external codebase-understanding systems without
copying their naming or creating a competing graph store. The existing
**Memory plugin** already has **Graph mode**, graph traversal/read verbs,
community-coloured export, and repo ingestion. The gap is an engineering
workflow surface in `dev` that can use that graph to explain architecture,
module/skill interdependencies, and change impact.

The external reference that triggered this discussion uses an `/understand`
surface and an interactive knowledge graph pipeline. We should learn from the
shape of the workflow, but not adopt that command name or imply that RedSkills
is cloning that product.

## Decision

The codebase understanding surface belongs in the `dev` plugin. The Memory
plugin remains the owner of graph storage, graph traversal, recall, export,
community detection, and indexing. `dev` may soft-use Memory graph-mode verbs
directly (`neighbors`, `path`, `stats`, and export-derived reads) when they are
available, and must degrade to `memory recall` or ordinary code exploration when
Memory is absent or not in Graph mode.

The first concrete workflow is graph-backed `zoom-out`, not a new
`/understand` command. `zoom-out` is map-first: it should explain relevant
modules/layers, relationships, critical paths, and risks/gaps. It is read-only
with respect to the graph; if graph indexing is missing or stale, it should ask
the user to run `/memory:ingest` rather than reindex implicitly.

A future `ask` surface may answer natural-language engineering questions over
the same project knowledge, but it is deferred until graph-backed `zoom-out`
proves useful. `ask` is a distinct contract from `zoom-out`: direct answer first
instead of map first.

## Why

- **Plugin boundaries stay clean.** `dev` owns engineering workflows; `memory`
  owns graph persistence and graph operations. This follows the existing
  one-directional soft-use relationship from `dev` to `memory`.
- **No duplicate graph store.** Building a separate codebase-understanding graph
  beside Memory Graph mode would split indexing, traversal, export, and health
  checks across two systems.
- **Naming stays respectful and unambiguous.** Avoiding `/understand` reduces
  confusion with the external project and keeps RedSkills terminology grounded
  in its existing `zoom-out` workflow.
- **The first slice is small.** Enhancing `zoom-out` validates whether the graph
  contains enough signal before designing a larger chat/query product.
- **Operational behavior remains predictable.** `zoom-out` reading the graph is
  cheap and safe; implicit full-repo ingest could be slow, surprising, and
  difficult to explain.

## Rejected alternatives

- **Create a new `/understand` skill in `dev`.** Rejected because the name is
  too close to the external reference and the scope invites a product-sized
  clone before validating the graph-backed workflow.
- **Put the whole surface in `memory`.** Rejected because Memory should remain a
  storage/query substrate, not accumulate every engineering workflow that uses
  memory.
- **Create a second graph store for codebase understanding.** Rejected because
  Graph mode already solves the persistence/traversal/export side and should be
  deepened rather than bypassed.
- **Have `zoom-out` auto-ingest before answering.** Rejected because `zoom-out`
  should remain a read-oriented explanation command; ingestion is an explicit
  Memory operation.

## Consequences

- `zoom-out` can grow a Memory-aware path while remaining usable in repos
  without Memory installed.
- Memory graph-mode verbs need to stay scriptable and stable enough for `dev`
  skills to call as optional read primitives.
- Future work on `ask` should start from the same boundary: `dev` workflow,
  Memory-backed context when available, ordinary code exploration as fallback.
- Documentation and skill naming should avoid `/understand` for this surface.

## Status

Accepted; post-0041 supersession applies **on migration**. The surviving
decision is the boundary: `dev` owns the codebase-understanding workflow surface
and Memory owns the graph/query substrate. What is obsoleted on migration is the
assumption that `dev` consumes an in-repo Memory CLI or graph-mode verbs by
shelling through local `memory ...` commands. After ADR 0041 lands, `dev`
consumes project memory through the `red-memory` MCP exposed by the migrated
memory plugin; the in-repo implementation and CLI are no longer the contract.
This record does not rewire the implementation; that migration work is tracked
separately.

## Related

- ADR 0041 — red-skills consumes the `red-memory` and `red-ui` MCPs instead of
  building the memory plugin in this repo.
