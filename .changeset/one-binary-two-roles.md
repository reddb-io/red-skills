---
"@reddb-io/red-skills": patch
---

The Castle resident is a role of the MCP bundle, not a second binary

#3804 shipped the resident as `castle-resident.bundle.min.mjs`, resolved as a
sibling file by filename arithmetic. One application became two artifacts that
must travel together, and that pairing was then enforced by hand in five places:
the npm bin shim, the source-checkout hook, the npm staging list, three checks in
the publish workflow, and a test file whose every assertion said "both".

It is now `__castle-resident`, an argv role on the same bundle — the pattern this
repository already uses for `__mcp-canary` and `__self-update`. The spawn names
the running file plus the role, so a cache-keyed proxy cannot skew against its
resident and no layout can ship half of the pair, because there is no pair.

ADR 0143 is unchanged: its decision is about processes and ownership, not
artifact count. The role runs in the process the proxy spawns, so the stdio host
still owns no engine and still crosses the socket for every call — "no client
hosts an in-process fallback" holds, and the boundary test now says so in those
terms instead of by counting static imports.
