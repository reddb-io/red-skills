# @reddb-io/rsp

`rsp` is the neutral RedSkills binary for reversible command-output elision.
This package currently carries the elision store and retrieval command from ADR
0095; wrappers and hook interception land in later slices.

Elision handles are stable short content-addressed ids rendered as `el:<id>`,
where `<id>` is 12 lowercase hexadecimal characters. The only write API is
`RspElisionStore.mint(original, meta)`, which stores the original bytes and
returns the handle, preserving the handle/elision invariant.

The store uses the namespaced `rsp_elisions_v1` KV collection in the repo RedDB
store. Retention defaults are `ttlDays: 7` and `byteBudget: 67108864`; top-level
`.red/config.yaml` keys `rsp.ttlDays` and `rsp.byteBudget` override them.

`rsp show el:<id>` writes the original bytes verbatim to stdout. Expired or
evicted handles write `expired <ISO date> — re-run: <original command>` to stdout
and exit 1. Calling `rsp` with no arguments prints live store stats as scalar
TOON fields instead of help text.
