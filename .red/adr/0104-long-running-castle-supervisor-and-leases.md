# Red-castle runs long-lived workers under a castle supervisor

## Status

Accepted. Records the locked supervisor and claim coordination decisions from
wayfinder map #1875 and source Tickets #1880 and #1884.

## Context

The relocated engine replaces one-attempt-per-process execution with long-lived
workers. That requires a supervisor, worker state machine, elastic fleet
behavior, and a claim protocol that remains safe across same-host and cross-host
workers.

## Decision

Red-castle owns one supervisor process per machine. The supervisor manages N
worker slots, each running a long-lived state machine:

`claim Ticket -> create workspace -> resolve -> land -> next`.

Workers exit on drain-empty (`NO MORE TASKS`), lifetime cap, accumulated budget
cap, supervisor kill, or graceful retirement. The caps are configurable.

The supervisor owns the slot circuit-breaker, watchdog, idle-park and wake,
parked-slot sweep, crash-reconcile of a dead worker's claimed Ticket, unblock
sweep trigger, stall detection, and landing serialization lock. Stall detection
uses red-castle's liveness lane and evaluator and is the only stall authority.

Fleet size is runtime-mutable. Scaling up spawns workers immediately. Scaling
down supports hard kill, which re-queues the interrupted Ticket with annotation,
and graceful retirement, where the worker finishes the current Ticket, concedes
its claim, and exits before the next claim.

Regenerate-with-feedback has three tiers:

- Fresh respawn plus fresh re-queue with `prev-failure-reason`.
- Escalation ladder through higher model/effort tiers and alternate runner at
  the configured cap.
- Live steering where the runner exposes a steering channel; otherwise the
  engine degrades to kill plus re-queue.

Claims keep the dual-layer scheme:

- Local mkdir lease under `tmp/claims/<ticket>/` as the same-host fast path.
- Tracker claim comments as the cross-host source of truth, following ADR 0066
  comment ordering.

Both layers move into the castle lease module behind the internal tracker port.
The `running` label remains observability only through the injected label
mapping.

Claim staleness is a liveness verdict, not a wall-clock timeout. A claim becomes
stealable only after the supervisor declares the worker dead or stalled and
crash-reconcile explicitly concedes it. Long validations on a live worker do
not lose their claim.

## Consequences

- Worker identity is the lease anchor.
- One worker claims at most one Ticket at a time.
- The landing lock is a castle coordination primitive.
- Elastic fleet, escalation, and steering are part of the engine plan, with
  escalation and steering allowed to land after cutover as additive policy.

## Sources

- Wayfinder map #1875.
- Tickets #1880 and #1884.
