---
"@reddb-io/redskilled": patch
"@reddb-io/red-skills": patch
"@reddb-io/protocol-acp": patch
---

The Worker's local gate runs the repo's DECLARED validation commands. The
drain registration composes them from `plugins.dev.afk.validation`
(`post_done` then `landing`), the daemon carries them opaquely onto every
Ticket, and the Worker runs exactly those instead of improvising a full
workspace suite — which contradicted the "sole local validation authority"
contract and flaked under the Worker memory ceiling, a different package red
each round, none of them the branch's fault. A repo that declared nothing
keeps the improvised cone.
