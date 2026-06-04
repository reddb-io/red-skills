# Memory tier maps directly to VERSIONED collection policy

## Status

accepted.

## Context

PRD #103 chose RedDB's native git-for-data layer as the substrate for the
**VCS-versioned memory graph**. That makes per-collection `VERSIONED` opt-in a
Memory plugin policy decision, not an implementation detail left to each write
path.

The canonical **Memory tier** definitions live in `.red/CONTEXT.md`:

- `durable` is the default for stored facts, decisions, code, and other
  long-lived project knowledge.
- `reasoning` is for durable agent reasoning evidence such as `why_note` traces
  and **Reasoning attempts**.
- `ephemeral` is for transient session-like memory with a TTL horizon.

RedDB's git-for-data overview (`../reddb/docs/vcs/overview.md`) says user
collections are non-versioned by default and opt in with
`ALTER TABLE ... SET VERSIONED = true`. It also names the storage reason for
the boundary: non-versioned row versions remain reclaimable by `VACUUM`, so
churning data such as sessions, caches, and queues should stay out of VCS and
be pruned aggressively.

PRD #103 is the binding PRD for this decision. Its Human Decisions adopted
RedDB VCS for slice 1's per-clone substrate and its Implementation Decisions
named `applyTierVersioning(memoryStore)` as the module that translates Memory
tier policy into RedDB collection opt-in.

## Decision

Memory tier maps directly onto RedDB's per-collection `VERSIONED` flag:

| Memory tier | `VERSIONED` | Rationale |
|-------------|-------------|-----------|
| `durable` | `true` | Facts, decisions, files, symbols, validations, and other project knowledge need reproducible history and `AS OF` queries. |
| `reasoning` | `true` | Reasoning attempts and why-notes are audit evidence; they need the same historical anchor as the project graph they explain. |
| `ephemeral` | `false` | Sessions, caches, and short-TTL memory churn without long-term audit value and should remain VACUUM-reclaimable. |

The Memory plugin enforces this at the collection boundary. Collections that
store `durable` or `reasoning` graph data opt into RedDB VCS; collections that
store only `ephemeral` graph data explicitly stay out. The policy is applied
idempotently by `applyTierVersioning(memoryStore)`, including first-time Graph
mode initialization and re-runs for existing per-clone stores.

Future Memory tiers must declare their `VERSIONED` stance when the tier is
introduced. A new tier cannot rely on the default or inherit by accident; the
ADR/CONTEXT update that defines the tier must also say whether its collections
participate in the VCS-versioned graph.

## Alternatives considered

- **Version everything.** Rejected because it contradicts RedDB's own
  default-off guidance and would preserve high-churn ephemeral data that has no
  durable audit value. Session and cache history would bloat stores and weaken
  `VACUUM` as the main disk-cost lever.
- **Version nothing.** Rejected because it throws away the substrate PRD #103
  deliberately chose: `AS OF` queries, reproducible codebase maps, and
  historical reasoning evidence all require versioned durable/reasoning graph
  collections.
- **Enforce only at write time per node.** Rejected because RedDB's VCS control
  is per collection. A per-node policy would be easier to drift, harder to
  audit during init, and unable to express whether a table participates in
  `vcs_diff`, merge, and `AS OF` semantics.

## Consequences

- `durable` and `reasoning` Memory graph collections become part of the
  **VCS-versioned memory graph** and can later support `AS OF <git-sha>`
  codebase-understanding surfaces.
- `ephemeral` collections remain outside VCS, preserving the intended TTL and
  VACUUM behavior for session-like data.
- `/memory:init --mode graph` and any migration/re-run path should report which
  collections were versioned and which were skipped so users can audit the
  tier boundary.
- New Memory tiers require an explicit `VERSIONED` decision at introduction
  time, keeping tier semantics, persistence, and storage-cost policy aligned.
- The **Public codebase map** can safely exclude `ephemeral` data because the
  graph substrate itself keeps that tier out of versioned collections.
