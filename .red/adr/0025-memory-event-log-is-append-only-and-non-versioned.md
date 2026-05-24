# Memory event log is append-only and non-versioned

## Context

The Memory moat foundation includes operational telemetry so Memory can reason
about agent work, not only stored facts. Existing Memory features already record
skill telemetry, reasoning attempts, validation evidence, hook-derived facts,
learning debt, and improvement proposals. Those features currently use graph
nodes, KV rollups, sidecar inputs, or command-specific records.

The product needs one telemetry substrate that can feed readiness, skill
evolution, audits, future UI, and competitive evaluation without turning every
raw lifecycle event into durable project memory.

## Decision

Memory introduces a **Memory event log** backed by a RedDB append-only/events
table.

The stable event contract is a generic envelope plus a typed payload:

- `id`
- `occurred_at`
- `kind`
- `source`
- `actor`
- `scope`
- `subject`
- `payload`
- `provenance`

`kind` determines the payload shape for domains such as skill telemetry,
attempt validation, hook runtime events, and lifecycle observations.

Skill telemetry is the first producer. The first implementation dual-writes:
existing KV rollups remain the serving path while skill events also append to
the event log as the new audit substrate.

The raw event log does not participate in RedDB VCS. Durable or reasoning
evidence derived from events may still be written to the VCS-versioned memory
graph, but the high-cardinality operational log itself stays non-versioned.

Raw event retention is configurable, with a long default retention horizon.
Rollups and durable/reasoning graph evidence preserve long-lived knowledge.

## Alternatives considered

- **Use queues first.** Rejected because the initial need is an audit log, not a
  consumable work queue. Queues can derive from the event log later.
- **Use time-series first.** Rejected because telemetry metrics are only one
  projection. The canonical record needs actor, subject, scope, payload, and
  provenance, not only metric samples.
- **Replace existing skill rollups immediately.** Rejected because skill
  telemetry is already a working feature. Dual-write lowers migration risk and
  lets the event log prove itself before readers switch.
- **Version the event log.** Rejected because raw operational events are
  high-cardinality and often ephemeral. Versioned durable/reasoning graph
  evidence remains the long-term audit surface.

## Consequences

- Event writes must be append-only and should not mutate old raw events.
- Skill telemetry tests must cover dual-write behavior without changing current
  rollup semantics.
- Event log readers should tolerate retention: absence of old raw events is not
  loss of durable Memory facts when derived evidence was promoted to graph.
- Future UI and `eval:competitive:v2` should consume event-log-derived evidence
  through the Memory readiness envelope rather than reading raw logs directly.
