# Ephemeral-tier expiry is enforced client-side, not by engine TTL

## Status

accepted.

Issue #68 (PRD #66) adds a **Memory tier** to graph nodes
(`ephemeral | durable | reasoning`) so transient session memory expires
automatically while durable knowledge never auto-deletes — resolving the
contradiction between RedDB's auto-expiring TTL and the project's "no automatic
deletion" guarantee. The acceptance criterion is that an `ephemeral` node
"expires under RedDB TTL after its horizon".

The obvious implementation is to lean on the engine: write each ephemeral node
(or a marker keyed to it) with the SDK's `expireMs` and let RedDB reap it. A
spike against the bundled embedded `red` binary showed this does not hold:

```
kv.put("k", "v", { expireMs: 1000 })
get("k") @ t=0   → "v"
get("k") @ t=3s  → "v"     // still present, 3× past the TTL
get("k") @ t=8s  → "v"     // still present
```

The embedded (`file://`, stdio JSON-RPC) transport does not sweep KV TTL
promptly — an expired entry stays readable well past its horizon. The
TTL-bearing `cache.*` API is no help either: it requires an HTTP/gRPC transport
and throws `UNSUPPORTED_TRANSPORT` on the embedded handler (same constraint
family as ADR 0007). So the engine cannot be the source of truth for *when* an
ephemeral node disappears.

## Decision

Expiry is **enforced client-side** from a stored horizon, at a single read
choke point:

- `upsertNode` resolves the tier (`props.tier ?? defaultTier(node_type)`) and,
  for `ephemeral` nodes only, stamps `properties.expires_at = created_at + ttl`
  (`ephemeralTtlMs`, default 24h). `durable`/`reasoning` nodes carry no
  `expires_at`.
- `MemoryStore.listNodes(now = Date.now())` drops any node with
  `tier === "ephemeral" && now >= expires_at`. Because recall, `getNode`, and
  `doctor` all read through `listNodes`, an expired ephemeral node vanishes from
  every consumer at once. `now` is injectable so expiry is deterministically
  testable without sleeping.
- `upsertNode` **also** writes a KV expiry marker (`node:expiry:<rid>`) with
  `expireMs`. This is forward-compatible belt-and-braces: a TTL-capable
  transport/engine build will reap the underlying row, but correctness never
  depends on it.

`defaultTier`: `session → ephemeral`, `why_note → reasoning`, everything else
(facts, decisions, code, …) → `durable`. `memory:doctor` skips `ephemeral`
nodes entirely (TTL owns them) and continues to flag stale `durable`/`reasoning`
nodes without ever auto-deleting.

## Why

- **It works against the real engine today.** The client-side horizon is exact
  and does not wait on an SDK/engine release to make embedded KV TTL eager —
  the same "consumer-side fix, no upstream dependency" stance as ADR 0007.
- **One choke point.** Filtering in `listNodes` keeps expiry semantics in one
  place instead of scattering `now >= expires_at` across recall, doctor, and
  every future read path.
- **Deterministic tests.** An injectable `now` proves "ephemeral expires,
  durable survives" without real-time sleeps.

## Rejected alternatives

- **Rely solely on KV `expireMs` / engine TTL.** Empirically not swept promptly
  on the embedded transport; would make expiry unobservable and untestable.
  Kept only as a forward-compat marker, never as the guarantee.
- **Physically `DELETE` expired nodes on a timer or on read.** Graph
  collections reject `DELETE … WHERE rid` (ADR 0007); deletion only works by
  `(label, node_type)` and is reserved for `doctor`'s confirmed prune. A
  background reaper adds a moving part for no gain over a read-time filter.
- **Per-node KV TTL marker as the read gate** (presence ⇒ live). Same prompt
  problem as above, plus an extra KV read per node on every `listNodes`.

## Consequences

- An expired ephemeral node's graph row physically remains in the `.rdb` store
  until a future engine build (or `doctor` prune) reaps it; it is simply never
  surfaced. Acceptable — the store file is local, gitignored state.
- `listNodes` gained an optional `now` parameter; all existing callers pass none
  and get wall-clock semantics.
- If a later engine build sweeps KV TTL eagerly, the existing `node:expiry:<rid>`
  markers already carry the right horizon — no migration needed.
