# AFK boot-time sweeps (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> How the bundle reclaims stale tmp-lane state at boot. Durable AFK process state
> lives in the state tier under `.red/state/castle/`; the agent never runs these by
> hand because they are the bundle's startup hygiene. Referenced from *Bootstrap*
> and the *Per-Issue Loop* close step.

The lane janitor only acts on registered disposable lanes under `.red/tmp/`.
Tmp lane cleanup never deletes `.red/state/`, plugin stores, tracked config, or
`.red/researches/`.

## Orphan Cleanup (boot-time)

Right after bootstrap and before *Straggler Check*, `/afk` runs two passes. First it reconciles leftover **legacy flat** `.red/tmp/work-*` dirs from the pre-nested scheme (the drain-first cutover, issue #252). This sweep is pid-guarded and slug-sparing: slug-named manual worktrees are left alone, and numeric legacy work dirs are removed only when their recorded or inferable process is no longer live. Then it sweeps the nested worker dirs in every worker namespace (`.red/tmp/workers/*/*/`, `.red/tmp/go-workers/*/*/`, and `.red/tmp/scout-workers/*/*/`) whose parent worker's `worker.pid` is dead, and afterwards removes dead empty worker shells across those namespaces: dead/corrupt/missing `worker.pid` files plus the worker dir when it contains no worker dirs or only empty worker dirs. Live `worker.pid` dirs and non-empty preserved worker dirs are left untouched. For each orphaned worker dir:

1. **(Slice D — heartbeat sub-shell retired.)** No zombie reap step is needed; older state files may still carry a `heartbeat_pid` but it's vestigial and ignored.
2. **Decide fate from issue state.** `gh issue view N --json labels,state`:
   - `state == CLOSED` → `rm -rf`. Work landed; nothing to inspect.
   - label `ready-for-human` → **split TTL** based on `envelope.posted` in the attempt state file (see *Terminal-Event Envelope* below):
     - `envelope.posted == true` → 1-day TTL. The issue thread already carries the canonical record; the local dir is pure redundancy.
     - `envelope.posted == false` or field missing → 7-day TTL. The envelope POST failed (or this dir predates the envelope writer), so the local notes/log are the only copy.
   - label `running` (orchestrator crashed mid-issue) → restore `ready-for-agent`, post a recovery comment, then `rm -rf`. Leaving the issue eternally `running` is worse than losing the dir.
   - any other state → `rm -rf`.
3. **Fallback on gh failure.** Network / rate-limit error → fall back to mtime TTL: 7 days for dirs with a state file, 1 day for dirs without one. Conservative enough to survive transient outages without losing artefacts the human wanted.

This removes the manual "remember to clean `.red/tmp/`" discipline. Blocker dirs persist until their TTL expires; everything else self-collects on the next `/afk` run.

## Attempt Cap (boot-time, issue #257)

The *Completion sweep* (close step 11) only fires when an issue completes. Issues that **never** complete — blocked-forever work that accumulates retries — would otherwise leak worker dirs indefinitely. Right after *Orphan Cleanup*, `cap_issue_attempts` walks every worker dir across all workers, groups them by issue, and per issue prunes (newest attempt kept first) anything over either cap:

- **Age cap** — fixed at 14 days. An worker dir whose mtime is older than this is reclaimed.
- **Count cap** — fixed at 5. Only the newest five attempts (by attempt number) for one issue are retained; older ones are reclaimed.

Both caps share the completion sweep's invariant: a **live** worker's active attempt (state file carrying a live `pid`) is never counted toward the cap nor removed.

## On-Demand Branch Reaper (issue #275)

Run `/afk reap` (the bundle's `reap` command) to perform branch hygiene without starting a worker, claiming an issue, or firing lifecycle hooks. The command first prints one line:

```text
afk branch counts: remote-afk=N local-afk=N
```

It then applies the same live-branch reapers used during `/afk` boot: remote `afk/*` and local `afk/*`. Open issues and transiently unclassified issues are kept; local branches checked out by any worktree are kept. Each successful deletion logs the branch, issue number, and classification reason. Re-running is a natural no-op once stale refs are gone.

## Docs Sweep (boot-time)

After branch cleanup and before the dependency Unblock Sweep, `/afk` verifies
that source-of-truth docs under `.red/` are visible from the freshly fetched
base. The sweep covers glossary docs (`.red/CONTEXT.md`,
`.red/CONTEXT-MAP.md`, `.red/contexts/**`) and ADR docs (`.red/adr/**`) from
three signals:

- working-tree changes and deletions;
- untracked or ignored docs, including adopter repos that ignore `.red/`;
- doc paths changed by commits ahead of `origin/<base>`.

Operational surfaces are excluded: `.red/tmp/`, `.red/wiki/`, `.red/memory/`,
`.red/brain/`, and `.red/state/`.

When every stranded doc is publishable, `/afk` creates one isolated worktree
under `.red/tmp/docs-sweep/` from `origin/<base>`, copies only those doc paths,
creates one `docs:` commit, pushes a branch, opens one PR, merges it, and fetches
the base afterward. It never commits in the primary checkout, switches branches,
stashes, or resets.

When the base cannot be fetched, the PR lane fails, or an ignored doc path class
has no tracked precedent on `origin/<base>`, boot halts before issue selection or
fleet slot spawn. The halt message carries the explicit relative file list so a
maintainer can land or remove the stranded docs deliberately.

## Unblock belt: the sweep also runs OUTSIDE the boot suite (issue #3014)

**A dependent whose last `req:*` blocker closed must lose `blocked:dependency`
even on a repo where nothing but a live session is ever awake.** Three clearers
exist, and on such a repo every one of them missed:

1. **the close cascade** (`runCloseCascade`) is event-driven but reachable only
   from a worker's terminal stage or from `reconcile()` — it fires when the
   *agent* closes the blocker. A human closing it in the GitHub UI runs no local
   code; the webhook delivery lands in the singleton lane, where only `rsp wait`
   reads it;
2. **the boot-time Unblock Sweep** *is* awake — the castle resident's janitor
   runs the whole suite every five minutes — but it is **step 7** of a suite that
   routinely aborts before reaching it: a failing precheck returns after step 1,
   a red operational probe throws `BootHaltError` at step 1a, and the *Docs
   Sweep* halts on any stranded `.red/` doc, which is the ordinary state of a
   repo a human edits by hand;
3. **the `unblock_sweep` MCP tool** promotes correctly, but only when somebody
   thinks to call it.

So the promote path was reachable in principle and starved in practice. The
resident therefore runs the sweep on its **own belt**, independent of the boot
suite: one pass detached at resident start — the session-boot clearer — and one
per interval afterwards. The belt needs `gh` and nothing else (no probes, no
git, no worktrees), it costs a single `gh issue list` when nothing is blocked,
and a repo-scoped singleton keeps several stdio hosts from each sweeping the
same tracker. A failing pass costs itself and nothing else; the next tick still
runs. Promotion itself is unchanged — the belt, the boot suite's step 7, and the
MCP tool all promote through the one shared core, so the lane rules (`#2966`)
and the audit comment are identical whichever trigger fired.

## Fleet mode: the supervisor owns the boot (issue #623)

The sweeps above (*Orphan Cleanup*, *Attempt Cap*, live branch cleanup, *Docs Sweep*, the *Unblock Sweep*, and the *Straggler Check*) all read and mutate **shared** `.red/tmp` / branch / `gh` state. When several workers boot at once they would race over that state — the observed failure mode was a fleet collapsing to a single live worker because peers fast-died in their boot sweeps.

So in **fleet mode** the **supervisor** runs the full sweep suite **exactly once, before it spawns any worker**, and logs the result to `.red/tmp/supervisors/default/supervisor.log.toonl` (`boot sweeps complete: orphans … | attempt-cap … | branches … | docs-sweep … | unblocked … | stragglers …`). Every worker the supervisor spawns carries a `RED_AFK_SWEEPS_DONE=1` marker; a marked worker's boot is **bootstrap + claim only** — it ensures its dirs/gitignore/`worker.pid` and goes straight to claiming an issue, skipping every shared sweep. This makes respawns cheap and keeps workers from racing each other over boot state. The supervisor runs the sweeps a single time per lifetime: a worker that exits and is respawned does **not** re-trigger them.

A **solo** `/afk run` (no supervisor, no marker) is unchanged — it runs the full sweep suite itself, exactly as described above. `/afk run --boot-only` reports which path it took: `sweeps ran` for a solo boot, `sweeps skipped (supervisor-owned)` for a marked worker.
