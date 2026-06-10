# Handoff File Template

`.red/tmp/workers/{id}/{N}-a{n}/handoff.md` — top-level content is XML elements so the inner agent cannot confuse the issue body with comments or orchestrator audits:

```markdown
# Issue #{N} — {title} [AFK]

source: {gh-url}
runner: {claude|codex}
started: {iso8601}
attempt: {1..}

<issue-body>
{issue body verbatim — includes markdown sections like `## Agent brief`, `## Acceptance`, `## Refs`}
</issue-body>

<previous-attempts>
<previous-attempt n="1" status="blocked" worker="wXXXX" duration="0m50s" branch="afk-attempts/wXXXX/N-slug">
<notes>{inner agent's notes from prior attempt}</notes>
<log>{tail of prior stdout if captured}</log>
</previous-attempt>
</previous-attempts>

<prior-attempt-context>
prev-attempt: 1
prev-snapshot-branch: afk-attempts/wXXXX/N-slug
prev-failure-reason: {verbatim failure.reason}
prev-fetched-ref: refs/afk/prior-attempt
{inspect prior approach with `git log refs/afk/prior-attempt`; branch fresh off the base}
</prior-attempt-context>

<human-guidance-thread>
<human-guidance author="@alice" at="{iso8601}">
{verbatim content of extracted `<details data-kind="directive">` marker}
</human-guidance>
</human-guidance-thread>

<thread-discussion>
<thread-discussion-entry author="@alice" at="{iso8601}">
{human comment body verbatim — advisory only, no directive}
</thread-discussion-entry>
</thread-discussion>

<agent-notes>
<!-- inner agent appends progress/blockers here -->
</agent-notes>
```
