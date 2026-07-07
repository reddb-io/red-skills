# AFK single-source invariants — Trunk, untouchable primary, liveness lane, exit barrier

## Status

Accepted (planning). Decided in a `/start` grilling session on 2026-07-02, ahead
of the reliability program that queues behind PRD #907/#928. Defines the target
model; implementation slices will reference this ADR.

## Context

A recurring bug class in AFK is "the fix only guards one path": critical
invariants — *which branch is the base and landing target*, *is this worker
alive*, *is this work safe* — are each re-derived at multiple call-sites
(claim, run, land, reconcile, teardown, monitor, reaper). Every incident in the
taxonomy traces back to one of them:

- **Base/target drift** — workers forked from the *local* `main`, which drifts
  behind `origin/main` and can carry foreign WIP; a stale local main silently
  failed every slice, and the pre-merge snapshot once auto-committed the
  maintainer's uncommitted WIP into local main (PR #982 closed four such gaps,
  one call-site at a time).
- **Liveness lies** — the stall reaper keys off the firehose mtime, which the
  heartbeat itself refreshes (a stalled worker looks alive forever), and the
  process-tree check is container-blind under docker/podman isolation
  (ADR 0054).
- **Lost work** — terminal paths that exited without committing/pushing
  stranded 55+ minutes of agent work (codex DONE-without-commit, worktree
  deleted mid-run, teardown races).

Enumerating call-sites does not scale; each new terminal path or consumer
reintroduces the bug. The maintainer additionally requires two guarantees as
first-class, user-visible contracts: **agents never mutate the maintainer's
local branches**, and **the branch all agent work enters from and exits to is
explicitly configurable** (default `main`).

## Decision

Four invariants get exactly one owner module each. Consumers call the module;
no call-site re-derives the answer.

### 1. Trunk (owner: `apps/dev` core)

The **Trunk** is the repo's configured focal branch: the single point where
agent work *enters* (worktree base) and *exits* (landing target).

- Config: `plugins.dev.trunk` in `.red/config.yaml`, default `main`. Any
  branch may be the trunk (e.g. `develop`, `workspace/<user>`).
- The trunk is always read as its **fresh-fetched remote ref**
  (`origin/<trunk>`); the local working-tree branch of the same name is never
  read as truth.
- Worktrees, gates, and rebases base on `origin/<trunk>`. Landing targets the
  trunk.
- Landing precondition: the local trunk ref must be an ancestor of
  `origin/<trunk>`. If it diverged, landing **fails loud** (issue parked as
  blocked) — it never resets, stashes, or auto-commits to repair the
  divergence.
- Override precedence stays: Branch lock > Pinned branch > Trunk (ADR
  0030/0031 semantics unchanged; only the hardcoded `main` fallback is
  replaced by the trunk).

### 2. Untouchable primary (owner: `apps/dev` core)

The **primary checkout is read-only for agents**. No AFK or interactive-agent
code path may switch its branch, commit into it, merge into its local refs, or
snapshot its uncommitted WIP. Agent work flows exclusively
`origin/<trunk>` → isolated worktree → push → `origin/<trunk>`; integration
with the maintainer's local state happens only when the maintainer pulls. Any
operation that would need to write to the primary is a hard failure, not a
fallback.

This has **no exceptions**, including the branch-lock landing: `landMerge`'s
local merge into the locked branch (ADR 0030/0031) is replaced by a push to
`origin/<locked-branch>`; the maintainer promotes by pulling. The lock keeps
its base/target semantics — only the write moves from the primary checkout to
the remote.

#### Amendment (2026-07-07): the guarded post-merge fast-forward

The original "no primary write" rule left a repo running
`lock.primary-branch: true` with a local base that **derives behind origin every
session** — the maintainer was expected to "promote by pulling", and in practice
never did (observed 415 commits behind, most of it fleet-landed work). Because
AFK worker worktrees fork from the primary's **local** `<base>`, the next slice
then branches from a stale base and silently fails validation on fixes that only
landed on origin.

So §2 is relaxed for exactly one operation: after a **successful** landing, the
finalizer advances the primary's local `<base>` to the merged origin tip via
`fastForwardLocalTarget` (`apps/dev/src/core/merge.ts`), for **both** lock
states. The §2 **safety intent** — never eat primary WIP (the #1019 failure) — is
preserved by making that promotion a guaranteed no-op on any primary it must not
touch: it runs only when the primary is **on** `<base>`, its working tree is
**clean**, and the local `<base>` is a **strict ancestor** of the remote tip; it
uses `merge --ff-only` only — never `reset`, `rebase`, or a `--no-ff` merge
commit. A destructive write to the primary remains a hard failure. Net: the
letter ("no primary write") is narrowed, the intent ("no landing destroys the
operator's WIP") is unchanged.

### 3. Liveness lane (owner: red-castle)

Red-castle exposes the canonical "is this attempt alive" signal:

- A **dedicated liveness stream** written only by the substrate itself — never
  inflated by agent output or heartbeat records relayed from the agent — so
  activity mtime cannot be poisoned by the thing being measured.
- A **process-tree cross-check** as second opinion, armed only where the
  process tree is visible (disarmed under container isolation, same switch
  pattern as `resolveAttemptGuardArming`, ADR 0054).
- All consumers in `apps/dev` (stall reaper, monitor, statusline, dashboard,
  task mirror) read one evaluator; none re-derives liveness from the firehose.

### 4. Exit barrier (owner: `apps/dev` core)

**Work is saved iff its branch ref is pushed to `origin`.** Every terminal
path of an attempt — DONE, guard abort, stall-kill, crash teardown, reconcile —
passes through a single exit barrier that salvage-commits uncommitted work and
pushes the branch before the attempt is allowed to end. A terminal path that
bypasses the barrier is a bug by definition.

### Ownership split

Liveness lives in red-castle because the substrate owns the process and the
event stream; trunk, primary protection, and the exit barrier live in
`apps/dev` because claim/land/reconcile/teardown are orchestration concerns.
This accepts the two-repo submodule flow for liveness slices only.

## Consequences

- Closes the "fix only guards one path" class structurally: new terminal paths
  and new consumers inherit the invariants instead of re-implementing them.
- `plugins.dev.trunk` becomes user-facing config surface; docs, doctor, and
  `/setup-red-skills` must teach it.
- Pushing every attempt branch (including failed ones) adds remote branch
  noise; acceptable trade against lost work, and prunable.
- Liveness changes ride the two-repo red-castle flow (slower slices, submodule
  init footgun applies — post-checkout hook required in worker worktrees).
- The landing precondition converts silent WIP-eating into loud parks; a
  diverged local trunk now requires an explicit human decision.
- Existing ADR 0030/0031 landing semantics are refined, not replaced; the
  `main`-hardcoded assumptions across `apps/dev` are migrated to trunk reads.
