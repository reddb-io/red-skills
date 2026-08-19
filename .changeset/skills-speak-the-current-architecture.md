---
"@reddb-io/red-skills": patch
---

The skills stop teaching an architecture the code already refuses

`domain-vocabulary-guard` and `extinct-execution-chain` sweep source — never
`plugins/*/skills/**`, which is what an AGENT reads. So the shipped skills kept
describing a Castle resident, a `red-castle` engine, and a statusline "producer
in the dev bundle" long after ADR 0144 retired the resident, ADR 0153 renamed the
package and #4031 deleted the bundle.

Corrected across the dev plugin's skills: the statusline is rendered by the
daemon, not a dev-bundle producer; the drain reaches the daemon's Project control
state, not a resident; the engine is `@reddb-io/worker`; and `/red-doctor` looks
for `rs_dev`. Historical references keep their names with the ADR that renamed
them stated next to each.
