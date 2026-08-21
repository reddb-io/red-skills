---
"@reddb-io/redskilled-render": patch
"@reddb-io/redskilled": patch
"@reddb-io/shared": patch
"@reddb-io/dev": patch
---

statusline: rebuild the Worker lifecycle bar, add the day's landed lines, and let an idle host say what it last did

- The lifecycle bar returns to the Worker row. `progressBar` now resolves a position from the phase word through a declared table (`lifecycle-phase.ts`) when a project publishes no `phase_index`/`phase_total` — which is every native Worker, since its pulse carries a ticket stage and nothing else. An undeclared phase draws no bar.
- `mrg=` gains the trunk's added/removed lines for the operator's calendar day, measured by the repository-activity poll that already counted the merges. It degrades to absent — never to a zero — when the comparison is unreachable or truncated.
- An idle host renders `idle·<outcome> #<issue> <age>` from the Worker outcome marks the daemon already keeps and already replays from its event lane.
- The statusline head gives up `iss=`; the dashboard keeps it.
