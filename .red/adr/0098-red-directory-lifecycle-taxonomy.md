# 0098 — .red directory lifecycle taxonomy

## Status

Accepted. Amends ADR 0095 by moving the shared Repo store from the `.red/` root to the durable state tier. Amendment 1 separates host-daemon, Worker, and dispatch log ownership.

## Context

`.red/` now contains four different lifecycles in one tree: tracked repo knowledge/config, plugin-owned stores, durable machine state, and disposable scratch. The most dangerous drift is under `.red/tmp/`: some paths are safe to delete, while others currently hold state that should survive a cleanup. That breaks the operational meaning of `tmp` and makes disk reclamation risky.

The shared RedDB store also had contradictory homes: ADR 0095 selected `.red/red.rdb`, while the red-setup write contract later described `.red/tmp/red-skills.rdb`. Neither location matches the lifecycle taxonomy: the store is durable machine state and must live under `.red/state/`.

## Decision

### 1. Four lifecycle tiers

`.red/` is organized by lifecycle first, then by writer-owned lane:

1. **Tracked knowledge/config.** Versioned repo truth such as `config.yaml`, `.gitignore`, `adr/`, `contexts/`, `agents/`, `contracts/`, and `hooks/`.
2. **Plugin stores.** Plugin-owned persistent stores whose home is part of that plugin contract, such as `memory/`, `brain/`, and `wiki/`.
3. **Durable machine state.** Gitignored local state under `.red/state/`. This tier is never mass-deletable.
4. **Disposable scratch.** Gitignored local scratch under `.red/tmp/`. This tier is 100% disposable by contract: `rm -rf .red/tmp` must never destroy durable state.

Generated research reports are durable knowledge, not tmp scratch, but they are not repo truth until curated. They live in the gitignored `.red/researches/` home with date-disambiguated filenames.

### 2. Lane registry

Every writer under `.red/state/`, `.red/tmp/`, or `.red/researches/` owns a named lane. No writer may create loose files at the `.red/tmp/` root.

