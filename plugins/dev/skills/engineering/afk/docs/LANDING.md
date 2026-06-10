# Lock-Toggled Landing (ADR 0030)

Landing is lock-toggled by the branch-lock state:

- **Locked** (`{pinned}` *is* the locked branch) — `git merge --no-ff afk/{id}/{N}-{slug}` directly into the local locked branch, then `git push origin {pinned}`. Nothing reaches `main` — promoting the locked branch is the operator's call.
- **Unlocked** — land via an **admin-merged PR**: force-push the attempt branch's final state, open/reuse a PR `--base {pinned} --head afk/{id}/{N}-{slug}`, then `gh pr merge --admin --merge`. The PR is the durable per-attempt history.

Either way, conflict → one-shot self-resolve; still-conflicting → abort → bounded `merge-conflict` recovery. Push rejected → roll back → bounded `merge-conflict` recovery.
