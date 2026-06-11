# AFK handoff file template (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> The exact `handoff.md` the inner agent reads — the XML-wrapped issue body, prior attempts, human guidance, and agent notes.

## Handoff File Template

`.red/tmp/workers/{id}/{N}-a{n}/handoff.md`:

Top-level content is XML elements (not markdown headers) so the inner agent
cannot confuse the issue body with comments, or human direction with
orchestrator audits. Markdown sections like `## Agent brief`, `## Acceptance`,
`## Refs`, and `## Suggested Skills` live *inside* the `<issue-body>` element
(they are part of the issue body verbatim).

```markdown
# Issue #{N} — {title} [AFK]

source: {gh-url}
prd: {prd-url-or-issue-ref}        # omit if none
runner: {claude|codex}
started: {iso8601}
attempt: {1..}

<issue-body>
{issue body verbatim — includes the `## Agent brief`, `## Acceptance`, `## Refs`,
and `## Suggested Skills` markdown sections written by /triage}
</issue-body>

<previous-attempts>                                    <!-- omitted when empty -->
<previous-attempt n="1" status="blocked" worker="wXXXX" duration="0m50s" branch="afk-attempts/wXXXX/N-slug">
<notes>
{inner agent's appended notes from prior attempt}
</notes>
<log>
{tail of prior attempt's stdout, if captured}
</log>
</previous-attempt>
</previous-attempts>

<prior-attempt-context>                                <!-- omitted on a first attempt -->
prev-attempt: 1
prev-snapshot-branch: afk-attempts/wXXXX/N-slug
prev-failure-reason:
{verbatim failure.reason from the previous attempt — the envelope summary}
prev-fetched-ref: refs/afk/prior-attempt
{inspect the prior failed approach with `git log refs/afk/prior-attempt`; you
branch fresh off the base — do NOT fix-forward on it}
</prior-attempt-context>

<human-guidance-thread>                                <!-- omitted when empty -->
<human-guidance author="@alice" at="{iso8601}">
{verbatim content of one extracted <details data-kind="directive"> marker — one
<human-guidance> element per directive, so a single comment carrying two markers
emits two siblings with identical author/at}
</human-guidance>
</human-guidance-thread>

<thread-discussion>                                    <!-- omitted when empty -->
<thread-discussion-entry author="@alice" at="{iso8601}">
{human comment body verbatim that carried no directive marker — advisory only,
lowest authority; orchestrator audits already filtered out by body shape}
</thread-discussion-entry>
</thread-discussion>

<agent-notes>
<!-- inner agent appends progress/blockers here across attempts -->
</agent-notes>
```

The handoff file follows the same minimalism as the `/handoff` skill — reference artifacts by path, do not duplicate their content.

