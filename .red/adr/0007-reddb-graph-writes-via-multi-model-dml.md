# RedDB graph writes go through multi-model DML, not table inserts

## Status

accepted.

The `memory` plugin's graph store (`MemoryStore`, ported from red-memory's
`packages/core`) writes typed nodes and edges to embedded RedDB graph
collections. The store was first written with table-collection idioms
(`db.insert(collection, payload)`, `UPDATE collection SET …`, `SELECT … WHERE
properties.hash = …`). Every node/edge write was rejected by the engine —
`INVALID_OPERATION: collection 'memory_nodes' is declared as 'graph' and does
not allow 'table' writes` — which blocked all engine-backed memory work
(PRD #66, slice #67).

## Decision

Graph writes use RedDB's **multi-model DML with the explicit entity keyword**,
issued through `db.query` over the embedded `file://` transport:

- Node: `INSERT INTO <coll> NODE (label, node_type, hash, properties) VALUES (…) RETURNING *`
- Edge: `INSERT INTO <coll> EDGE (label, from, to, weight, properties) VALUES (…) RETURNING *`
- The engine-assigned id is read from `red_entity_id` in the `RETURNING *` row.

This is a **consumer-side fix** — no change to `@reddb-io/sdk` or the engine.
The SDK's generic `db.insert` and bare `UPDATE`/`SELECT` default to table
semantics; the graph surface requires the `NODE`/`EDGE`/`NODES`/`EDGES`
keywords.

Two engine constraints follow from the same root and shape the design:

- **Dedupe lookup lives in KV, not SQL.** `SELECT … WHERE <col>` over a graph
  collection only filters on `label`/`node_type`; `WHERE hash = …` (top-level
  or `properties.hash`) matches nothing. So the node hash→rid and edge
  (from,to,label)→rid dedupe indexes are stored in the `memory_kv` collection
  and read on upsert, instead of a content query.
- **`db.kv` is callable.** The KvClient only exists once invoked with a
  collection — `db.kv(coll).get/put`, never `db.kv.get`. The original store had
  this latent bug in `kvGet`/`kvPut`; both are now fixed.

`accessed_at`/`access_count` touch-on-recall is **deferred to the tier + decay
work (#68 / #72)**: graph collections reject table-style `UPDATE`, and the
multi-model `UPDATE … NODES SET properties = …` form collides with the reserved
`PROPERTIES` keyword. Recall correctness does not depend on the touch.

## Why

- **It works against the real engine.** Proven by a round-trip smoke against the
  bundled RedDB binary: node insert + content-dedupe (same hash → same rid),
  edge insert + dedupe, `stats` counts. The spike that established this is the
  acceptance bar for #67.
- **No upstream dependency.** A consumer-side fix unblocks the whole engine-backed
  roadmap (#52, #68–#73) now, with no wait on an SDK/engine release. A
  `db.graph` helper in `@reddb-io/sdk` would be a nice ergonomic wrapper later,
  but is not required and is tracked only as an optional follow-up.
- **KV dedupe is robust and uses a proven primitive.** It sidesteps the graph
  SELECT/WHERE limitation entirely rather than fighting it, and keeps upsert
  idempotent.

## Rejected alternatives

- **Raw stdio JSON-RPC against `/collections/<c>/nodes`.** The HTTP/RPC node and
  edge endpoints exist, but the embedded `file://` transport does not speak
  them; DML over `db.query` is the portable path for both embedded and wire
  transports. Rejected.
- **Contributing a `db.graph` client upstream first.** Adds a release dependency
  to the critical path for no functional gain over the DML form. Deferred to an
  optional follow-up.
- **Dedupe by making the content hash the node `label`.** `label` is the
  human-facing graph identity used by neighborhood/traversal; overloading it
  with a content hash corrupts that semantic. Rejected in favour of the KV
  index.

## Consequences

- `MemoryStore.upsertNode` / `upsertEdge` are the single encapsulated write
  path; the DML strings and KV indexes are implementation details behind them.
- The fix currently lives in `red-memory/packages/core`; it travels into
  `plugins/memory/` when #52 ports the graph store.
- #52 inherits a documented constraint set: graph collections reject table-style
  INSERT/UPDATE, SELECT/WHERE filters only `label`/`node_type`, and whole-blob
  `SET properties` is blocked — read/update/dedupe paths must account for these.
