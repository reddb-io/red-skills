---
name: weekly-review
description: Generates a RedSkills six-day operational review focused on delivered work, local AFK workers, cycle times, and HITL/blocker challenges. Use when the user invokes `/weekly-review`, asks for weekly delivery numbers, issues/PRs/commits/diffstat, worker attempts, token spend, or why tasks needed HITL.
argument-hint: "[--json]"
---

# /weekly-review

**Wrapper over the dev runtime — never hand-calculate.**

Render the RedSkills weekly review.

## Run

Run the host-level RedSkills dev runtime shim:

```bash
red-skills-dev weekly-review [--json]
```

When developing inside the red-skills source checkout, this repo-local path is
also valid:

```bash
node plugins/dev/skills/engineering/afk/bin/afk.mjs weekly-review [--json]
```

## Interval

The interval is always from local midnight six calendar days before today
through the exact generation time. Example: if now is `2026-06-06 14:25`, the
interval is `2026-05-31 00:00` through `2026-06-06 14:25`.

## Report Sections

- Big numbers: issues created/closed, PRs created/closed/merged, commits, lines
  added/removed, local workers, local attempts, local worker time, token spend
  when retained runner logs expose usage fields.
- Local workers: worker id, attempts, issues, runner, duration, and terminal
  events from `.red/state/afk-history.jsonl` plus live local worker state.
- Challenges: HITL/blocker/no-sentinel/merge-conflict evidence from issue
  labels, issue bodies/comments, and local AFK history reasons.
- Issue and PR cycle times: closed-in-interval rows include items opened before
  the interval, so older work closed during the review window remains visible.

## Notes

Token spend is best-effort. Current AFK artifacts do not guarantee usage fields;
the report says `n/a` and emits a warning when no retained local log has token
data.
