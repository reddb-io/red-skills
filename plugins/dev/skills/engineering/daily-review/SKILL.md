---
name: daily-review
description: Generates a RedSkills daily operational review focused on delivered work, local AFK workers, cycle times, and HITL/blocker challenges. Use when the user invokes `/daily-review`, asks for yesterday/today delivery numbers, daily issues/PRs/commits/diffstat, worker attempts, token spend, or why tasks needed HITL.
argument-hint: "[--json] [--human]"
---

# /daily-review

**Wrapper over the dev runtime — never hand-calculate.**

Render the RedSkills daily review.

## Run

Run the host-level RedSkills dev runtime shim:

```bash
red-skills-dev daily-review [--json]
```

When developing inside the red-skills source checkout, this repo-local path is
also valid:

```bash
node plugins/dev/skills/engineering/afk/bin/afk.mjs daily-review [--json]
```

## Output format

**TOON by default** (PRD #928 / ADR 0081) — the agent-facing wire format is
token-cheap by design: the `workers`, `challenges`, and cycle-time tables render
as one column header plus bare CSV rows, the big-number aggregates are
pre-computed, and empty tables render the definitive `key[0]:` empty state.
`--json` forces raw JSON; `--human` prints the prose review.

## Interval

The interval is always from local midnight at the start of yesterday through
the exact generation time. Example: if now is `2026-06-06 14:25`, the interval
is `2026-06-05 00:00` through `2026-06-06 14:25`.

## Report Sections

- Big numbers: issues created/closed, PRs created/closed/merged, commits, lines
  added/removed, local workers, local attempts, local worker time, token spend
  when retained runner logs expose usage fields.
- Local workers: worker id, attempts, issues, runner, duration, and terminal
  events from `.red/state/afk-history.jsonl` plus live local worker state.
- Challenges: HITL/blocker/no-sentinel/merge-conflict evidence from issue
  labels, issue bodies/comments, and local AFK history reasons.
- Issue and PR cycle times: closed-in-interval rows include items opened before
  the interval, so old work closed yesterday remains visible.

## Notes

Token spend is best-effort. Current AFK artifacts do not guarantee usage fields;
the report says `n/a` and emits a warning when no retained local log has token
data.
