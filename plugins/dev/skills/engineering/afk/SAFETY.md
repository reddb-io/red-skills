# /afk Safety Rules

Binding for both the orchestrator (the shell loop) and the inner agent (claude/codex). Violating any of these aborts the loop with a blocker comment on the active issue.

## Repository Layout Invariants

- The **primary checkout** stays on `main` at all times. Never `git checkout`, `git switch`, or `git branch -m` inside it.
- All work happens in **worktrees** under `.red/tmp/work-{id}-i{N}/worktree/` (inside the primary checkout but gitignored) on a branch named `afk/{id}/{N}-{slug}`.
- The worktree branch is **local-only** until the final push of `main`. The orchestrator pushes `main`, not the worktree branch.

## Git Operations

**Allowed in primary checkout:**
- `git fetch`, `git pull --ff-only`, `git merge --no-ff <local-branch>`, `git push` (SSH only).
- `git add`, `git commit` (for the pre-merge snapshot when primary is dirty).
- `git worktree add|remove|list`.
- Read-only: `git status`, `git log`, `git diff`, `git show`, `git branch`.

**Allowed in worktree:**
- `git add`, `git commit`, `git mv`, `git status`, `git diff`, `git log`, `git show`.

**Forbidden everywhere, no exceptions:**
- `git reset` (any flavour)
- `git rebase` (any flavour)
- `git clean` (any flavour)
- `git restore`, `git checkout -- <path>`, `git checkout .`
- `git stash` — push, pop, drop, all banned
- `git branch -D`, `git branch -d -f`
- `git push --force`, `--force-with-lease`, `--mirror`
- Any command with `--force`, `--hard`, `--no-verify`
- Switching branches inside any checkout
- Rewriting history of any branch, ever

**SSH-only remotes:**
- Refuse to start if `git remote -v` shows any `https://` URL.
- Never auto-rewrite remotes. The user fixes them manually.

## Dirty Primary Checkout

If `git -C primary status --porcelain` is non-empty before a merge:

1. `git -C primary add -A`
2. `git -C primary commit -m "chore(afk): pre-merge snapshot for #{N}"`
3. Proceed with merge.

Never `git stash`, `git restore`, or discard the dirty state.

## Merge Conflicts

One self-resolve attempt: re-enter the inner agent with the conflict diff in the handoff file Notes. If the inner can't resolve cleanly:

1. `git -C primary merge --abort`.
2. Comment the conflict diff on the issue.
3. Re-label `ready-for-human`, remove `running`.
4. Move to the next issue. **Do not** `git reset` or `git restore` to "clean up" — the merge abort is sufficient.

## Worktree Lifecycle

- Created from `origin/main` after `git fetch`.
- Branch name: `afk/{N}-{slug}`. Slug is the issue title lowercased, non-alphanumerics → `-`, truncated to 40 chars.
- Removed only after successful merge **and** push. Never remove a worktree with uncommitted changes — that loses work.
- If cleanup fails (e.g. worktree busy), leave it in place and print the path for manual recovery.

## `.red/` Discipline

- `.red/tmp/` is gitignored. The orchestrator guarantees this in the worktree before writing handoff files.
- `.red/wiki/` is gitignored if the project uses the LLM-wiki pattern. The inner agent must never `git add` it.
- `.red/agents/`, `.red/CONTEXT.md`, and other tracked `.red/` content are normal source. Treat them like any other file.

## Heartbeat and State Files

- The periodic issue-thread heartbeat (`:one:` … `:four:` via `gh issue comment`) was retired in Slice D — there is no sub-shell to track or kill. `heartbeat_pid` in older state files is vestigial and ignored.
- State file writes are atomic: write to `.red/tmp/work-{id}-i{N}/afk.state.json.tmp`, `mv` over the real path. Never partial writes.
- The monitor never writes. Only the orchestrator writes state.

## Signals and Shutdown

- `SIGINT` (Ctrl-C): finish the current `pnpm`/git command if mid-flight, write a "interrupted" comment on the active issue, leave the worktree in place, exit 130.
- `SIGTERM`: same as `SIGINT`.
- Never trap `SIGKILL` — let the OS do its thing.

There is no heartbeat sub-shell to reap on any of these paths since Slice D — the only cleanup work is releasing the in-flight claim and preserving the iteration directory.

## What "Blocker" Means

A blocker is recorded by:
1. Appending Notes to the handoff file (the inner does this).
2. Posting the Notes as a comment on the GitHub issue (the orchestrator does this).
3. Removing `running`, adding `ready-for-human`.
4. Worktree is preserved at the moment of blocker — the human investigates in place.

The loop continues with the next issue. Blockers are not fatal to the loop.

## What Aborts The Whole Loop

Only these:
- Hard preconditions failed at startup (HTTPS remote, no `gh` auth, no `main`).
- Both runners exhausted on the same issue.
- Uncaught error in the orchestrator shell (not from inner — those become blockers).

On abort: write final state, print recovery instructions. Worktrees in progress are left alone. (No heartbeat sub-shell to kill since Slice D.)
