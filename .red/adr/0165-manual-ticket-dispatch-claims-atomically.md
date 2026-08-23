# 0165 — Manual Ticket dispatch claims atomically

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0130 (daemon admission authority); ADR 0144 (Project control state and durable workflow truth); ADR 0164 (Ticket-first mobile dispatch)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q34–Q35

## Context

A Ticket selected in the mobile app may not carry `ready-for-agent`, because an explicit operator dispatch is the ad-hoc Working mode rather than an instruction to arm the whole queue. It may also be closed, be a parent Spec, carry a blocker, already belong to a live Worker, or race with an armed `/afk` drain between the app's read and its mutation. Letting the app decide eligibility from a cached list would create a second claim authority and permit duplicate Workers.

## Decision

Manual **Ticket dispatch** may target any Ticket that is open, is not a Spec, is not blocked, and is not already claimed. `ready-for-agent` is not required: the authenticated operator's explicit dispatch is the durable control intent for this one Ticket. `redskilled` re-reads eligibility and atomically claims the Ticket inside the Project control state before Worker birth, using the same claim invariant that prevents competing drains from taking the same work.

If the Ticket becomes ineligible or another claimant wins, the daemon refuses the dispatch with a typed reason and births no Worker. The mobile app may render a preflight state for usability but never treats it as authorization, never writes a claim itself, and never retries a conflict as a different Ticket. The Link relay only carries the request and participates in none of these decisions.

## Considered options

- Require `ready-for-agent` for manual dispatch. Rejected because a one-Ticket operator command would then need to mutate the autonomous queue merely to express ad-hoc intent.
- Permit any Issue, including blocked, closed, Spec, or already claimed. Rejected because explicit operator intent does not erase workflow meaning or make duplicate ownership safe.
- Let the app lock after reading eligibility. Rejected because mobile state is stale by construction and the daemon is already the admission and claim authority.
