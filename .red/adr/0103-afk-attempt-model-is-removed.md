# 0103 — AFK removes attempts and recovers by fresh re-queue

## Status

Accepted. Records the locked attempt-removal decision from wayfinder map #1875
and source Tickets #1878 and #1879.

## Context

AFK historically modeled each retry as an Attempt with `{issue}-a{N}` directories,
attempt ledgers, snapshot branches, salvage-uncommitted machinery, and
attempt-progress guards. Research across 371 drain records and 308 Tickets found
31 multi-attempt Tickets and zero cases where a later attempt genuinely resumed
useful partial work. The successful path was a clean rerun from Trunk.

The only carry-forward with demonstrated value was the previous failure reason
text injected into the next prompt.

## Decision

The attempt model is removed. `{issue}-a{N}` directories, attempt ledgers,
attempt-record payloads, salvage-uncommitted handling, ExitReceipt, and
`afk-attempts/*` snapshot branches are deleted from the target engine.

This **supersedes ADR 0017** (AFK records Reasoning attempts into Memory Graph
best-effort), deliberately and not by name-collision: 0017's subject is the
Attempt as an audit object, and once the Attempt does not exist there is nothing
for that seam to record. The removal of `attempt-record.ts` is therefore a
documented reversal of 0017, not a mechanical side effect of deleting the
similarly-named attempt ledger. The two RedSkills nouns that keep 0017's value —
the terminal Envelope plus the history ledger for operational forensics, and the
brain `OutcomeEvent` for routing policy — survive untouched.

Worktrees are keyed by `workerId-issueId`; there is no attempt level.

Bounded retry caps survive as re-queue policy. Per-failure-class caps such as
`crashed=1` and `merge`, `quota`, `runner-transient`, and `stalled` at three are
re-keyed per Ticket as automatic fresh re-queue limits. When the cap is reached,
the Ticket parks for human review.

Heartbeat splits in two:

- Attempt-progress guard, proof-of-life sink, hard-cap aborts, edit-loop-stall
  aborts, and crash-resume machinery die with Attempts.
- Worker vitals telemetry survives: tokens, cost, diff counters, tool/text/
  reasoning counters, waiting state, and related ADR 0065 names remain in the
  worker state and structured lanes.

On automatic re-queue, the engine injects `prev-failure-reason` plus an Envelope
reference into the next worker prompt. Partial uncommitted work is not salvaged.
Forensics are the terminal Envelope and any pushed branch commits.

## Consequences

- Stall detection becomes the Fleet supervisor's exclusive job, driven by the
  castle liveness lane and evaluator.
- `RED_AFK_RETRY_*` survives with re-queue semantics; `RED_AFK_ATTEMPT_*`,
  salvage, proof-of-life, and attempt-progress knobs are removed.
- Worker state schemas drop attempt fields.
- Reader grammars no longer parse `-a{N}`.

## Sources

- Wayfinder map #1875.
- Tickets #1878 and #1879.
