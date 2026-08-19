---
name: daily-review
working-mode: spec-driven
description: Generates a RedSkills operational review for a requested period. Default period is yesterday midnight to now (one day); pass `--period week` for a six-day window. Covers delivered work, local AFK workers, cycle times, and HITL/blocker challenges. Use when the user invokes `/daily-review`, `/weekly-review`, asks for daily or weekly delivery numbers, issues/PRs/commits/diffstat, worker attempts, token spend, or why tasks needed HITL.
argument-hint: "[--period day|week] [--json] [--human]"
disable-model-invocation: true
---

# /daily-review

<what-to-do>

**Client of the `redskilled` MCP — the review tools are the primary surface.**
Call the read tool matching the requested period — `daily_review` (default) or
`weekly_review`, both `{}` — and present the structured TOON report; the tool
surface and host prefix rule live in [`../afk/MCP.md`](../afk/MCP.md).

When the MCP is unreachable, name that and fall back to the `red-skills-dev`
CLI — same engine, same cores (see
[`_report-runtime/WRAPPER.md`](./../_report-runtime/WRAPPER.md) for the Run
shim and output-format rules):

| Period flag | Subcommand |
| --- | --- |
| `--period day` (default) | `npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev daily-review [--json]` |
| `--period week` | `npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev weekly-review [--json]` |

Dev-checkout equivalent:

| Period flag | Command |
| --- | --- |
| `--period day` (default) | `node plugins/dev/skills/engineering/afk/bin/afk.mjs daily-review [--json]` |
| `--period week` | `node plugins/dev/skills/engineering/afk/bin/afk.mjs weekly-review [--json]` |

</what-to-do>

<supporting-info>

## Intervals

**day (default):** local midnight at the start of yesterday through the exact
generation time. Example: if now is `2026-06-06 14:25`, the interval is
`2026-06-05 00:00` through `2026-06-06 14:25`.

**week:** local midnight six calendar days before today through the exact
generation time. Example: if now is `2026-06-06 14:25`, the interval is
`2026-05-31 00:00` through `2026-06-06 14:25`.

## Output format detail

The TOON wire format renders the `workers`, `challenges`, and cycle-time tables
as one column header plus bare CSV rows; big-number aggregates are pre-computed;
empty tables use the definitive `key[0]:` empty state.

## Report Sections

- Big numbers: issues created/closed, PRs created/closed/merged, commits, lines
  added/removed, local workers, local attempts, local worker time, token spend
  when retained runner logs expose usage fields.
- Local workers: worker id, attempts, issues, runner, duration, and terminal
  events from the `.red/state/castle/history.toonl` TOONL lane plus live local
  worker state. `tq` is pinned by `/red-setup` and is the only documented
  reader for RedSkills-owned TOONL lanes; there is no jq fallback.
- Challenges: HITL/blocker/no-sentinel/merge-conflict evidence from issue
  labels, issue bodies/comments, and local AFK history reasons.
- Issue and PR cycle times: closed-in-interval rows include items opened before
  the interval, so old work closed in the review window remains visible.

## Notes

Token spend is best-effort. Current AFK artifacts do not guarantee usage fields;
the report says `n/a` and emits a warning when no retained local log has token
data.

</supporting-info>
