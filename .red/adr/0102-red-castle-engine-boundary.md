# Red-castle owns the quarantined GitHub-aware AFK engine

## Status

Accepted; amended by ADR 0124, which replaces the remaining-surface list with
the host-adapter criterion. Records the locked boundary decision from wayfinder
map #1875 and source Ticket #1877.

## Context

The engine relocation needed one boundary answer before the rest of the map
could settle: whether red-castle remains a tracker-neutral substrate with the
dev plugin injecting every GitHub concern, or whether red-castle absorbs the
whole AFK engine, including the GitHub tracker adapter.

The map resolved that red-castle is now reddb-specific enough that pretending
the engine is a generic sandcastle substrate is the wrong abstraction. The
generic upstream-sync surface still matters, but it is the substrate file tree,
not the AFK orchestration engine.

## Decision

Red-castle absorbs the whole AFK engine, including the GitHub tracker adapter.
The engine core stays tracker-agnostic internally, but the GitHub implementation
ships inside red-castle under a quarantined tracker area such as
`tracker/github/`, behind an internal tracker port. The `gh` CLI is an official
red-castle dependency for that adapter.

All absorbed orchestration code enters a directory that does not exist upstream,
such as `src/engine/`. Current substrate files remain the `.upstream`
cherry-pick surface. The auditable upstream-sync rule is: upstream sync does not
touch `engine/`.

Labels are configuration. The consumer supplies the label vocabulary and the
mapping from labels such as `ready-for-agent`, `blocked:*`, `lane:go`, and
`req:N` onto engine states and transitions. The castle emits the tracker
formats: claim comments, Envelopes, HITL decision cards, and blocker-state
blocks. The label names themselves are not hardcoded.

The remaining dev plugin surface is the thin skin:

- CLI entry points and forwarding into the castle engine.
- Skills, prompts, setup docs, and agent-facing product surface.
- Lifecycle hook bodies and host guardrails, including command guard and Branch
  lock.
- Statusline as an external reader of the castle's published lanes and
  contracts.

Monitor moves into red-castle because it observes the engine's own entities.
Statusline stays in dev because it is the flagship external consumer.

Every new structured engine lane is written through `@reddb-io/toon`: snapshots
as `.toon`, append streams as `.toonl`.

## Consequences

- The public port surface is configuration injection, lifecycle hook dispatch,
  internal tracker operations, and published observability lanes.
- The claim-comment format is castle-side; claim policy still consumes the
  injected label mapping.
- Gate execution, landing mechanics, and monitor rendering can move into the
  castle without leaking GitHub policy back into dev.
- The dev plugin remains the agent-facing product and host guardrail owner, not
  a second engine.

## Sources

- Wayfinder map #1875.
- Ticket #1877.
