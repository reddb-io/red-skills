---
"@reddb-io/shared": patch
"@reddb-io/protocol-acp": patch
"@reddb-io/worker": patch
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---

Standing orders survive the respawn, and the injection guard stops contradicting them.

Every Worker brief is rebuilt from the tracker, so a directive the maintainer gave
once — "never hand-edit the generated manifests", "land through the daemon" — was
gone by the next process unless a human said it again. A durable
`.red/STANDING-ORDERS.md` in the project's own tree is now read at every handoff
composition and emitted verbatim as the handoff's own `<standing-orders>` section,
switched off by `plugins.dev.afk.standing_orders.enabled: false` and absent
entirely when the file is.

The exit protocol's authority sentence is amended to NAME that section whenever it
is present. It has to be: the sentence granted authority to exactly two sources,
and a handoff carrying a third taught the agent that its own standing orders were
the kind of text the injection guard tells it to ignore. It is a swap rather than
an append, so a repository that never wrote the file gets the same protocol, byte
for byte — both states are pinned as snapshots.

The native Ticket handoff gains an optional `standing_orders` field, refined like
its peers (a malformed value is dropped, never the Ticket). The daemon's
drain-scoped register travels in it rather than spliced onto the front of
`handoff`, where the brief contract linted the orders as if they were acceptance
criteria and the first re-seed — which replaces the brief rather than appending to
it — dropped them. The Worker's Ticket loop prepends the section to every round:
the first brief, a failure retry, and a gate re-seed alike.

The orders are never sourced from the Issue body. That is external GitHub content
the guard tells the agent not to obey, and standing orders are the one thing in the
handoff that carries authority.

Mechanism imported from the pstack study (Spec #4129, ADR 0154/0156); implementation
original to reddb.io.
