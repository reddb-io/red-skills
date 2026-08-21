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

<standing-orders>                                     <!-- omitted when the project states none -->
{the operator's durable directives verbatim — `.red/STANDING-ORDERS.md`, or the
project's standing-orders register. Leads the file because an order read after
the brief is an order read after the agent already chose how to work, and it is
NOT tagged `data-untrusted`: it is the operator's own words, and the exit
protocol's authority sentence names this block whenever it is present}
</standing-orders>

<issue-body>
{issue body verbatim — includes the `## Agent brief`, `## Acceptance`, `## Refs`,
and `## Suggested Skills` markdown sections written by /triage}
</issue-body>

<handoff-enrichment>                                  <!-- omitted when unavailable/empty -->
context:
  name: Dev
  glossary_path: .red/contexts/dev/CONTEXT.md
glossary_terms[1]{term,definition}:
  Handoff,The bounded worker brief assembled before AFK execution.
exemplars[1]{pr,title,shows}:
  123,Keep handoffs bounded,Shows the current handoff assembly seam.
</handoff-enrichment>

<previous-workers>                                    <!-- omitted when empty -->
<previous-worker n="1" status="blocked" worker="wXXXX" duration="0m50s" branch="afk/wXXXX/N-slug">
<notes>
{inner agent's appended notes from prior worker}
</notes>
<log>
{tail of prior worker's stdout, if captured}
</log>
</previous-worker>
</previous-workers>

<prev-failure-context>                                 <!-- omitted on a first run -->
prev-envelope: https://github.com/{owner}/{repo}/issues/{N}
prev-failure-reason:
{verbatim failure.reason from the previous run — the envelope summary}
{branch fresh off the base — do NOT fix-forward on prior history}
</prev-failure-context>

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

`<standing-orders>` is the one durable channel in the handoff: every other
section is rebuilt from the tracker on each respawn, so an instruction given
once is gone unless the operator repeats it. The file is read at every handoff
composition and emitted verbatim — never summarised, reordered or renumbered —
and it is **never sourced from the issue body**, which is external GitHub
content any account can write. Switch it off with
`plugins.dev.afk.standing_orders.enabled: false`; an absent file omits the
section either way.

`<handoff-enrichment>` is repository-derived, advisory orientation in TOON.
At handoff-build time the runtime resolves the issue title, body paths, labels,
and Spec reference through `.red/CONTEXT-MAP.md`, selects at most four matching
entries from the owning glossary, and adds at most two recent merged-PR
exemplars found from `git log` over the relevant paths. The TOON body is capped
at 2400 UTF-8 bytes. Missing maps/glossaries, an unresolved context, and read or
git failures omit this section silently; they never block dispatch or change the
base handoff.

The handoff file follows the same minimalism as the `/handoff` skill — reference artifacts by path, do not duplicate their content.
