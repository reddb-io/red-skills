# Branch lock value drives AFK base and merge; enforcement stays agent-only

## Status

accepted.

Original design-stage decision from a `/start` grilling on the worker-directory
restructure. Implemented by PRD #244 (issue #253), shipped in the native TS
runtime. ADR 0006 made the Branch lock agent-only and exempted `/afk` worktrees
from it; ADR 0008 made `/afk` base and merge target the **Pinned branch**
(default `main`), declared *independent* of the Branch lock
(`contexts/dev/CONTEXT.md:100`, `:112`). The user now needs everything —
interactive *and* AFK — to ground on the single branch they are working on
locally, as both origin and destination.

## Decision

Split the lock's **value** from its **enforcement**:

- **Enforcement** (checkout-blocking) stays primary-checkout-only; `/afk`
  worktrees remain exempt, so ADR 0006 holds and workers can still create their
  own iteration branches.
- **Value** (the branch named in `branch-lock.yaml`, owned by `lock-store.sh`)
  is now read by `/afk` as its effective base — worktrees branch off it — and
  its `do_merge` target.

Precedence when a lock is set: **lock > Pinned branch > main**. A set lock is
authoritative: everything must ground on the branch the user is working on
locally. The Pinned branch (ADR 0008) applies only when no lock is active.

## Why

- **The exemption exists to stop the lock from *strangling* AFK**, not to keep
  AFK ignorant of the lock. The checkout-block must not reach worktrees (they
  must switch branches), but nothing stops `/afk` from *reading the lock's
  value* as its base and merge target.
- **The user expressed the lock as authoritative for all agents.** A single
  source of truth — one `branch-lock.yaml` consumed by both interactive
  enforcement and AFK base/merge — is what "all agents respect the lock" means.
- **Lock-wins is the predictable rule.** Locked means everything lands on the
  user's working branch; unlocked falls back to the per-issue pin, then `main`.

## Rejected alternatives

- **Make AFK fully obey enforcement (drop the worktree exemption).** This is
  exactly the strangulation ADR 0006's exemption prevents — workers could not
  create iteration branches. Non-viable. Rejected.
- **A separate AFK integration-branch config.** The user wants one lock all
  agents respect; a second knob defeats the single source of truth. Rejected.
- **Pinned branch wins over the lock.** A pinned issue would silently land off
  the user's locked branch, violating "all agents respect the lock." Rejected —
  with the accepted residual risk that a PRD pinned to a long-lived branch is
  diverted to the active lock; mitigated because locking is a deliberate,
  visible local act.
- **Refuse to run on lock/pin conflict.** Safest against silent divergence but
  adds friction (the issue cannot run until a human resolves it). Held as the
  fallback if lock-wins proves too surprising.

## Consequences

- This refines, and does not supersede, ADR 0006 (enforcement) and ADR 0008
  (pinned branch): both stay true in their own domain; this ADR adds the
  lock-value-to-base/merge relationship and the precedence order.
- Glossary debt for the implementing PR: `contexts/dev/CONTEXT.md:99`/`:100`
  change from "independent" to "lock value drives AFK base/merge; enforcement
  stays primary-only," and the `:112` flagged-ambiguity note is updated.
- `lock-store.sh` gains a second consumer (`/afk`), so its pure / explicit-args
  contract and atomic writes now matter for cross-process reads, not just the
  interactive hook.
