---
"@reddb-io/rsp": patch
---

The bundled rsp resident finds the `red` engine binary again. esbuild inlines
`@reddb-io/sdk`, so the SDK's `<package>/bin/red` probe — derived from its own
module URL — resolved against the BUNDLE's directory and looked for
`<repo>/bin/red`, a path that never existed. rsp now looks the SDK package up at
runtime by walking the `node_modules` trees above the running module and the
cwd, and states the whole cascade in one ordered place: `REDDB_BIN` verbatim,
then the SDK package's `bin/red`, then the red-skills warm cache newest-first,
then `red` on `PATH` as a last resort.
