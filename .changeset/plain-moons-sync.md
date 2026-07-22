---
"@reddb-io/dev": minor
---

Attempts now keep their base fresh instead of letting drift accumulate until
landing pays for it. A notes-loop attempt merges `origin/<trunk>` into its
working branch at every iteration boundary (`afk.notes_loop.trunk_sync`, on by
default): uncommitted work is never merged over, and a conflicting merge is
aborted and handed to the inner agent as its first instruction in the next
iteration. Landing gained the companion refusal — measured after the squash, a
branch more than 40 commits ahead of a base more than 12h stale parks with the
guard's own actionable reason instead of grinding a rebase that cannot
converge. (#2481)
