---
"@reddb-io/redskilled": patch
---

Refuse an item-scoped birth the daemon cannot brief, and make the count-only poll route say so.

A planned birth whose Ticket handoff cannot be composed is now refused before any Worker is spawned, naming the missing fact — a count-only poll, no Ticket listed for the item, an unusable number, an empty title, or a registration with no trunk branch. The refusal rides the demand loop's existing path, so it is journal-visible and rate-limited by the host backoff instead of costing a worktree clone and a host slot every tick. A registration carrying a prompt and no work item still births prompt-only.

The aliased GraphQL discovery route now states `briefing: "count-only"` beside its depth (the REST list route states `"listed"`), so nothing downstream has to read an absent `tickets` field as a drained queue.
