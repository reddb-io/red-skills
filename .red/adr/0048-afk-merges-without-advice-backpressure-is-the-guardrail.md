# ADR 0048 — AFK merges without advice; in-process backpressure is the guardrail

## Status

accepted. Refines ADR 0030 (AFK landing is lock-toggled; the unlocked path
admin-merges the PR) and ADR 0008 (only mechanism — the feedback gate — can
refuse a merge). Parent: PRD #429.

## Context

The unlocked AFK landing lands completed work via `gh pr merge --admin --merge`
(ADR 0030, `landPr`). `--admin` bypasses GitHub's required-review and
required-status-check rules, so an advisory reviewer such as CodeRabbit has
**no effect** on whether the merge happens — the merge proceeds the moment the
PR exists. This was true but implicit, never written down, and occasionally read
as a bug ("why didn't AFK wait for the review?").

It is not a bug. The worker is autonomous and the queue is the throughput
constraint (PRD #429 backpressure program). Gating each landing on a
human-paced or rate-limited external reviewer would stall the loop for minutes
per issue with no corresponding safety gain — the binding safety gates already
run **inside** the process, before the merge:

1. **`drift-guard`** — the `pre_merge` hook, a hard gate: a non-zero exit aborts
   the merge for the issue and routes it to `ready-for-human`.
2. **In-process feedback/backpressure** — the pre-merge feedback-validation step
   (typecheck/tests, ADR 0008), the only thing that can refuse a merge.

What was missing was (a) the policy stated explicitly, and (b) an opt-in for
teams that *do* want the external review to conclude first.

## Decision

1. **Merge-without-advice is the default, and intentional.** With
   `afk.merge.wait_for_review: false` (the default), the unlocked admin-merge
   proceeds ignoring advisory review checks. `drift-guard` + in-process
   backpressure remain the binding gates.

2. **Add an opt-in wait.** `afk.merge.wait_for_review` (bool, default `false`,
   namespaced `plugins.dev.afk.merge.wait_for_review` with the legacy top-level
   fallback, ADR 0042). When `true`, the unlocked landing polls
   `afk.merge.review_check` (default `CodeRabbit`) via `gh pr checks` until the
   named check reaches a terminal state, **then merges regardless of its
   verdict**. The review stays advisory — waiting only ensures its comments land
   before the merge; it never blocks the land. `drift-guard` is a hard gate
   either way.

3. **The wait is fail-open.** A reviewer that never registers, or never
   concludes within the poll budget, does not wedge the landing — the wait times
   out and the merge proceeds. An autonomous loop must never deadlock on an
   absent external signal.

## Why

- **Throughput.** The dominant AFK cost is PRs left waiting, not merges that
  shipped without a human glance (see the "merge green PRs same-session" rule).
  Blocking on an external reviewer trades real throughput for advisory comments
  that can be read after the fact.
- **The real guardrail is in-process.** `drift-guard` + feedback validation gate
  every landing already (ADR 0008). The external reviewer is a second opinion,
  not the safety boundary — so it should not have merge-veto power by default.
- **Explicit beats surprising.** Writing the policy down (here + in the AFK
  `SKILL.md` merge-gate note) turns a recurring "is this a bug?" into a
  documented decision with a knob.

## Rejected alternatives

- **Wait for review by default.** Stalls the autonomous queue on a human/rate-
  limited signal with no safety gain over the in-process gates. Rejected as the
  default; offered as the opt-in.
- **Gate the merge on the review verdict (block on failure).** Makes an advisory
  reviewer a hard gate, duplicating `drift-guard`/feedback with a flakier,
  externally-owned signal. The opt-in waits for *conclusion*, never the verdict.
- **No knob at all.** Leaves teams that want CodeRabbit's pass before merge with
  no supported path. The opt-in is cheap and fail-open.

## Consequences

- Default AFK behaviour is unchanged and now documented as intentional.
- Teams can opt into waiting per repo via `.red/config.yaml` without touching
  code; the wait is bounded and fail-open.
- The merge gate's safety contract stays where ADR 0008 put it (in-process
  feedback), and ADR 0030's admin-merge path is unchanged except for the
  optional pre-merge poll.

Memory-NoIngest: ADR + config knob; the canonical claim for the admin-merge
landing stays with ADR 0030 and the merge-refusal contract with ADR 0008.
