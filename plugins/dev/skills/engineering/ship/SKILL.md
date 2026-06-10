---
name: ship
description: Interactive, review-respecting finalizer for already-committed work in an exempt `.red/tmp/work-ship-*/` worktree. Use when the user wants to open or reuse a PR, monitor CI and reviews with a time cap, then either approve/merge or park the linked issue for `/hitl`.
argument-hint: "[--issue N] [--base BRANCH] [--timeout-s SECONDS] [--poll-s SECONDS] [--review-check NAME] [--no-review-wait]"
---

# /ship

Finalize committed work from a prepared ship worktree. This skill is the
interactive sibling of `/afk`'s autonomous admin-merge landing: it respects
branch protection, review decisions, CI, and the monitor time cap.

## Preconditions

- Run from a committed worktree under `.red/tmp/work-ship-*/` (nested subdirs are fine).
- The current branch is the work branch to ship.
- `gh auth status` works and the repo has the `ready-for-human` label.
- Worktree creation is a separate front step; `/ship` does not create worktrees.

## Run

Invoke the dev runtime command:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" ship [--issue N] [--base main] [--timeout-s 1800] [--poll-s 30] [--review-check CodeRabbit] [--no-review-wait]
```

Use `--issue N` when the issue number is not inferable from the branch name.

`/ship` waits for an in-flight advisory bot review (the same reviewer the AFK
landing path honors, `afk.merge.review_check`, default `CodeRabbit`) to conclude
before merging. Override the reviewer name with `--review-check NAME`, or skip
the wait with `--no-review-wait`. The wait is advisory and fail-open: a reviewer
that never registers cannot wedge the finalizer.

## Behaviour

1. Refuse non-ship worktrees and uncommitted changes.
2. Push the branch to `origin` immediately.
3. Reuse an open PR for the branch/base pair, or create one linked to the issue.
4. Poll checks and reviews on a bounded `/loop` until a merge decision or the time cap. Keep waiting while CI is still running **or** the advisory bot review is registered but in flight.
5. Feed the pure merge gate:
   - green checks + satisfied branch protection + no requested changes -> `merge`
   - required approval missing -> `hitl`
   - any human or bot `CHANGES_REQUESTED` review -> `hitl`
   - time cap exceeded -> `hitl`
6. On `merge`, approve the PR and merge it normally.
7. On `hitl`, comment on the linked issue, add `ready-for-human`, mirror the label on the PR, and stop for `/hitl`.

Do not use `--admin`; `/ship` is explicitly review-respecting. If approval or
merge fails, treat that as HITL and let the runtime park the issue.
