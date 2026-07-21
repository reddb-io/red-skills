# 0119 — Cheap trust checks run before the expensive suite, under one verdict

- **Status**: accepted
- **Date**: 2026-07-21
- **Related**: ADR 0081 (`/go`, closed mechanical allowlist + context-aware escalation), ADR 0055 (no-agent landing lane / `--adopt-branch`), ADR 0118 (cascade outcome on the sibling's issue), issue #1102 (sensitive-path guard), issue #1171 (the adopt-path bypass)

## Context

The machine gate has three kinds of check with wildly different costs:

1. **trust** — a handful of regexes over the branch diff: does it touch a CI
   workflow, a git hook, a `package.json` lifecycle script, or `.red/` trust
   configuration? Milliseconds.
2. **feedback** — the package test/typecheck/lint suite. Minutes.
3. **backpressure** — the operator's extra commands. Minutes.

Dev ran them in the order 2 → 3 → 1: the sensitive-path guard (#1102) lived at
step 0a of `doLanding`, i.e. **after** the whole suite had already passed. A diff
that could never auto-land still paid for the suite in full before being parked.
The three verdicts were also three independent booleans, so "which check decided
this attempt's fate" was something a reader reassembled from control flow.

The castle twin runs its trust checks first and returns a single `ok`. #2231
catalogued both halves; #2245 ruled them **harvested**.

## Decision

**The gate's stages are ordered cheap → expensive, and they fold into one
verdict.**

- `GATE_STAGE_ORDER` states the order — `trust`, `feedback`, `backpressure` — and
  `gateVerdict` folds stage outcomes into a single `{ ok, failedStage }`. The
  fold is **order-independent for the caller**: stages may be passed in any
  order, and only those run so far, and the verdict still names the *earliest*
  blocker. "Which stage decided this" stops depending on the order the caller
  happened to evaluate them in.
- The sensitive-path scan runs on the branch diff **before validation**. A hit
  parks `sensitive-path` immediately; the suite never starts.
- **The landing keeps its own step-0a scan.** The early check is an early exit,
  not a move: the landing is the trust boundary, other callers reach it by other
  paths (ADR 0055's `--adopt-branch` lane sets `sensitivePathApproved`, which the
  autonomous path never does), and the diff can grow between validation and
  merge. For the same reason the diff resolver is deliberately **not memoised** —
  the landing judges the diff as it stands at merge time. Two `git diff` calls
  are noise next to the suite this ordering saves.
- **A check that cannot read the diff has no verdict, so it must not pass.** A
  lookup failure in the *early* scan is logged and validation proceeds (the
  landing-time guard still applies); a lookup failure in the *landing* scan
  aborts the landing as `infra` with the git error as the refusal reason. It
  previously propagated out of `doLanding` and crashed the worker.

**Dev keeps its distinct terminal routes.** `sensitive-path`, `feedback-failed`
and the backpressure route map to different recovery lanes and different
envelopes; the unified verdict is the *ordering contract plus one `ok`*, not a
collapse of the routing.

## Consequences

- **An unlandable diff costs seconds instead of a suite.** The saving is largest
  exactly where it hurts most today: `.red/` and workflow edits, which are common
  in this repo and always park.
- **The ordering is stated, not implied.** A future stage declares its place in
  `GATE_STAGE_ORDER` instead of being wedged wherever the control flow allowed.
- **The guard is now failure-safe in both directions**: it cannot be skipped by a
  git error, and a git error cannot crash the attempt.

## Rejected alongside

#2231 catalogued the twin's **in-flight sensitive-path approval sink** — a gate
sink that can approve a sensitive path mid-attempt. #2245 ruled it **discarded**:
dev keeps out-of-band pre-approval through `/requeue --adopt-branch` (ADR 0055,
#1171). The hard invariant that makes the guard worth anything is that approval
is **unreachable from an autonomous attempt** — a human reviews the protected
diff and then re-dispatches. An in-flight sink is exactly the reachable path that
invariant forbids.
