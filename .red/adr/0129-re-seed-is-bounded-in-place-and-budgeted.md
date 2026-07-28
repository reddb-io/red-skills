# 0129 — A Re-seed is bounded, in place, and budgeted

- **Status**: accepted
- **Date**: 2026-07-28
- **Related**: ADR 0103 (the attempt model is removed; a retry is a fresh Worker), ADR 0110 (adversarial review — amended by this record), ADR 0119 (one gate verdict), ADR 0128 (the Attempt is the unit of truth), ADR 0117 (retired keys carry a tombstone)

## Context

Four independent implementations of one operation had accumulated in
`process-issue/lifecycle.ts`: the gate-correction retry (`:570`), the `/go`
verify retry (`:549`), the simple→complex tier escalation (`:959`), and the
adversarial-review correction (`:1355`). All four do the same thing — bump an
ordinal, append a block to the handoff, fire `pre_attempt`, `continue` the
worker's loop — and each carries its own counter, its own handoff appender, its
own log line, and its own exhaustion rule.

Four defects follow directly from that fragmentation:

- **The tier escalation mutes gate correction entirely.** `:572` refuses every
  gate correction once `escalatedSimpleFeedback` is set, so one tier bump costs a
  ticket its whole 3-round budget.
- **The budgets do not compose.** With review enabled a ticket may spend 3 + 1 + 1
  extra rounds with no ceiling; worse, because the gate runs first, a ticket that
  burned its gate budget parks immediately on the round the review just asked
  for — the review is starved by prior churn.
- **Exhaustion depends on a config value.** `decideAdversarialReview` returns
  `pass` at `cap = 1` (landing code with a known blocking finding) and `park` at
  `cap >= 2`, while the gate always parks. Three exhaustion behaviours coexist by
  accident.
- **Round N cannot see rounds 1..N-1.** All three appenders rebuild from the
  original `handoff` variable rather than the current one, so each round silently
  discards its predecessors. This was a variable bug, not a context economy: the
  validation tail is already bounded at 80 lines.

Underneath all four sits an unnamed contradiction. The loop increments
`attemptN` and passes `attempt_n` into the hook context — the attempt ordinal
ADR 0103 retired — while running inside one worker, one worktree, one branch.
ADR 0103 says bounded retries survive as *re-queue* policy: fresh Worker, clean
worktree from Trunk, `prev-failure-reason` in the next prompt. This loop does the
opposite and had no name for the difference.

## Decision

**A Re-seed is re-instructing the implementer in place — same Worker, same
Worktree, same branch — after a gate stage blocked the work.** It is the
deliberate opposite of ADR 0103's re-queue, and the contrast is the term's whole
job: a re-queue discards, a Re-seed resumes.

1. **A Re-seed never mints a new Attempt** (ADR 0128). The rounds are events
   inside the running Attempt, and the surviving ordinal is renamed to say so.
2. **This is a justified exception to ADR 0103, not a reversal of it.** 0103's
   evidence — 371 drain records, 31 multi-attempt tickets, *zero* cases where a
   later attempt resumed useful partial work — measured retries after failures
   that left nothing to resume. A Re-seed's precondition is the opposite: a
   committed branch that passes everything but one stage. 0103's removal of the
   ordinal, of salvage-uncommitted, and of attempt directories stands.
3. **Review becomes a gate stage.** `GATE_STAGE_ORDER` becomes
   `["feedback", "backpressure", "review"]` and `gateVerdict()` is the single
   verdict (ADR 0119). Two properties ADR 0110 needs are then native rather than
   reimplemented: the fold's "later stages do not run once an earlier one blocks"
   *is* 0110's "only once the machine gate is green", and `GateStageOutcome`'s
   `skipped` *is* the #2352 rule that a crashed reviewer must never fail the
   attempt.
4. **One Re-seed budget per lane: a ceiling holding sub-caps per cause, with the
   review's round reserved.** `/afk` totals 4 — gate ≤ 3, tier ≤ 1, review 1
   **reserved**, which gate churn cannot consume. `/go` totals 2, or 3 under
   `--mode no-mistakes` so the reservation fits. The mechanism is identical
   across lanes; only the ruler differs, because the difference between them is
   economic (a human waits on `/go`) and not structural.
5. **Exhaustion is uniform: anything still outstanding parks `ready-for-human` +
   `blocked:validation`,** with the accumulated evidence, whatever the cause.
   Landing with a known blocking finding stops being reachable by config value.
6. **A repeated failure signature escalates the tier** (`validate → simple →
   complex → think`) instead of spending another round at the same tier, which is
   the lowest-yield round available. This generalises a trigger that fired only
   for simple-tier semantic failures.
7. **The re-seeded prompt carries outstanding state, not narrative** — the current
   gate tail and the current review findings *together*, deduped, plus one history
   line (round n/N, current tier, repeat count). Earlier rounds are not
   independent facts; they are stale versions of the same state.
8. **The trail is one record and one comment.** The Attempt record is the truth
   (ADR 0128); the Issue carries a single comment edited in place; the first
   Re-seed opens a **draft PR** that mirrors it, which landing reuses and marks
   ready rather than duplicating. A parked Re-seed leaves that draft open and
   marked `blocked:validation`, because the moment a human is called is exactly
   the moment they need the diff.

## Considered options

- **Re-queue a fresh Worker per correction** (ADR 0103's policy applied
  literally): rejected — it discards a committed branch and a warm worktree to
  fix one red check, which is the case 0103's evidence never covered.
- **Each round mints a new Attempt**: rejected — it requires amending 0103 for no
  gain, since the rounds are already derivable from the Attempt record.
- **One pool, first-come-first-served**: rejected — gate churn starves the review
  round, which is the second defect wearing a new name.
- **Independent per-cause budgets** (today's shape minus the coupling): rejected —
  a 5-round worst case with no ceiling, while the queue waits.
- **Land-with-warning on review exhaustion**: rejected — at the default budget it
  is precisely the advisory mode ADR 0110 rejected by name, since the review
  would then never stop anything.
- **Open the draft PR from the first commit**: rejected — a PR and a CI run per
  attempt across a churning fleet, to document the majority of attempts that need
  no documentation. The draft is minted lazily, at the first Re-seed.

## Consequences

- `afk.stallConvergenceBudget` is retired and carries a tombstone (ADR 0117); its
  replacement is lane-scoped.
- The `adversarial-correction` landing reason disappears — it was the only
  `!landing.ok` branch that was not a landing failure.
- Parked validation tickets now leave an open draft PR behind, so PR-list queries
  must filter `blocked:validation` to separate parked work from live work.
- Worst case per ticket drops from 5 uncapped rounds to 4.
- Cost: the reviewer must read `git diff base...branch` in the worktree instead of
  `gh pr diff`, because it now runs before any PR exists.
