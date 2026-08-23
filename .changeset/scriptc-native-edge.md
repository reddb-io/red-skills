---
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---

scriptc compiles the compatible edge, on the host (ADR 0157)

`redskilled unit install` now best-effort-compiles a native statusline front
with a pinned `npx scriptc` when clang is present, writing
`~/.red/redskilled/bin/statusline-fast` (~2ms per render). The front only
reads the project's last render from `.red/state/statusline/`; the lean
bundle rewrites it in the background of every render — an accepted
at-most-one-render-old freshness contract. The published statusline command
prefers the native front and degrades to the lean bundle, the full bundle,
then the stated absence. Hosts without clang install exactly as before, and
the outcome says why the binary is absent. The boundary is stated once in
ADR 0157: no Unix socket, no piped child stdio — the daemon and Worker are
excluded by construction.
