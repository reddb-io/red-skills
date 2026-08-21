---
"@reddb-io/dev": patch
---

A dependency-direction ratchet joins the repo invariants. pnpm and turbo refuse
a cycle; neither refuses a direction, so a shared package could import a runtime
and every check stayed green. `DEPENDENCY_LAYERS` declares the stack once —
primitive, shared, wire, engine, daemon, runtime, benchmark — and the rule over
it is that a dependency may only reach a strictly lower layer. Both the manifest
edge and the source import are judged, including a relative reach that climbs
out of its own workspace, and a violation names the importer, the imported, and
the rule. Membership is derived from the pnpm workspace globs: a new app inherits
its rank, and a new package that states none is itself a finding.
