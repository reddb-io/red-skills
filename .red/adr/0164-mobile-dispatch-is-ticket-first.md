# 0164 — Mobile dispatch is Ticket-first

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0150 (`go_dispatch` and ad-hoc Working mode); ADR 0158 (capability-scoped remote operations); ADR 0163 (per-Host mobile authority)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q31–Q33

## Context

The durable work unit in RedSkills is a Ticket materialised as a GitHub Issue, but the existing `_redskills/go_dispatch` wire accepts free-form `demand` text, silently mints a disposable `lane:go` Ticket, and admits a Worker against it. That shortcut is useful for `/go`, yet presenting the same abstraction as the mobile app's primary action would hide where work is recorded and cannot dispatch an Issue that already exists: the current schema deliberately rejects a Ticket number.

## Decision

The mobile product's primary operation is **Ticket dispatch**. After choosing a Host and Project, the operator either selects an existing GitHub Issue or explicitly creates a new Issue with title, body, and acceptance criteria, then admits one Worker against exactly that Ticket. The app presents the Ticket number before dispatch and keeps the Worker, comments, PR, and closure visibly attached to the same GitHub object.

The remote application protocol gains an explicit Project-scoped operation for dispatching an existing Ticket by stable Project identity and Ticket number. Creating a Ticket and dispatching it composes declared GitHub publication with that same operation; free-form text may prefill the Issue form but is never an anonymous execution unit. `_redskills/go_dispatch({ demand })` may remain as a compatibility shortcut for `/go`, but it is not the mobile app's domain model or primary UI.

The first vertical slice therefore pairs one Android device to one Host, lists registered Projects and their Tickets and Workers, dispatches one selected Ticket, observes its Worker events, and can stop that Worker. Repository discovery and daemon-owned clone/provisioning follow in the next slice.

## Considered options

- Use only free-form demand and create a disposable Issue silently. Rejected because the interface obscures the durable unit and cannot target existing backlog work.
- Give equal prominence to “send demand” and “dispatch Issue” in the first slice. Rejected because two primary nouns would preserve the ambiguity this decision removes.
- Begin read-only. Rejected because observation alone does not prove the product's core remote-control loop.
