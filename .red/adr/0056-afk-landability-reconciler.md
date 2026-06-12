# AFK landability reconciler: parked-but-green branches self-land via a no-agent reconcile worker

> **Numbering note.** PRD #614 / issue #622 use "ADR 0056" to mean the *atomic
> GitHub-native claim substrate*. That is a **different** decision, recorded as
> **ADR 0066** (`0066-afk-atomic-github-native-claim-substrate.md`), because this
> 0056 — the landability reconciler — already held the number. This ADR is not
> about claims.

## Context

AFK's terminal routing is **one-shot and event-driven**. A terminal event
(`done` / `timeout`→`stalled` / `no-sentinel`) fires once, `recovery.ts` routes
it once (retry or escalate), and the issue lands in a terminal label. There is
no reconciliation: if the routing parks work that is actually mergeable, nothing
re-evaluates it.

This loses completed work routinely. Observed in one session: 3 issues whose
branches were green and committed — `#405` closed cleanly, but `#407` (64m) and
`#456` (62m) hit the commit-anchored progress guard (ADR 0044), routed to
`timeout`→`blocked:stalled`→`ready-for-human`, and **parked unmerged** even
though their `afk/*` branches carried passing work. The agent had finished and
committed, then burned the guard window re-running the full suite to self-verify
before emitting `<promise>DONE</promise>`. The progress guard fired *correctly*
(no new commit, no diff change = no progress); the defect is that **the merge
decision is gated on the agent's sentinel, not on AFK's own verdict.**

The verdict machinery already exists and is correct: `feedback.ts` (the scoped
test/typecheck/lint/build gate, ADR 0008) + `feedback-worktree.ts` (which
materialises the branch and runs `pnpm install --frozen-lockfile` first, #458).
But `runFeedback` is invoked **only on the DONE path** in `processIssue`. On
`timeout` / `no-sentinel`, AFK escalates without ever asking "is this branch
green?".

Two prior ADRs salvage specific terminal paths — 0047 (no-sentinel branch that
passes feedback) and 0050 (uncommitted worktree on a DONE-without-commit) — but
each is a point fix on the *terminal event*. Neither generalises, and neither
heals an issue that is **already parked** (the backlog: a parked issue gets no
new terminal event unless re-queued, and re-queueing re-runs the agent — the
same loop).

## Decision

Replace one-shot terminal routing with **reconciliation toward a landability
invariant**, enforced in one place and driven from three triggers.

### The invariant

For an issue AFK **owns** (carries an `afk/{id}/{N}-*` branch and a *mechanical*
failure label):

- branch green + mergeable → **merge + close**;
- branch red, or green-but-no-longer-mergeable → **`ready-for-human` with the
  real failing checks**;
- no branch / empty branch → **`ready-for-agent`**.

A single `reconcile(issue)` enforces it. The agent's sentinel and the
attempt/stall guards become **triggers**, not deciders: the merge is a function
of AFK's verified verdict, not of the agent declaring DONE.

### `reconcile` runs as a no-agent worker mode

The work (materialise branch → `pnpm install` → `runFeedback` → integrate →
`landAttempt` → close) is heavy (minutes) and reuses the entire worker landing
pipeline. It therefore runs as a new **reconcile/salvage worker mode**: instead
of claiming a `ready-for-agent` issue and running the **agent**, the reconcile
worker claims a parked-but-maybe-green issue and runs **only validate→land — no
agent invocation**. It reuses `makeFeedbackWorktree` + `runFeedback` +
`landAttempt` + the envelope/close path unchanged. **No new merge code.**

The agent is **never re-run** by reconcile; agent-retry stays the separate
`recovery.ts` path.

### Three triggers, one mode

1. **Terminal event** (inline in `processIssue`): on `timeout` / `no-sentinel`
   with commits, call `reconcile` before `escalate`. Catches it as it happens.
2. **Boot sweep** (in `boot-sweep.ts`, beside the Unblock Sweep): reconcile every
   owned parked issue. **Retroactive** — heals the existing backlog (`#407`,
   `#456`) on the next `/afk`, with no human and no agent re-run.
3. **Supervisor tick** (fleet): the health-check loop *detects* a landable parked
   issue cheaply (label + branch-head check, well under the 120s
   `RED_AFK_TICK_TIMEOUT_S` ceiling) and **dispatches a reconcile worker into a
   slot** — exactly the dispatch it already does on a circuit trip. The heavy
   validate+land runs in the worker process (its own timeout), off the tick. This
   keeps the supervisor's "worker-lifecycle only, no heavy `gh`/`git`/`fs` in the
   tick" boundary intact. Continuous self-healing in minutes.

### Boundaries (what reconcile will and will not do)

- **Mechanical classes only.** Auto-land applies to `blocked:stalled` and
  `blocked:crashed` — failures of the *process*. It **never** touches
  `blocked:spec` or an active `## Current blocker` (`red:blocker-state`
  `status: blocked`): those are genuine human gates where the work may be green
  but *wrong*. The blocker-state model already distinguishes them.
- **Same verdict authority as DONE.** The verdict is the **scoped** gate
  (`runFeedback`), identical to the DONE path. Cross-package breakage is caught by
  the land path's existing nets — the `drift-guard` `pre_merge` hook and the
  fetch+rebase integrate step (`merge.ts`) both run on every land. An opt-in
  `RED_AFK_SALVAGE_FULL_GATE=1` widens to the full gate for the paranoid.
- **Checkpoint-aware, bounded.** A branch is validated only when its HEAD/base
  changed since the last recorded verdict; the verdict is cached. A red branch
  stays `ready-for-human` and is **not** re-gated every boot. On base drift the
  branch is re-integrated (the merge step already fetch+rebases) and re-validated
  before landing.
- **Ownership-scoped.** Only branches AFK created (`afk/{id}/{N}-*`) under a
  mechanical label are eligible — never human-authored branches.

## Consequences

- Green work never stays parked: `#407` / `#456` and every future
  parked-but-green issue self-land — no operator, no agent re-run.
- The sentinel and the progress/stall guards become advisory triggers; landing is
  a function of AFK's own gate verdict. A complementary AGENT-PROMPT change
  ("after your final commit, emit `DONE` immediately — do not re-run the full
  suite; AFK's gate is the authority") removes the loop at the source for the
  common case, but is no longer load-bearing for correctness.
- Three special cases (terminal salvage, unblock sweep, orphan recovery) converge
  on one mechanism; the invariant is enforced in exactly one `reconcile`.
- The supervisor gains a *dispatch* responsibility (schedule a reconcile worker)
  but no validate/merge logic — its lifecycle-only, sub-120s-tick boundary holds.
- Generalises ADR 0047 (no-sentinel) and 0050 (uncommitted) from point terminal
  fixes into a continuous, retroactive controller covering the `timeout`/`stalled`
  path and the already-parked backlog.

## Status

Proposed.

## Related

- ADR 0044 / 0045 — the attempt progress guard + externalized proof-of-life
  (the trigger this reconciles after).
- ADR 0047 — salvages a no-sentinel branch that passes feedback (point fix this
  generalises).
- ADR 0050 — salvages an uncommitted worktree on DONE-without-commit (sibling
  salvage).
- ADR 0008 — the feedback gate is the merge authority (`runFeedback`).
- ADR 0030 / 0048 — lock-toggled landing + the binding merge gates
  (`drift-guard`, backpressure) that the reconcile land path reuses.
- #458 — feedback worktree installs deps (`pnpm install --frozen-lockfile`),
  the precondition that makes off-agent validation correct.
