# 0125 — Castle ownership is a CI ratchet over dev entry points

- **Status**: accepted
- **Date**: 2026-07-21
- **Related**: ADR 0102 (castle engine boundary), ADR 0113 (truth versus host boundary), ADR 0124 (absorb the proven implementation), Ticket #2233 (executable draft)

## Context

The previous relocation could stop halfway because no check failed while dev
retained engine behaviour. A prose ownership list was easy to satisfy by moving
names or adding castle modules while the dev entry points still made the same
Worker, Ticket, Lane, and PR decisions.

Ticket #2233 compared three possible checks against the current tree: line caps
per command, a single-castle-call rule, and a ban on dev control flow over engine
entities. Line caps measure formatting and punish legitimate adapters. A
single-call rule couples the boundary to one forwarding shape and cannot see
policy retained behind a helper. Control flow over engine entities tests the
actual ownership claim, but it needs narrow exemptions for legitimate host
rendering and enforcement.

The resulting executable draft is intentionally red today: all four migration
verbs still have dev-local paths. A check that passed before the crossing would
repeat the original failure by proving nothing.

## Decision

**Castle ownership is enforced by a permanent CI drift test over
`apps/dev/src`, using the host-adapter criterion rather than a size or call-count
proxy.**

The test has two assertions:

1. the known engine verbs — config, gate execution, landing, and worker drain —
   have no dev-local implementation paths; and
2. dev source contains no branch control flow over Worker, Ticket, Lane, or PR
   entities outside a named host-adapter function.

Host-adapter exemptions are function-scoped, never file-scoped. They cover only
rendering castle-produced feeds, translating host UX, skill wiring, and
host-side enforcement mechanisms. An exemption is not a migration waiver: a
new or widened exemption must explain which castle contract supplies the truth
and why the remaining function is host-specific.

During the crossing, the executable remains a `.draft.ts` file outside Vitest's
CI include and is run explicitly as a monotonic acceptance probe. Each verb
crossing must remove findings; it may not rewrite the current-tree inventory to
hide them. When the final finding and retained verb disappear, the draft is
renamed into the normal Vitest include in that same crossing. From then on it is
a binding CI ratchet.

The test deliberately does not require one castle call per command and does not
set line caps. Adapter composition and size may change without moving ownership;
control flow over engine entities may not.

## Consequences

- Castle ownership becomes falsifiable: reintroducing engine policy into dev
  fails CI even when the castle copy still exists.
- The draft is allowed to be red only while it is visibly outside the CI include;
  it cannot be described as protection until the final crossing promotes it.
- Legitimate statusline, hook-body, and skill wiring code stays possible through
  narrow named-function exemptions.
- The AST heuristic and entity vocabulary are deliberate architecture policy.
  Changes to them are reviewed as boundary changes, not incidental test cleanup.

## Sources

- Ticket #2236.
- Draft and candidate comparison #2233.
