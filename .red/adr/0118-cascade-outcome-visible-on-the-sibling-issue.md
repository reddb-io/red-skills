# 0118 — A cascade outcome is visible on the sibling's issue

- **Status**: accepted
- **Date**: 2026-07-21
- **Related**: ADR 0071 (AFK resilience — landing serialization), ADR 0108 (trunk freshness via the `red-trunk` mirror), ADR 0119 (cheap trust checks before the expensive suite)

## Context

When a DONE attempt lands, AFK cascades: every sibling branch under the same
`spec:N` is rebased onto the exact merge SHA the landing produced, unless its
worker is still alive. That is a change made to **someone else's** branch by a
landing on **someone else's** issue.

Until now the outcome went only to `appendIterLog` — the landing worker's own
iteration log. From the sibling's side there is no trace at all: its branch has
silently moved (or silently not moved), and the next worker to pick that issue up
starts by reconstructing what happened from git. A failed cascade is worse: the
branch is left on the pre-landing base and nothing on the issue says so, so the
next attempt discovers it as a surprise conflict.

The castle twin comments each cascade outcome on the sibling's issue. #2231
catalogued that as a twin-encoded decision; #2245 ruled it **harvested**.

## Decision

**Every cascade outcome is posted to the sibling's own issue, not only to the
landing worker's log.**

- All three outcomes are reported — `rebased`, `skipped-active` (the sibling's
  worker is still alive), and `failed`. A skip is a decision, not a non-event:
  the sibling learns *why* its branch was left alone.
- Each comment names the **branch**, the **landed issue**, and the **exact merge
  SHA** the branch was rebased onto (ADR 0108 / #2277 pinned that SHA rather than
  a moving branch name), so a reader can tell a moved base from a stale one.
- The wording lives in one pure renderer (`cascadeRebaseComment`), so the message
  is testable without a tracker.
- Posting is **per-sibling best-effort**: a failed comment is logged and the
  cascade moves on. One unreachable issue must never strand the remaining
  siblings on a stale base — the cascade's job is the rebase; the comment is how
  it is seen.

The iteration log keeps its lines. This adds a reader-facing surface; it does not
move one.

## Consequences

- **The next worker on a sibling starts informed.** "Your base moved to
  `<sha>` when #N landed" is on the issue it is about to read anyway.
- **A failed cascade is now visible where it matters** instead of surfacing later
  as an unexplained conflict.
- **Cost is one comment per sibling per landing.** Bounded by the number of open
  siblings under a Spec, and only on a successful land.

## Rejected alongside

#2231 also catalogued the twin's **cascade-before-close** ordering (cascade the
siblings, then close the landed issue). It was verified to differ but **not
verified to be deliberate** — no ADR, glossary entry, or commit message asserts a
rationale for it. #2245 ruled it **discarded**: dev keeps its proven order
(close, then cascade). An ordering nobody can show was chosen is not a decision
to harvest.
