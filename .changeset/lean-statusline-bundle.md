---
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---

The statusline ships as its own lean bundle, ending the 1.2s-per-render tax

Every prompt render invoked the full daemon bundle, whose import-time
initialization costs ~1.2s of module evaluation before the statusline runs
(node itself boots in ~70ms). The statusline now also ships as
`statusline.bundle.min.mjs` — same command module, same render, none of the
daemon's import graph — evaluating in ~0.19s. The daemon stabilizes it beside
its own bundle as `statusline-<version>.bundle.min.mjs` (a name deliberately
outside the `redskilled-*` glob, so version sorting can never hand the lean
renderer to the daemon half), and the published statusline command prefers it,
falling back to the full bundle on hosts that predate it.
