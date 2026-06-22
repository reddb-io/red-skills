# AFK landing is lock-toggled, and the PR carries the history

## Status

accepted; **amended by #842** (see *Amendment 1* below) — landing is no longer
lock-toggled, it is flag-toggled, with the lock only resolving the target base.

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

## Amendment 1 — landing mode is decoupled from the lock (#842)

Decision 1 above coupled **two orthogonal concerns** into the single branch-lock
toggle: the *target branch* (which ADR 0031 resolves: lock > pin > main) and the
*landing mode* (PR vs direct merge). The coupling left two postures unreachable:
an operator who locks to `main` for an offline/direct flow got **no PRs at all**,
and an operator who wanted PRs could not also pin a non-`main` target.

They are now **decoupled** by a config flag,
`plugins.dev.afk.worktree_launches_pull_request` (boolean, **default `true`**;
honours the legacy bare `afk.worktree_launches_pull_request` fallback, ADR 0042):

- The **lock only resolves the target base** (ADR 0031, unchanged).
- The **flag** chooses the landing mode, independently of the lock:

  | branch-lock | flag | landing |
  |---|---|---|
  | none | `true` (default) | admin-merged PR → `main` (the old *unlocked*) |
  | none | `false` | direct merge → `main` (offline, newly reachable) |
  | set `X` | `true` (default) | admin-merged PR → `X` (newly reachable) |
  | set `X` | `false` | direct merge → `X` (the old *locked*) |

**Merge-mode stays orthogonal.** *How* a PR merges (admin-merge by default, or
held per `afk.merge.wait_for_review` / `afk.review_gate`) is unchanged and still
governed by `afk.merge.*`; this flag only decides whether a PR is opened at all.
The branch-lock skill's interactive primary-branch guard is untouched — the flag
affects only AFK landing.

**Migration.** The default `true` flips the previous **locked** behaviour: a repo
locked to a feature branch used to get a *direct merge for human promotion*; with
the new default it gets an *admin-merged PR to the lock branch* instead.
Operators who want the old offline/direct-promotion flow set
`worktree_launches_pull_request: false`.

Implementation: the lock-toggle in `core/landing.ts` (`doLanding`) became the
`openPr` flag; `core/process-issue.ts` (and the `core/reconcile.ts` re-land path)
resolve it from config and the PR review gate now keys on it rather than on the
lock. The direct-merge path still runs inside an isolated worktree so the primary
checkout stays sacred (#572).