| Lane | Lifecycle | Owner | Policy |
| --- | --- | --- | --- |
| `.red/state/castle/` | durable state | castle engine | Supervisor/worker state snapshots, fleet registry, history, restart counters, and circuit-breakers that must survive tmp cleanup. **Amended 2026-07-21:** supersedes the original `.red/state/afk/` row — ADR 0105's boot migration moved the durable namespace to `state/castle/`, and no `state/afk/` writer remains. |
| `.red/state/rsp/` | durable state | rsp | Telemetry spool, status summaries, and resident process metadata. |
| `.red/state/statusline/` | durable state | dev/statusline | Statusline caches that should survive tmp cleanup. |
| `.red/state/deaths/` | durable state | checkout launchers and Workers | Death records, live anchors, and attributed un-trap-able deaths for processes acting for this checkout. The `redskilled` daemon is expressly not a writer here; its corresponding lane is host-scoped (Amendment 1). |
| `.red/state/branch-lock.yaml` | durable state | branch lock | Local branch lock state. |
| `.red/state/red-skills.rdb` | durable state | shared Repo store | The shared RedDB file used by memory and rsp collections. This supersedes ADR 0095's `.red/red.rdb` location and the temporary `.red/tmp/red-skills.rdb` write-contract location. |
| `.red/tmp/workers/` | disposable scratch | Worker | Per-project Worker lanes. **Amended 2026-07-21:** naming is flat `{id}/{issue}` — the `-a{n}` attempt ordinal is retired (ADR 0103); stale workspaces are swept by the AFK orphan policy. **Amended 2026-07-22:** each workspace owns its git checkout at the conventional direct child `{id}/{issue}/worktree`; castle-branded nested worktree paths are hygiene-only inputs until their TTL window expires. **Amended 2026-08-03:** the Worker's structured lifecycle log is `{id}/worker.log.toonl`, distinct from dated raw process captures (Amendment 1). |
| `.red/tmp/rsp/` | disposable scratch | rsp | Ephemeral rsp guards (resident wake lock). Registered 2026-07-21 to end the loose `rsp.wake.lock` at the tmp root. |
| `.red/tmp/go-workers/` | disposable scratch | `/go` | Disposable issue workers. Existing collision-safe worker/attempt naming stays. |
| `.red/tmp/scout-workers/` | disposable scratch | scout | Scout workers. Existing collision-safe worker/attempt naming stays. |
| `.red/tmp/claims/` | disposable scratch | AFK claim substrate | Claim locks. Stale locks are reclaimed by the claim sweep. |
| `.red/tmp/waits/` | disposable scratch | `rsp wait` | Active wait registry. Entries are removed on command exit; stale entries are sweepable. |
| `.red/tmp/worktrees/manual/` | disposable scratch | hand-worked slices | Manual isolated worktrees, named by slug. These are never durable storage. |
| `.red/tmp/worktrees/feedback/` | disposable scratch | feedback gate | Feedback worktree cache. SHA invalidation remains, with age-based janitor cleanup layered on top. |
| `.red/tmp/worktrees/landing/` | disposable scratch | landing | Temporary landing worktrees. |
| `.red/tmp/worktrees/rebase/` | disposable scratch | rebase | Temporary pre-merge rebase worktrees. |
| `.red/tmp/worktrees/cascade/` | disposable scratch | cascade | Cascade rebase/follow-up worktrees. |
| `.red/tmp/worktrees/adopt/` | disposable scratch | adoption/requeue | Temporary adoption and no-agent landing worktrees. |
| `.red/tmp/worktrees/docs/` | disposable scratch | `/start` docs finalizer | Temporary docs landing worktrees. |
| `.red/tmp/logs/<yyyy-mm-dd>/` | disposable scratch | dispatching sessions | Raw process-stream captures owned by the session that requested the process. `/go` and `/afk` dispatches return `dispatch-<ts>-<id>.log`; registration captures use `worker-<daemon-worker-id>.log`. These are not Worker structured lanes or daemon state (Amendment 1). |
| `.red/tmp/scratch/` | disposable scratch | sessions | Free-form short-lived scratch. |
| `.red/tmp/diagnostics/` | disposable scratch | dev runtime | Failure diagnostics with age-based cleanup. |
| `.red/researches/` | durable generated knowledge | `/research` | Date-disambiguated reports; gitignored until curated elsewhere. |

New writers must either use one of these lanes or extend the registry by ADR/docs amendment. Unknown tmp lanes are reported by doctor/janitor surfaces, not deleted blindly.

### 3. TTL policy

Janitor cleanup is lane-specific:

- `tmp/logs/` and `tmp/scratch/`: short TTL.
- `tmp/diagnostics/`: age cap.
- `tmp/worktrees/feedback/`: mtime TTL on top of existing SHA invalidation.
- `tmp/worktrees/{landing,rebase,cascade,adopt,docs}/`: remove when not live and no longer referenced by the owning operation.
- `tmp/worktrees/manual/`: spare slug-named manual worktrees unless an explicit cleanup command or future documented TTL applies.
- `tmp/workers/`, `tmp/go-workers/`, and `tmp/scout-workers/`: keep the existing worker/attempt orphan policy keyed by worker liveness, issue state, envelope presence, and attempt TTL.
- `tmp/claims/` and `tmp/waits/`: stale entry cleanup by their existing liveness/exit semantics.

The janitor never deletes `.red/state/`, plugin stores, tracked config, or `.red/researches/`.

### 4. Self-gitignore contract

`.red/.gitignore` is the canonical self-ignore guard for local state:

```gitignore
# Generated by /red-setup -- local AFK/runtime state, never committed.
tmp/
state/
researches/
```

Tracked knowledge/config and plugin definitions remain committable. The self-ignore contract prevents machine state from entering VCS; the lane registry prevents writers from colliding inside the local tree.

## Amendment 1 — log ownership has three layers (#3201)

The original registry described logs as if one CLI session owned every process
and every record. The host daemon introduced a higher, longer-lived scope, while
the Worker already had its own structured lane and a dispatch retained a raw
process capture. A filename called “the log” without an owner can therefore lead
a reader to an unrelated run. This amendment supersedes the original generic
“sessions” policy for `.red/tmp/logs/` and makes the three owners non-overlapping.

