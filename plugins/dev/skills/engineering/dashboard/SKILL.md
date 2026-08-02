---
name: dashboard
description: Shows a RedSkills operational dashboard with issue, Spec, AFK worker, flow, and DORA-proxy metrics from GitHub plus local AFK state. Use when the user invokes `/dashboard`, asks for RedSkills process metrics, workers running, open Specs/issues, cycle time, or DORA metrics.
argument-hint: "[--period N|Nd] [--json] [--human]"
disable-model-invocation: true
---

# /dashboard

<what-to-do>

**Client of the `castle` MCP — the `dashboard` tool is the primary surface.**
Call the read tool `dashboard` — `{periodDays?}` (default 30) — and present its
structured TOON result; the tool surface and host prefix rule live in
[`../afk/MCP.md`](../afk/MCP.md).

When the MCP is unreachable, name that and fall back to the `red-skills-dev`
CLI — same engine, same cores (see
[`_report-runtime/WRAPPER.md`](./../_report-runtime/WRAPPER.md) for the Run
shim and output-format rules):

Run: `npx -y -p @reddb-io/red-skills@<version> red-skills-dev dashboard [--period 30d] [--json]`

Dev-checkout equivalent: `node plugins/dev/skills/engineering/afk/bin/afk.mjs dashboard [--period 30d] [--json]`

</what-to-do>

<supporting-info>

## Output format detail

The TOON wire format uses pre-computed aggregate groups, minimal schemas, and a
definitive `warnings[0]:` empty state.

## Metrics

- Open Specs.
- Open non-Spec issues.
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

</supporting-info>
