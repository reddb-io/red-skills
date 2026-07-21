# Adversarial review is a bounded re-seed correction loop

## Status

Accepted. Records the design settled in a `/start` grilling session that adapted
the split-context adversarial-review pattern from the Bun-in-Rust rewrite to the
RedSkills Castle pipeline. The finer parameter choices are carried in the
originating Spec's Human Decisions.

## Context

The RedSkills machine gate (feedback / `ship.ts` / backpressure) validates a
diff by running its tests, lint, and typecheck. That catches code that fails its
own suite; it does not catch code that compiles clean, passes the existing
tests, and is still semantically wrong — the use-after-free / dead-write /
lifetime class, and the same class as the multi-layer `loc=+0 -0` telemetry bug
that cost a full instrumentation session to find. In the autonomous `/afk` lane
no human reads the PR before it merges, so that class lands unreviewed. The
existing `review.ts` engine is advisory only, single-pass, `ready-for-review`
label-triggered, and framed for clarity/refactor ("never change what the code
does") — the opposite of an adversarial bug hunt — and `pre-pr-pipeline.ts` (the
no-mistakes gate) is a stub.

## Decision

Adversarial review is a bounded, autonomous **review → correct** loop, not an
advisory pass and not a park-first gate. It is **opt-in** per repo
(`plugins.dev.review.enabled: true`; strict opt-in per ADR 0067) and, when
enabled, runs in the `/afk` lane and in `/go --mode no-mistakes` (filling the
`pre-pr-pipeline.ts` stub).

Per round, after the implementer produces a PR and **only once the machine gate
is green**:

- One or more **uniform** reviewer agents (same prompt, both dimensions) inspect
  the diff for **defects** and for **conformance** to the originating Issue —
  anchored on its `## Acceptance criteria` (the `--dod` for `/go`), with the body
  as context. The reviewer runs in an **isolated context**, seeing only the diff
  and the Issue, never the implementer's reasoning.
- Findings are posted **in full to both the PR and the Issue** (the Issue stays
  self-contained). Only **blocking** findings (a confirmed defect or a
  conformance gap) force correction; nits/style/suggestions are advisory.
- A blocking finding re-seeds the **implementer** with a context narrowed to the
  diff and the critiques. The reviewer never edits code; the implementer never
  reviews.

The loop is bounded by a configurable **iteration budget (default 1)**: the
default does one review and one correction, then lands. When the budget is
raised and is **exhausted with blocking findings still open**, the Issue is
**parked `ready-for-human`** — the stubborn / real-bug case earns a human, and
at the default budget of 1 this never fires.

Reviewer **count is 1 by default** (any blocking finding drives the loop),
configurable to N with a quorum. **Model and runner default to the
implementer's** — context isolation, not model diversity, is what the pattern
proved — with cross-model as a configurable upgrade. **Model, effort, and runner
are all configurable** under `plugins.dev.review.*`.

**Amendment (#2352, 2026-07-21).** Two properties the first implementation
lacked, learned from a fleet-wide landing outage:

- **The reviewer is one coherent (runner, model, effort) tuple, not three
  independent knobs.** A configured model is honoured only on a runner whose CLI
  can dispatch it — the runner spec registry owns that answer — and an
  unsupported pin is substituted with that runner's review-tier default under a
  logged notice. A codex model pinned repo-wide and spawned through the claude
  CLI is not a degraded review; it is an immediate non-zero exit.
- **Advisory failure is never fatal.** The pass has exactly three legal verdicts
  — pass, correct, park. Infrastructure failure of the reviewer itself is none of
  them: the attempt is already machine-validated when the pass runs, so a
  crashed reviewer degrades to "pass with a logged warning" plus an attempt-ledger
  record, and the landing proceeds.

## Considered options

- **Advisory-only** (keep `review.ts`'s shape): rejected — advisory findings do
  not protect the autonomous drain, where no human acts on them.
- **Park-first** (any finding parks a human): rejected — it turns a bug-catcher
  into a drain-staller; the re-seed loop lets the implementer fix autonomously
  and reserves the human for genuine exhaustion.
- **On by default**: rejected — the extra reviewer/correction rounds add cost and
  landing latency; strict opt-in matches the plugin model.
- **Specialized reviewers per dimension**: rejected in favor of one uniform
  prompt — the conformance check needs the Issue anyway, so a single reviewer
  already sees diff + Issue.
- **Cross-model reviewer as the default**: rejected as the floor — it requires
  two configured backends; offered as config instead.

## Consequences

- Catches the compile-clean / tests-green / semantically-wrong class before it
  lands in the autonomous lane — the stated goal.
- Adds reviewer + correction token cost and landing latency to every reviewed PR;
  contained by opt-in, a default single reviewer, and a default single iteration.
- Gives `pre-pr-pipeline.ts` (no-mistakes) a real implementation to grow into.
- The `park ready-for-human` exit reuses the existing HITL blocker-state /
  `## Current blocker` machinery.