### 1. The host daemon

`redskilled` is host-scoped: exactly one daemon serves the machine and owns
Worker process birth, placement, limits, and host-level death evidence across
all projects. Its home is `~/.red/redskilled/`, outside every checkout, and
`provisionRedskilledHome` is the only creator (ADR 0130 Amendment 2). Its
death-record lane is
`~/.red/redskilled/state/deaths/deaths.toonl`.

A project's `.red/` must never contain daemon logs. The daemon outlives any one
project and is shared by all of them; putting its evidence under a project's
home would let that project's cleanup delete evidence belonging to other
projects. The checkout lane `.red/state/deaths/` consequently holds only
project-side launcher and Worker records. The daemon writes its own death to the
host lane above, never to a checkout's death lane.

The daemon may physically open a capture file under a project's `.red/tmp/logs/`
because it owns the Worker's stdout and stderr descriptors. That is an
implementation detail, not lane ownership: the capture is named, retained, and
returned by the project session that requested the process, and it remains 100%
disposable project scratch. It is not daemon history.

### 2. The Worker

A Worker is per-project and transient. It owns
`.red/tmp/workers/{id}/`; its one issue workspace is
`.red/tmp/workers/{id}/{issue}/`, and the git Worktree is the conventional
direct child `.red/tmp/workers/{id}/{issue}/worktree` (ADR 0103 and ADR 0105 as
re-amended). Deleting this Worker directory after its liveness and issue-state
guards clear deletes only that Worker's disposable artifacts.

The canonical Worker lifecycle reader starts at
`.red/tmp/workers/{id}/worker.log.toonl`. It contains structured Worker lifecycle
events such as claims, phase changes, validation, and completion; the sibling
`liveness.toonl` remains a separately protected heartbeat lane. For the
issue-scoped inner run, readers use the records inside
`.red/tmp/workers/{id}/{issue}/`, including `agent.log.toonl`, rather than a
dated capture guessed from the Worker id. These lanes contain structured Worker
lifecycle and inner-agent evidence, not the raw combined process stream.

### 3. The dispatching session

The `/go` or `/afk` session that asks the daemon to start a Worker owns the raw
capture it hands back:
`.red/tmp/logs/<yyyy-mm-dd>/dispatch-<ts>-<id>.log`. It contains the stdout and
stderr of exactly that dispatched process, including early bootstrap output that
may precede the Worker's own structured records. It does not contain the
structured Worker lifecycle, the daemon's host history, or output from another
dispatch.

The log path returned by that dispatch is the authoritative post-mortem handle.
A reader must not infer a dated filename from a Worker id, reuse a path retained
from an earlier dispatch, or substitute the Worker's structured lane. A
registration-lane process follows the same ownership rule but is captured as
`worker-<daemon-worker-id>.log`; that daemon-minted id is an address for the host
process, not the project's Worker id.

## Consequences

- `.red/tmp/` is disposable by contract. Durable state may not be written there.
- ADR 0095's Repo store location is amended to `.red/state/red-skills.rdb`.
- The red-setup write contract must provision rsp's JSON elision cache under tmp but the shared RedDB store under state.
- Agent instructions and the dev glossary must name the state tier and lane registry so future writers do not invent ad-hoc tmp paths.
- Boot-sweep documentation must describe the shipped pid-guarded, slug-sparing cleanup behavior, not an unconditional flat `work-*` wipe.

## Considered options

- **Per-plugin top-level split.** Rejected because it preserves plugin autonomy but does not give `.red/tmp/` a global disposability guarantee.
- **Rules and naming only.** Rejected because existing loose tmp files prove documentation without detection and lanes will regress.
- **Repo-root shared store.** Rejected as superseded by the lifecycle split: durable machine data belongs under `.red/state/`.
- **Shared store in tmp.** Rejected because rebuilding a large local RedDB store is costly; calling it disposable is dishonest.
