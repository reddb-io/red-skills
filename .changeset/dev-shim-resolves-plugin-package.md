---
"@reddb-io/red-skills": patch
---

The `red-skills-dev` shim finds the bundle in the plugin package that now owns it

ADR 0146 moved every per-plugin runtime bundle into
`@reddb-io/red-skills-<plugin>` and left the bin surface in the core package, so
the shim looked for `dist/dev.bundle.min.mjs` beside itself and found nothing:
3.20.0 and 3.21.0 both publish a `dist/` without it. Every Worker the daemon
birthed died on `red-skills-dev: packaged bundle missing` before it could claim a
Ticket, which is a fully stopped drain on any host running a current release.

The lookup is ordered — this package's own `dist/` first so an older install
keeps working, then `@reddb-io/red-skills-dev` — and the failure message names
both locations and the command that installs the missing one.
