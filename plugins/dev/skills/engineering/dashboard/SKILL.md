---
name: dashboard
description: Shows a RedSkills operational dashboard with issue, PRD, AFK worker, flow, and DORA-proxy metrics from GitHub plus local AFK state. Use when the user invokes `/dashboard`, asks for RedSkills process metrics, workers running, open PRDs/issues, cycle time, or DORA metrics.
argument-hint: "[--period N|Nd] [--json]"
---

# /dashboard

Render the RedSkills process dashboard. This skill is a wrapper over the dev
runtime command; do not hand-calculate the metrics.

## Run

Resolve the plugin root before running the dashboard. Use the first available
source:

1. `$CLAUDE_PLUGIN_ROOT` under Claude Code.
2. `$CODEX_PLUGIN_ROOT` under Codex when the host exposes it.
3. The loaded `SKILL.md` path: from `skills/engineering/dashboard/SKILL.md`,
   the plugin root is `../../..`.

Then run:

```bash
node "$PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" dashboard [--period 30d] [--json]
```

When developing inside the red-skills source checkout, this repo-local path is
also valid:

```bash
node plugins/dev/skills/engineering/afk/bin/afk.mjs dashboard [--period 30d] [--json]
```

## Metrics

- Open PRDs.
- Open non-PRD issues.
- Global running workers: open issues labelled `running`.
- Local workers on this machine: live/stale/total AFK worker state files.
- Issues created, closed today, and closed in the selected period.
- Due metrics from `due: YYYY-MM-DD`, `due_date: YYYY-MM-DD`, `deadline: YYYY-MM-DD`, `target date: YYYY-MM-DD`, or label `due:YYYY-MM-DD`.
- PR flow: open PRs, merged PRs, average issue cycle time, average PR lead time.
- DORA proxies: release frequency, lead time for changes, change-failure-rate proxy, failure-like issues closed, MTTR proxy.

## Notes

The DORA values are explicit proxies, not compliance claims. Change failure and
MTTR depend on issue labels such as `type:bug`, `bug`, `regression`, `incident`,
`type:incident`, or `blocked:validation`.
