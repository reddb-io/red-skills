---
"@reddb-io/redskilled": patch
---

The native-front compile spells npx in ADR 0091's canonical form

`npx -y scriptc@0.0.35 build …` resolved `scriptc@0.0.35` as a COMMAND on the
first live host and failed with "not found"; the canonical
`npx -y -p scriptc@<version> scriptc build …` form runs the pinned package's
binary. Found by the unit-install outcome facts doing exactly their job.
