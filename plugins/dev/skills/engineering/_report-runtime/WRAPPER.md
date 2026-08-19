# Report Runtime Wrapper

All RedSkills operational-report skills delegate to the dev runtime; they never
hand-calculate metrics.

## The runtime is the `rs_dev` Plugin MCP

**A report skill calls a tool; it runs no binary** (ADR 0147 rule 1). The `dev`
plugin ships one Plugin MCP, `rs_dev` — a thin, stateless ACP client of the
`redskilled` daemon that publishes tool schemas and forwards calls. Every
operational report these skills produce is one of its tools, and the tool
returns the core's value rather than a rendered table somebody has to re-read.

The complete tool surface, the host tool-name prefix rule, and the mutation-mode
contract live in [`../afk/MCP.md`](../afk/MCP.md). Read it before the first call;
never restate the tool list in a report skill.

| Report | Tool | Mode |
| --- | --- | --- |
| Daily activity review | `daily_review` | read |
| Weekly activity review | `weekly_review` | read |
| Operational dashboard | `dashboard` (`periodDays`) | read |
| Skill audit scores | `audit_skills` (`mechanical_only`) | read |
| Issue resumption report | `retake` | read |
| Doctor findings | `red_doctor` | read |

**Hosts prefix MCP tool names.** Claude Code and Codex surface plugin MCP tools
as `mcp__<server-slug>__<tool>` — resolve the exact identifier with a tool search
for the bare name once, then reuse it for the session. Tables and prose always
use the bare name.

## When the tools are not there

**First ask whether the plugin was installed or updated in THIS session — if so,
run `/reload-plugins` (or start a new session).** A host registers MCP servers at
plugin load, so a mid-session install writes the declaration and starts no
process: the manifests read valid on disk while the session sees zero tools. That
is a load-lifecycle gap wearing the shape of an outage.

**There is no second implementation to fall back to.** ADR 0147 rule 1 deleted
the dev CLI rather than deprecating it, because a documented fallback is a second
engine that ages at its own pace — which is how one machine came to run three
versions of the same verbs. When the tools are unreachable and the reload is ruled
out, say so and stop: the repair is the daemon and the plugin load, never a
hand-rolled shell reimplementation of the report.

Host lifecycle — is the daemon up, is this project registered, what does this
machine hold — is the `redskilled` binary's own argv, documented by
[`../redskilled/SKILL.md`](../redskilled/SKILL.md).

## Output format

**TOON by default** (ADR 0081, ADR 0089) — the agent-facing wire format is
token-cheap by design: pre-computed aggregates, minimal schemas, and definitive
empty states. Every tool returns one structured TOON document per call. Read the
fields; do not re-parse rendered text.
