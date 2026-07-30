---
"@reddb-io/red-skills": patch
---

A dispatched Worker decides its issue's branch on what the branch holds, not on what it is called (#2865). Branch-resume already discovered `afk/<issue>-*` by name and skipped `prepareFreshWorkerBranch` when it matched — but the name is not evidence. Worktree creation pushes the deterministic ref before the agent writes a line, so a dead Worker's nine committed slices and an empty placeholder read identically, and the branch a Worker declines to adopt is the branch `prepareFreshWorkerBranch` deletes from origin. The lifecycle now asks git how many commits the candidate carries ahead of the base before it decides: a proven-empty ref is prepared fresh, and a ref carrying work is continued.

**An unread branch is adopted, never assumed empty.** `branchCommitsAhead` returns `undefined` — not zero — when it cannot resolve the tip or the base, and a throwing probe degrades the same way, because a count the engine merely failed to read must not look like a branch with nothing to lose. The one path that still discards work is the one a human asked for: an explicit restart directive in the thread.

**Committed work that reached origin is no longer invisible.** Two facts the engine used to keep to itself are now recorded on the issue: the reason a refusal refused, and the existence of a branch that carries commits no pull request mentions — the exact shape in which #2851's finished 1553-line slice sat on origin while the issue read as in-progress. The attempt-PR census already names an adopted branch that has a PR, so that case stays silent rather than doubling the comment.
