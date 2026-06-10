# /afk merges into the pinned branch, not always main

## Status

Accepted. **Superseded by ADR 0030** — the `do_merge` implementation was replaced by lock-toggled landing. The pinned-branch resolution still applies (target branch precedence, ADR 0030/0031). For current merge-and-land implementation, see **ADR 0030**.

`/afk` historically based every worktree on `origin/main` and merged every
finished issue back into `main`. PRD #59 (issue #64) introduces the **pinned
branch**: a PRD or issue may declare a `branch:` line, and `/afk` must honour
it — basing the worktree on that branch and merging the result back into it.

## Decision

When a work item resolves to a pinned branch (its own `branch:` line, else its
parent PRD's, else `main`), `/afk`:

1. **bases the worktree** on `origin/<pinned>` instead of `origin/main`; and
2. **merges and pushes** the finished iteration into `<pinned>` instead of
   `main`.

No pin anywhere resolves to `main`, so the default behaviour is byte-for-byte
unchanged. The resolution is a pure text function (`lib/pin-reader.sh`); the one
side effect — fetching the parent PRD body to read its pin — lives in `afk.sh`.

The primary checkout is still pinned to `main` by the startup precheck. For a
non-`main` target, `do_merge` switches the primary checkout onto the pinned
branch for the merge/push, then **restores it to `main`** on every exit path
(success, conflict-abort, push-reject, hook-abort), so the precheck invariant
holds for the next iteration.

## Why

- **The pin is a property of the work, not the loop.** A PRD that targets a
  long-lived feature branch wants all its slices to land there, not on `main`.
  Reading the pin from the body keeps the declaration next to the work.
- **Inheritance keeps issues terse.** An issue need not repeat its PRD's pin;
  declaring it once on the PRD is enough, and an issue can still override.
- **Default-main keeps the blast radius zero.** Every existing PRD/issue with no
  `branch:` line behaves exactly as before, so the change is opt-in.
- **Restoring to main keeps the merge model simple.** Rather than introduce a
  second worktree for the target branch, we reuse the proven primary-checkout
  merge path and just move the checkout onto the target for the duration of the
  merge, restoring it afterwards. The `merge_integrate_origin` / `merge_rollback`
  primitives already take the branch as a parameter, so they needed no change.

## Rejected alternatives

- **Always merge into main, then a human moves it.** Defeats the purpose of the
  pin and reintroduces the manual step the pin exists to remove. Rejected.
- **A dedicated worktree for the target branch during merge.** Cleaner isolation
  but doubles the worktree machinery and the cleanup surface for marginal gain
  over a switch-and-restore on the primary checkout. Rejected.
- **Reading the pin from a label or a separate config file.** A `branch:` line in
  the body keeps the declaration human-editable in the same place the work is
  described, and survives `/triage` rewrites. Rejected the out-of-band stores.

## Consequences

- A work item pinned to a branch that does not exist on the remote fails loudly
  at `git worktree add` / `git fetch` — a misconfigured pin surfaces immediately
  rather than silently landing on `main`.
- Worktrees stay **exempt** from any active branch lock by toplevel location
  (see ADR 0006), independent of which branch they are based on.
- The pinned-branch resolution is unit-tested in isolation
  (`scripts/tests/pin-reader.test.sh`): parse, PRD→issue inheritance, default
  main.
