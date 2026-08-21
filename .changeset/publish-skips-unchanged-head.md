---
"@reddb-io/worker": patch
---

A Ticket turn that commits nothing publishes nothing: the publisher captures
the Worktree's HEAD before the implementer runs and skips publication when
HEAD is unchanged, so the turn answers nothing-to-publish instead of pushing
main's own tip and dying on GitHub's "No commits between" at the land.
