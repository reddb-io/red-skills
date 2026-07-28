# 0127 — The attempt is the unit of truth, and the resident owns it

- **Status**: accepted
- **Date**: 2026-07-28
- **Related**: ADR 0098 (`.red` lifecycle taxonomy), ADR 0105 (durable castle state), ADR 0120 (castle MCP as the canonical interface), ADR 0126 (resident-as-core, the same shape one layer down), Spec #2700 (executable charter)

## Context

The execution plane has no single record of what happened. Its truth is spread
across `worker.log.toonl` files, `afk:claim` tracker comments, git refs, PR
state, and live process state — and every reader reconstructs it differently.
Six failures from one session (2026-07-28) are all instances of that:

- `fleet_create` spawned slots that died before writing a worker directory, so
  the canonical interface drained nothing while the CLI kept working and no
  surface reported the difference (#2677);
- `fleet_status` reported `alive: false` in the same payload as a 13-second-old
  heartbeat and two busy slots, and `fleet_stop` no-opped, because the writer
  maintains one liveness anchor and the reader trusts another (#2698);
- the janitor reclaimed the **live** supervisor's runtime lane while leaving
  dead ones, keyed on that same disagreeing anchor (#2679);
- five attempts died holding complete work — committed branches, open green PRs
  — and nothing owned the result; each was rescued only because a human went
  looking (#2701);
- reconstructing any one of those five took manual archaeology across four
  different sources;
- the fleet inherited the terminal's cgroup, so a pressure kill took 56
  unrelated processes, because nothing accounts resources per fleet (#2697).

A dashboard, a statusline, or a smarter janitor built on today's sources would
each re-derive a different answer, which is how the current contradictions
appeared in the first place.

## Decision

**The attempt — one worker × one ticket × one try — is the unit of truth, the
resident writes it, and every surface derives from it.**

1. **Unit** — the attempt, not the ticket. A ticket's history is the ordered
   list of its attempts; a worker's history is the ordered list of the attempts
   it ran. Both are *derived views*, never separately maintained state.
2. **Writer** — the resident (supervisor lane), never the worker. A worker
   emits events; the resident owns the durable record. This is the load-bearing
   half: the moment the record matters most is exactly when the worker is gone,
   so a self-reported record is unavailable precisely when it is needed.
3. **Home** — an append-only lane under `.red/state/castle/`, durable state per
   ADR 0098. `.red/tmp/` holds only the attempt's disposable workspace.
4. **Contents** — one attempt record carries its whole narrative and the
   pointers to everything it produced: claim and concede, the routing decision
   (runner, tier, model, effort), iteration and activity events, commits,
   branch, PR, gate verdicts, landing steps, terminal outcome, resource
   consumption (wall clock, peak RSS, cost), and the artifacts it left with
   their reclaim eligibility.
5. **One liveness anchor** — the record's identity and liveness is the single
   anchor for `fleet_status`, `fleet_stop`, `monitor`, `worker_vitals`, the
   janitor, and the statusline. Two anchors is the bug class behind #2679 and
   #2698, and this ADR forbids a second one.
6. **Every surface is a consumer** — the statusline and any dashboard render
   one MCP read. Staleness travels *inside* the payload, so a stale read cannot
   be presented as current.
7. **The CLI is a thin client of the same core**, mirroring ADR 0126. Because a
   silently broken lane is what made #2677 survive, the MCP lane carries a
   canary that exercises the shipped path end to end and fails loudly.
8. **Resources are attributed per fleet and per attempt.** The fleet owns a
   cgroup of its own (#2697); an attempt that exceeds a wall-clock or memory
   budget terminates with an outcome that **names the budget**, hands its branch
   or PR forward, and is never recorded as a stall (#2701).

## Consequences

- "What happened to ticket N?" and "what did worker W do?" become one read each,
  answerable after the worker is dead — which is the case that matters.
- The janitor gains a defensible reclaim rule: an artifact is reclaimable when
  its attempt record says so, not when a pid file happens to be missing.
- Contradictory payloads (`alive: false` beside a fresh heartbeat) become
  impossible by construction rather than by convention.
- Cost: one writer is a single point of failure for observability, so the
  resident's write path must degrade to append-and-continue rather than
  failing an attempt. The record is diagnostic; it must never break execution.
- Migration is not free: existing readers each drop their private source. Until
  a reader is migrated it keeps its old behaviour, so the interim state has both
  — the ratchet is that no NEW reader may add a private source.
