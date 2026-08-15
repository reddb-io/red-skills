# 0144 — `redskilled` is the host control plane; Workers are cattle

- **Status**: accepted
- **Date**: 2026-08-14
- **Related**: ADR 0120 (MCP-first Castle surface), ADR 0123 (boundary consolidation), ADR 0130 (`redskilled` host process truth), ADR 0132 (one GitHub owner), ADR 0138 (daemon-owned base freshness), ADR 0141 (daemon-owned remote cache), ADR 0143 (Castle resident — superseded by this record), ADR 0145 (ACP agent fabric)

## Context

The split between a host-scoped `redskilled`, a per-project Demand producer,
and a per-project Castle resident created three operational authorities around
one job. It kept the daemon version-neutral, but paid for that property with
duplicate lifecycle, state, cache, and wire boundaries. The simpler analogy is
Docker's: one stateful host control plane manages disposable workloads, while
clients ask that control plane to act.

## Decision

**One stateful `redskilled` daemon per host owns RedSkills operational control;
Workers are disposable workloads under it.** The daemon does not cluster with
other hosts.

1. A **Project** is one logical GitHub repository, keyed by GitHub's stable
   repository identity. `redskilled` holds one operational Project partition
   and one daemon-managed canonical repository workspace per Project. Editor
   clones and MCP launch directories are clients, never execution roots.
2. GitHub remains durable workflow truth for Tickets, labels, dependencies,
   discussions, and human decisions. `redskilled` owns operational truth:
   durable drain intent, cache and cursors, pending writes, local claims,
   Worker lifecycle, budgets, placement, and session routing. A drain continues
   after every client disconnect until an explicit stop.
3. `redskilled` is the host's sole managed GitHub gateway. Each Project binds
   to a daemon-owned credential profile; the daemon coalesces and budgets REST
   and GraphQL, serves age-stamped cached reads, schedules durable writes, owns
   authenticated fetch/push, refreshes the canonical workspace, and publishes
   Worker commits. Clients and Workers receive no GitHub token and do not call
   GitHub independently.
4. A Worker is cattle: one admitted, budgeted, observable, replaceable process
   for one active workflow, Ticket, and isolated Worktree. It may span related
   prompt turns, but ends on completion, idle policy, budget verdict, or
   replacement. Native process, Docker, and Podman placement drivers implement
   the same Worker contract; host policy makes the final placement decision.
5. Project policy resolves in three layers: host policy sets hard limits;
   explicit durable control intents choose within them; tracked
   `.red/config.yaml` from the refreshed Project trunk supplies versioned
   defaults. Dirty client-checkout state is never an input. Project-scoped
   clients may mutate only their Project; host-wide administration requires an
   explicit capability.

The Castle resident, Demand producer, and Project coordinator Worker cease to
exist as architectural players. Their useful project coordination, background
belts, GitHub adapters, and queue-consumption responsibilities become state and
modules inside `redskilled`.

## Consequences

`redskilled` is no longer the version-neutral argv-and-budget daemon described
by ADR 0130 rules 2 and 3; this record amends that boundary while retaining one
daemon per host, fail-closed admission, independent Worker units, budgets, and
reattachment. It supersedes ADR 0143. ADR 0141's serve-from-cache-always rule and
ADR 0138's daemon-owned trunk refresh become general control-plane rules rather
than Castle-resident inputs. Separate hosts may drain the same repository, but
coordinate only through GitHub's durable claims and workflow facts.
