# /start lands grilling docs before cascade

## Status

Accepted. Implements issue #1284 and records the PRD #1283 flow decision.

## Context

`/start` grilling sessions deliberately mutate glossary and ADR files while the
decision tree is being resolved. Those docs are the source of truth for later
`/to-prd`, `/to-issues`, and `/afk` work, but the useful edits can sit only in
the primary checkout if the session ends before an explicit landing step.
Downstream agents then see stale origin docs even though the human just made a
decision.

## Decision

Docs truth lives on origin's base ref. When a `/start` session ends, the skill
runs an end-of-session doc-landing finalizer that detects dirty glossary and ADR
files, offers the user a decline, and, if accepted, lands one docs PR through the
standard isolated worktree lane. It never commits in the primary checkout,
switches the primary branch, stashes, or resets.

The follow-up cascade gate is the invariant that makes this durable: cascading
from `/start`-produced docs to PRDs, issues, or AFK must require the relevant
docs to be present on origin's base ref. The gate itself ships in the follow-up
slice, but the architectural decision is one flow: finalizer at session end,
gate before cascade.

## Considered Options

- **Land at write time.** Rejected because grilling edits are incremental and
  often provisional; committing every term or ADR candidate would create noisy
  history and interrupt the interview loop.
- **Land only at cascade time.** Rejected because it hides the source-of-truth
  transition until a later command and makes stopped sessions easy to forget.
- **Inject dirty docs into AFK handoffs.** Rejected because AFK-side handoff
  injection would make each worker carry session-local truth instead of reading
  the same origin base ref, increasing drift and making enforcement harder to
  audit.

## Consequences

The finalizer is a little more ceremony at session end, and users can still
decline it. That is intentional: the cascade gate remains the enforcement point
when docs are needed for downstream execution. Once downstream skills depend on
origin-visible docs, reversing this flow would affect every cascade and worker
handoff, so the decision is recorded here instead of living only in skill prose.
