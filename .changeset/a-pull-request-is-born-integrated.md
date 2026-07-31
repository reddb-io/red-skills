---
"@reddb-io/red-skills": patch
---

**A pull request a Worker opens is now born integrated with its base** (#2936). The terminal sequence was `pushAttempt` → `openReviewPr` with nothing between them: no fetch, no merge of `origin/<base>`, no conflict check. The PR was therefore born on whatever base the Worker saw at boot, and a base that moved during the run first surfaced much later, at landing time, through `preMergeRebase` — by which point the Worker is dead and a human inherits a `dirty` PR nobody warned them about.

The new barrier runs immediately after the branch is pushed and before the PR is opened, in an isolated worktree provisioned from the freshly-fetched `origin/<branch>` — never the primary checkout. It fetches the base, short-circuits when the base is already an ancestor of the tip, merges it otherwise, and publishes the integrated tip so GitHub opens the PR on the integrated branch. **Only a real conflict spends `blocked:merge-conflict`**, and it carries the conflicting paths, reported while a retry can still resolve them; a failed fetch or a rejected push is infrastructure on a branch that never conflicted, so it is logged and the PR opens anyway.

This is an EARLIER barrier, not a replacement: the landing keeps `preMergeRebase`, because the base can move again between the PR opening and the merge.

**The worktree convention now teaches both halves.** It documented only how to create a NEW branch, so anyone resuming an EXISTING one wrote the bare `git worktree add <dir> <branch>` — which resolves the LOCAL ref. A local ref that trails `origin/<branch>` produces work built on a stale tip and a push rejected as `non-fast-forward`. The existing-branch form (`git fetch origin <branch> && git worktree add <dir> -B <branch> origin/<branch>`) now sits alongside it with that reason inline.
