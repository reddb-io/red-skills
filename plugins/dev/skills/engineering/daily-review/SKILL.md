---
name: daily-review
description: Generates a RedSkills daily operational review focused on delivered work, local AFK workers, cycle times, and HITL/blocker challenges. Use when the user invokes `/daily-review`, asks for yesterday/today delivery numbers, daily issues/PRs/commits/diffstat, worker attempts, token spend, or why tasks needed HITL.
argument-hint: "[--json]"
---

# /daily-review

Render the RedSkills daily review. This skill is a wrapper over the dev runtime
command; do not hand-calculate the metrics.

## Run

Resolve the plugin root before running the review. Use the first available
source:

1. `$CLAUDE_PLUGIN_ROOT` under Claude Code.
2. `$CODEX_PLUGIN_ROOT` under Codex when the host exposes it.
3. The loaded `SKILL.md` path: from `skills/engineering/daily-review/SKILL.md`,
   the plugin root is `../../..`.

Then run:

```bash
node "$PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" daily-review [--json]
```

When developing inside the red-skills source checkout, this repo-local path is
also valid:

```bash
node plugins/dev/skills/engineering/afk/bin/afk.mjs daily-review [--json]
```

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
