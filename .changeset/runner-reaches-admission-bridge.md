---
"@reddb-io/redskilled": patch
---

The declared runner survives the unattended-turn admission bridge. The demand
turn stated the runner on its prompt request, but admission reads the SESSION
request — and the bridge built that one synthetically with no meta, so every
unattended Worker still fell back to the default child. The synthetic
`session/new` now restates the runner, through one pure, pinned builder.
