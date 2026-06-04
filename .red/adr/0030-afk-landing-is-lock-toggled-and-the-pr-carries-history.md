# AFK landing is lock-toggled, and the PR carries the history

## Status

accepted.

Design-stage decision from a `/start` grilling on the worker-directory
restructure (motivated by #243).

Implemented by PRD #244 (issues #253–#258), shipped in the native TS runtime
(the `afk.sh` line references below are historical; the bash is gone, commit
3d92d56). Before this, `/afk` merged a successful iteration
directly into the target via `do_merge`, opened no PR, and `rm -rf`'d the entire
iteration directory on success — so successful runs left **zero** local trail,
while failures were preserved whole (fat worktree included). We wanted to
maximise observability and learn across attempts without unbounded disk growth.

## Decision

1. **Landing toggles on the Branch lock** (see ADR 0031). *Unlocked* (base =
   `main`, no human working branch): each completed issue opens a per-issue PR
   into `main` and is **admin-merged** — a single `gh` identity cannot approve
   its own PR, so the approval collapses into the merge — and the PR is the
   durable history. *Locked*: `/afk` `do_merge`s the winning attempt straight
   into the user's local working branch for immediate local review, and the one
   user-controlled PR is the **promotion** of that branch into `main`, which
   naturally bundles every merged issue.

2. **The PR is the durable history.** A merged or closed PR retains its
   description, comments, commit list, and diff permanently — even after the
   head branch is deleted (commits stay reachable via the merge commit and
   `refs/pull/N/head`). This is what lets us delete attempt branches and
   worktrees on completion without losing the forensic trail.

3. **Teardown is split.** On close — success *and* fail — the heavy `worktree/`
   is always dropped; the cheap artifacts (`agent.log.jsonl`, `log.jsonl`,
   `handoff.md`) are kept. They are pruned **on issue completion** by sweeping
   `workers/*/{issue}-a*` across all workers; issues that never complete fall
   back to an age/count cap. Materialised `afk-attempts/*` remote branches
   survive on a grace TTL so a reopened "solved" issue can still recover prior
   attempts.

## Why

- **The lock expresses intent about who reviews.** When the user is locked to a
  local branch they want to see work land there and promote it themselves; when
  unlocked, `/afk` is autonomous and the PR into `main` is the natural landing
  and the only place per-issue history can live.
- **A PR is a permanent, consolidated record.** It survives branch and worktree
  deletion, so it removes the only reason to keep heavy attempt artifacts on
  disk or orphan branches on the remote forever.
- **The worktree is the expensive part, and it is never needed after close.**
  Restart-informed retries fetch the prior attempt from the remote
  `afk-attempts/*` branch plus the local JSONL logs — not from a retained
  worktree — so dropping the worktree on every close bounds disk by
  construction.

## Rejected alternatives

- **Direct-merge to `main` everywhere (status quo).** No per-issue history
  survives a success, and it ignores the user's local-branch workflow. Rejected.
- **Per-issue PR everywhere, including when locked.** A locked user reviews
  locally and promotes themselves; forcing a per-issue PR into their local
  branch needs it pushed and adds ceremony they do not want. Rejected.
- **Retain attempt worktrees for forensics.** Each worktree is a full checkout;
  N workers x K attempts is unbounded. The remote `afk-attempts/*` branch plus
  the local JSONL logs already preserve everything cheaply. Rejected.
- **Delete remote attempt branches immediately on completion.** A "solved" issue
  that reopens would then have no recoverable prior attempts. Rejected in favour
  of a grace TTL.

## Consequences

- Worker liveness can no longer be inferred from directory existence — a
  retained corpse looks like a live worker, so consumers must key liveness off
  the pid file or a state field.
- "Attempt" becomes a first-class on-disk citizen (`{issue}-a{n}/`), distinct
  from the issue-scoped **Envelope** history on GitHub (ADR 0017).
- Glossary debt for the implementing PR: the **Worktree** path
  (`contexts/dev/CONTEXT.md:54`) and a new **Attempt** term.
- The unlocked path requires admin-merge rights, or branch protection that does
  not require approvals.
