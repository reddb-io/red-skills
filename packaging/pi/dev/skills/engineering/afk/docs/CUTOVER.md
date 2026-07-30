# The daemon cutover — what happens to state that already exists

ADR 0130 moves the birth of a Worker from the per-project supervisor to the
host-scoped `redskilled` daemon. A machine that has been working carries live
state across that boundary: a running supervisor, Workers in flight, claim
comments on the tracker, git worktrees, and durable lanes under
`.red/state/castle/`. This document is the defined answer for each — the
migration is a known move, not an undefined one.

The mechanism is the ADR 0105 boot migration, not a second one: plan purely,
execute best-effort at boot, never overwrite, and be a no-op the second time.
The plan lives in `apps/dev/src/core/castle-cutover-migration.ts`, the executor
in `apps/dev/src/runtime/castle-cutover-migration.ts`.

## When it runs

**At a supervisor launch, once, and only while the daemon owns birth.** A
supervisor launch is the era boundary, so `spawnSupervisor` is the single call
site. A Worker's own boot never runs it — a Worker must never quiesce its peers.

The gate is explicit, never inferred: the caller that births Workers through the
daemon passes `cutoverActive: true`, and an operator can declare it with
`RED_CASTLE_CUTOVER=1`. Inferring it from a reachable socket would quiesce a
healthy classic fleet the first time the daemon happened to be running for some
other project — a machine-wide stop event triggered by a coincidence.

## Workers in flight at cutover time — quiesced, not adopted

**A Worker born by the classic path is stopped, and its Ticket goes back to the
queue.** The daemon re-attaches to a Worker by unit name, and a Worker born
before the cutover has no unit to be named by. Placement is decided at birth
(ADR 0130 rule 4) because moving a live process between resource units does not
move the memory it already charged — so a pre-cutover Worker cannot be moved
into the host budget after the fact. Adopting it would mean the daemon holding a
budget it cannot enforce, which is the unbudgeted spawn ADR 0130 exists to end.

**Quiescing costs supervision, never work.** The stopped Worker's branch,
workspace and claim are left exactly where they are. Git owns the commits and
the tracker owns the claim, so recovery is the existing crash reconcile path —
the one that already returns a dead Worker's Ticket to the queue. A stopped
Worker is indistinguishable from a crashed one to that path, which is why no new
recovery mechanism appears here.

The classic supervisor is stopped **first**, so it cannot answer a Worker's death
by spawning a replacement through the very path the cutover is removing.

## Durable lanes — unchanged, on purpose

`.red/state/castle/` does not move. The daemon keeps no per-Worker durable record
(ADR 0130 rule 8): the tracker owns issue-to-PR, git owns branch-to-commits, and
the daemon owns worker-to-process, so there is no third copy to relocate. The
lane relocations that ADR 0105 defined still run at every boot
(`core/red-path-migration.ts`); the cutover adds none.

## Stale artifacts — only what nothing owns is reclaimed

A git worktree registration whose workspace no longer exists is a dangling
pointer with no owner, so it is pruned (`git worktree prune`).

A branch is never deleted and a workspace holding a real worktree is never
removed. Both are recoverable work, and reclaiming disk is not worth discarding a
Worker's output. Worktree and workspace hygiene stays with the janitor and the
reaper, which already own it.

## The report

The migration stamps `.red/state/castle/cutover.toon` (contract
`red.castle.cutover.v1`) with:

| Field | Contents |
|---|---|
| `at` | When the migration ran, ISO-8601. |
| `moved.stopped` | Classic supervisors stopped. |
| `moved.quiesced` | Workers stopped, each named `w<id> (#<ticket>)`. |
| `moved.pruned` | Worktree registrations pruned. |
| `moved.failed` | Actions the host refused — named, never silently dropped, because the operator's next move depends on knowing which Worker survived. |
| `kept` | Every artifact left in place, each with the reason it was left. |
| `reasons` | Every action taken, with the rule that decided it. |

A one-line summary also reaches the launch's notice channel:
`castle cutover: 1 supervisor stopped, 2 worker(s) quiesced, 3 worktree
registration(s) pruned, 7 artifact(s) left in place`.

## Idempotence

**The stamp is the gate.** A second launch finds `cutover.toon` present, returns
`already-migrated`, and touches nothing — no probe, no stop, no prune, and no
rewrite of the stamp. That is also what protects a Worker born *after* the
cutover from ever being mistaken for one born before it.

A migration whose report could not be written is left to the next boot. That is
the safe direction: quiescing twice costs nothing, whereas skipping the migration
would leave unbudgeted Workers alive.

## Rollback

If the cutover misbehaves, this returns the machine to a working state:

1. **Stop the daemon.** `systemctl --user stop redskilled` when the user unit is
   installed; otherwise kill the daemon process. With no daemon, no Worker is
   born — the cutover fails closed by design (ADR 0130 rule 6), so nothing is
   spawning behind you while you roll back.
2. **Stop whatever is still running in the project.** `/afk fleet stop`, then
   confirm no supervisor or Worker process survives.
3. **Roll the bundle back to the pre-cutover version.** Point the stable
   self-update pointer at the last known-good version
   (`<cache>/dev-stable.self-update.json`) and materialise that version's bundle.
   The classic supervisor path returns with it.
4. **Delete `.red/state/castle/cutover.toon`.** It is the run-once gate: leaving
   it in place would make a later re-cutover skip the migration and leave the
   Workers that the rolled-back era births unquiesced. Keep a copy if you want
   the record of what the first attempt moved.
5. **Re-queue what was quiesced.** The Tickets named in `moved.quiesced` return
   to the queue through the ordinary crash reconcile path; their branches are
   still on the remote, so a re-dispatch adopts the work rather than restarting
   it.

Nothing here is "reinstall". The migration deletes no branch, no commit and no
workspace, so every rollback step is reversible and no work is lost by taking it.
