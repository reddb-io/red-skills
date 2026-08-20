---
"@reddb-io/redskilled": patch
---

The Worker fork refreshes the Project mirror's trunk from the canonical
remote before cloning. The mirror was cloned once and never fetched again —
its own origin is the human checkout — so every Worker forked a days-old
tree, the agent's `git fetch origin` fetched the past, and the gate judged
code main no longer had (three Tickets parked on a failure that was already
fixed). A failed fetch degrades to a stale fork instead of refusing the
birth.
