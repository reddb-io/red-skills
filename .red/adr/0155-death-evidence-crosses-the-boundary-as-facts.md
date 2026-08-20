# 0155 — Death evidence crosses the ACP boundary as facts; recovery decisions stay in the checkout

- **Status**: accepted
- **Date**: 2026-08-20
- **Related**: ADR 0103 (a retry is a fresh Worker), ADR 0130 (the daemon owns process death; the Attempt is extinct), ADR 0136 (verdict as fault attribution and budget accounting), ADR 0144 (the daemon may not know issues or labels), ADR 0154 (no agent lands on its own verdict)
- **Sources**: the pstack study of 2026-08-20 (retry-by-failure-mode table in the orchestrate playbook); the maintainer's standing directive to maximize autonomy

## Context

A Worker that exits gracefully routes through `routeRecovery`: the claim is
released, the issue is requeued or parked, and `recoveryDecision()` bounds the
retries per reason (`RECOVERABLE` caps, counted by `requeueOrdinal()` over the
history lane — the documented ADR 0103/0130-safe replacement for the extinct
per-attempt ordinal). Tier escalation already implements "retry on a stronger
model" when a failure signature repeats.

A Worker that dies **hard** — SIGKILL, cgroup OOM, a frozen tree — gets none of
that. The issue stays `running` with a live claim until the *next* Worker's
boot sweep concedes it on a staleness clock. The evidence needed to do better
already exists and is discarded: the daemon's `resolveUnitDeath` reads the
systemd unit receipt (`exit_code`, `signal`, `systemd_result`,
`memory_peak_bytes`, `journal_tail`) and renders it as prose;
`death-attribution.ts` already classifies senders (`oomd | user-signal |
parent-death | teardown | boot-refused | unknown`, with confidence). Meanwhile
a genuine cgroup OOM produces **no** in-process death record at all — the
memory sampler deliberately stands down when the kernel owns the ceiling — so
the unit receipt is the only witness.

The tempting fix — let the daemon requeue the issue — violates the boundary:
the daemon may not know what an issue or a label is (ADR 0130/0144), and
`RedskilledWorkerView` carries no issue on purpose.

## Decision

**The daemon classifies and emits; the checkout joins and decides.**

1. **Facts at the boundary.** `resolveUnitDeath` stops discarding the receipt:
   the worker-death record it already produces gains structured fields —
   `sender_class` (the existing `DeathSenderClass`, no new members),
   `confidence`, `exit_code`, `signal`, `memory_peak_bytes` — keyed by
   `worker_id` only. The daemon's diff for this work may not contain an issue
   number, a label, or a tracker call; a grep-guard test asserts it.
2. **Decisions in the checkout.** A new `core/death-sweep.ts`, run from the
   manager tick and `reap`, consumes the evidence, performs the only join the
   checkout can and the daemon cannot (`worker_id → claim → issue`), **eagerly
   releases the claim**, appends a terminal history row so `requeueOrdinal()`
   keeps counting, and feeds the existing `recoveryDecision()`. The mapping is
   from `DeathSenderClass` into the existing `RecoveryReason`/`WorkerOutcome`
   vocabularies — no sixth vocabulary: `oomd` → requeue with memory bump or
   tier escalation; `user-signal`/`teardown` → plain requeue; low-confidence
   `unknown` → today's lazy boot-sweep behavior, unchanged.
3. **Bounds are the existing bounds.** The `RECOVERABLE` caps and the requeue
   ordinal govern hard deaths exactly as they govern graceful ones; exhaustion
   parks with the evidence quoted, which is where a human enters — after the
   caps, never before.

## Considered options

- **Worker reports its issue up the ACP control plane so the daemon can key
  per-issue.** Rejected: it teaches the daemon a noun ADR 0144 removed, to
  save one join the checkout performs today for free.
- **A daemon-side retry policy in Project control state.** Rejected for the
  same reason; the per-project latch the daemon legitimately owns (the birth
  breaker) already exists and is not a per-issue decision.
- **Leaving recovery to the boot sweep.** Rejected as the status quo: it makes
  queue latency after a hard death a function of when the *next* Worker
  happens to boot, which is exactly the stall a human currently notices by
  watching the dashboard.

## Consequences

- A hard death converges to the same loop as a graceful failure within one
  sweep tick, with better evidence (`memory_peak_bytes` names the bump an OOM
  retry needs).
- `/retake` leaves the common path and becomes what it should be: the verb for
  genuinely parked work, not the mop for every SIGKILL.
- The boot sweep remains as the backstop for evidence that never arrived —
  the sweep is additive, not a replacement.
