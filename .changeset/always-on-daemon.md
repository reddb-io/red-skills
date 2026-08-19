---
"@reddb-io/red-skills": minor
---

The daemon is always on: provisioning installs a service with no idle exit, and clients fail closed

ADR 0150 §4 makes `redskilled` an OS service rather than something a client
spawns on demand. `provision` now installs the unit with **no idle-exit tunable**
— the idle timer is removed from the daemon lifecycle, not defaulted off — and a
client that finds no daemon exits non-zero with the canonical repair invocation
and spawns nothing, closing the path where whichever bundle a client happened to
carry decided which daemon ran (ADR 0143's resident-by-accident).

The idle-exit coverage is deleted with the feature it proved, declared on the
Ticket; `auto-spawn.test.ts` becomes `daemon-birth.test.ts`, a rename rather than
a loss.
