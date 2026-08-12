---
"@reddb-io/red-skills": patch
---

toon and tq ride 0.26.2 across the catalog, every pin site, and the Pi mirrors.

The pnpm catalog, the host-toolchain doctor's pin, both CI workflows'
`TQ_VERSION`, and the red-setup interview move together from 0.22.0 to 0.26.2,
with the generated Pi mirrors regenerated to match. The 0.26 encoder's new
`primitiveArrayColumns`/`objectArrayColumns` options are available but not yet
enabled by any writer, so no persisted file changes shape.
