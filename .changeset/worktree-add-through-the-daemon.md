---
"@reddb-io/protocol-acp": minor
"@reddb-io/redskilled": minor
---

`_redskills/worktree_add` creates the human's interactive worktree, and
`_redskills/worktree_list` becomes the one inventory that shows it (ADR 0150
§4). The daemon fetches the Project's registered trunk and forks the worktree
from that REMOTE ref into the client checkout's manual lane, closing the way a
hand-typed `git worktree add <dir> <branch>` resolves the LOCAL ref and builds
on a stale tip.

The inventory answers from both authorities at once: git's own list for the
worktrees that hang off the registered checkout — each judged `checkout`,
`interactive`, `worker` or `unregistered` — and the daemon's host state for the
Workers, whose worktrees live in its own storage and are invisible to the
checkout. A checkout the daemon holds no registration for is refused with a
typed `checkout-not-registered` reason rather than a sentence, because a client
that must regex a message is a client that cannot branch on the answer.
