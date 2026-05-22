# Community-coloured graph needs a per-node assignment from the engine

`/memory:graph --communities` (#70, PRD #66) must colour each node in the
exported `graph.html` by the community it belongs to. The competitive point is
that RedDB does this with a **native** Louvain — no separate graph-algorithms
plugin, unlike the Neo4j-based competitor.

A spike against the bundled engine (`@reddb-io/sdk@1.2.5`, embedded `file://`)
established what the native surface actually returns.

## Finding

`GRAPH COMMUNITY ALGORITHM louvain` (and `label_propagation`) **works** embedded
and partitions correctly — a two-triangle seed yields
`[{community_id:"community:0",size:3},{community_id:"community:1",size:3}]`. But
it returns **only per-community aggregates** (`community_id`, `size`). There is
no node→community assignment available over the embedded DSL:

- The grammar accepts only `ALGORITHM`, `MAX_ITERATIONS`, `ORDER BY
  size|community_size`, `LIMIT`. Projections (`RETURN members`, `WITH MEMBERS`,
  `… MEMBERS`) are parse errors.
- A community run does not annotate nodes — `SELECT * FROM memory_nodes` carries
  no `community_id` column afterward.
- `@reddb-io/sdk` exposes no analytics/community helper; only generic
  `db.query`.
- The HTTP `/graph/analytics/community` endpoint is unreachable over the
  embedded `file://` transport (same constraint as [ADR 0007](0007-reddb-graph-writes-via-multi-model-dml.md)).

`GRAPH COMPONENTS` has the same shape (`component_id`, `size` — no membership),
so connected-components is not a fallback either.

## Decision

**#70 is blocked on an engine feature**, not implementable consumer-side without
abandoning the "native" claim. Filed **reddb-io/reddb#660** requesting the
engine expose per-node community assignment over `db.query` (embedded + wire) —
e.g. `GRAPH COMMUNITY … RETURN ASSIGNMENTS` → rows `{node_id, community_id}`, a
`members` column per community row, or writing `community_id` back onto nodes.
The internal Louvain pass already computes the assignment; this is a
return-shape change.

When #660 lands, #70 is small: a `MemoryStore.communities()` method issuing the
assignment query, a `community` field threaded into the export node objects
(`export.ts`), and a colour map keyed by `community_id` in the `graph.html`
node-draw path. The `[extra: string]: unknown` escape hatch on
`MemoryNodeProps` already accommodates the field with no schema change.

## Why not the alternatives

- **Derive membership client-side (label-propagation over the listed edges),
  seeded by the native community count.** Rejected: it would colour nodes by a
  *client* algorithm while claiming "native Louvain" — the AC's whole point is
  that the engine computes the communities. Honest only as a stopgap, and it
  duplicates logic the engine already runs.
- **Reduce #70 to a native summary (count + sizes in CLI / a legend in
  graph.html), no per-node colour.** Rejected: fails the AC's visual
  requirement (coloured clusters) and undersells the differentiator.

## Consequences

- #70 carries `## Blocked by … reddb-io/reddb#660` and sits `ready-for-human`
  until the engine feature ships. It is **not** AFK-eligible meanwhile.
- The dependent **#73** (competitive baseline harness / comparison table) loses
  the community-visualisation row until #70 lands; the rest of #73 is
  unaffected.
- No consumer code ships for #70 now — avoids a client-side community
  implementation we would have to rip out once the engine exposes assignments.

## Resolved (2026-05-22)

reddb-io/reddb#660 shipped in **`@reddb-io/sdk@1.3.1`**: `GRAPH COMMUNITY
ALGORITHM louvain RETURN ASSIGNMENTS` now returns `{community_id, node_id}` rows
(node_id as a string rid), verified against the bundled binary. #70 implemented
on the consumer side exactly as predicted above — `MemoryStore.communities()`
(rid→community map), an opt-in `community` field threaded through `export.ts`
(json + html), a deterministic golden-angle colour palette in `graph.html`, and
a `--communities` flag on `memory export` (alias `memory graph`). The SDK pin
moved `^1.2.5` → `^1.3.1`. Default export stays community-free (byte-identical).
