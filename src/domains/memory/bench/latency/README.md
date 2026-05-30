# Latency bench workload

`memory bench latency` (issue #186, parent PRD #174) measures p50 / p95 / p99 /
p99.9 of three hot-read op classes against two strategies:

- **ours** — direct in-process Map lookup, mirroring an L1/L2 cached read
  against the local RedDB-backed graph store.
- **ams_reference** — the same logical read against a JSON-serialised payload
  (`JSON.parse` per response, client-side fan-out across keys for graph hops).
  This models what any Redis-backed `agent-memory-server` pays on every hot
  read — no artificial sleeps, only the real CPU work a Redis client cannot
  avoid even on localhost.

## Op classes

| op | semantics |
| --- | --- |
| `working-get` | Fetch an entire L2 session's event list by session id. |
| `session-recall` | Top-`k` scan over a single L2 session's events. |
| `long-term-recall` | Fan-out across `FANOUT=8` L3 long-term node ids. |

## Workload

Defaults (see `DEFAULT_WORKLOAD` in `src/bench-latency.ts`):

| knob | value |
| --- | --- |
| `sessions` | 32 |
| `events_per_session` | 24 |
| `long_term_nodes` | 512 |
| `payload_chars` | 256 |
| `iterations` | 5000 |
| `warmup` | 500 |
| `seed` | `0xa11ce` |
| `op_classes` | `working-get,session-recall,long-term-recall` |

Override individual fields with CLI flags (`--iterations`, `--warmup`,
`--seed`, `--ops`) or by dropping a `workload.json` in this directory — it is
merged on top of the defaults and CLI flags then override that.

## Determinism and tolerance

- **Workload sequence is byte-deterministic** across runs: the session/key
  access order is seeded `mulberry32(seed)` with fixed warmup + iteration
  counts. Same git ref + same flags ⇒ identical reads in identical order.
- **Measured wall-clock percentiles vary with host noise** — JIT, GC, kernel
  scheduling, thermal state. Treat results as comparisons within a single
  report, not absolute claims across machines. Typical run-to-run drift on a
  quiet developer laptop sits within roughly ±20% at p50 and ±50% at p99.9.
- The test suite asserts the *architectural* invariant only:
  `p99(ams_reference) >= p99(ours)` for each op class. The wire-protocol path
  cannot be faster than direct in-process access on the same machine — if that
  ever flips, the bench (or our hot-read path) has regressed.

Re-publish a dated report under `../results/` whenever the workload, op
implementations, or default knobs change.
