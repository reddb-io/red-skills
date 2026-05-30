# Triage Labels

Canonical label vocabulary and full issue lifecycle. This is the single source of truth — `/triage`, `/afk`, `/to-issues`, and `/to-prd` all reference this file.

## Label Mapping

The skills speak in terms of canonical triage roles. Map them here to the actual label strings used in this repo's issue tracker.

| Canonical role     | Label in our tracker | Applied by                            | Removed by                          |
| ------------------ | -------------------- | ------------------------------------- | ----------------------------------- |
| `needs-triage`     | `needs-triage`       | `red-issues-needs-triage` workflow, `/triage` | `/triage` (when state transitions) |
| `needs-info`       | `needs-info`         | `/triage`                             | `/triage` (when reporter replies)   |
| `ready-for-agent`  | `ready-for-agent`    | `/triage`, `/to-issues`               | `/afk` (when claiming)              |
| `running`          | `running`            | `/afk` (when claiming an issue)       | `/afk` (on close, blocker, or release) |
| `ready-for-human`  | `ready-for-human`    | `/triage`, `/afk` (on blocker)        | maintainer                          |
| `blocked:dependency` | `blocked:dependency` | `/to-issues` (slice with open deps)  | `/afk` auto-unblock when last dep closes |
| `wontfix`          | `wontfix`            | `/triage` (then close)                | rarely — usually issue closes       |

Edit the right-hand column to match whatever vocabulary you actually use.

## Full Lifecycle

Every issue moves through this state machine. Arrows show the transitions; the actor on each arrow is the skill or workflow responsible.

```
                       ┌─────────────────────┐
                       │   issue created     │
                       │   (any source)      │
                       └──────────┬──────────┘
                                  │
              red-issues-needs-triage workflow
              (auto on opened/reopened, no label)
                                  ▼
                       ┌─────────────────────┐
        ┌─────────────│    needs-triage     │────────────┐
        │              └──────────┬──────────┘            │
        │                         │                       │
   /triage:                  /triage:                /triage:
   needs-info               wontfix                  ready-for-*
        │                         │                       │
        ▼                         ▼                       │
┌──────────────┐           ┌──────────────┐               │
│ needs-info   │           │   wontfix    │               │
│ (await user) │           │   + close    │               │
└──────┬───────┘           └──────────────┘               │
       │                                                  │
  reporter replies                                        │
   → /triage                                              │
       │                                                  │
       └──────────────────► needs-triage                  │
                                                          ▼
                              ┌───────────────────────────────────┐
                              │                                   │
                              ▼                                   ▼
                  ┌──────────────────────┐         ┌──────────────────────┐
                  │   ready-for-agent    │         │   ready-for-human    │
                  │   (## Agent brief    │         │   (needs judgment)   │
                  │    in body)          │         └──────────────────────┘
                  └──────────┬───────────┘                     │
                             │                                 │
                       /afk claim:                       human picks up
                       removes ready-for-agent,          (manual impl,
                       adds running                       eventually closes)
                             │
                             ▼
                  ┌──────────────────────┐
                  │       running        │
                  │  (worktree active,   │
                  │   heartbeats post)   │
                  └──────────┬───────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        /afk: DONE      /afk: BLOCKED   /afk: merge conflict
              │              │              │
              ▼              ▼              ▼
        ┌─────────┐   ┌────────────────────────────┐
        │ closed  │   │ remove running,            │
        │ + merge │   │ add ready-for-human,       │
        │ comment │   │ worktree preserved         │
        └─────────┘   └────────────────────────────┘
```

## State Definitions

### `needs-triage`
Maintainer has not evaluated the issue yet. **Applied automatically** by `red-issues-needs-triage.yml` workflow on every fresh `opened`/`reopened` issue with no labels. Manual application by `/triage` when the maintainer puts an evaluated issue back into the queue. Removed by `/triage` when the issue transitions to a definitive state.

### `needs-info`
The triage agent or maintainer needs more information from the reporter before a decision can be made. Removed by `/triage` once the reporter responds and the issue cycles back through `needs-triage`.

### `ready-for-agent`
The issue body contains a complete `## Agent brief` section (see `triage/AGENT-BRIEF.md`) that forms a contract sufficient for an AFK agent to implement without human context. **This is the only state `/afk` consumes.** Applied by `/triage` (after grilling) or `/to-issues` (on creation when the slice is AFK-safe).

### `running`
`/afk` has claimed the issue and is actively executing it. Applied atomically with the removal of `ready-for-agent` so two parallel `/afk` runs cannot race on the same issue. The orchestrator's heartbeat sub-shell posts `:one:` → `:four:` comments every 10 min while this label is present. Removed on close (success), on blocker (replaced with `ready-for-human`), or on graceful release (if the user interrupts the loop).

### `ready-for-human`
The issue requires human implementation. Two sources: `/triage` decides it during evaluation (e.g. architectural call, design review needed), or `/afk` promotes it from `running` after a blocker (inner agent gave up, merge conflict couldn't be auto-resolved, both runners exhausted). When `/afk` promotes, the worktree is **preserved at the moment of blocker** so the human can pick up in place.

### `blocked:dependency`
The issue is **waiting on one or more other issues to close** — it is healthy, not broken, and **needs no human action**. This is deliberately distinct from `ready-for-human`: a dependency-blocked issue must **never page a human** (nothing for them to do but wait). The specific edges live in `req:N` labels (one per dependency, see below) — the queryable source of truth — mirrored by the human-facing `## Blocked by` task list in the body. When the **last** `req:N` dependency closes, `/afk` auto-promotes the issue to `ready-for-agent` (see *Dependency Edges* below). Applied by `/to-issues` when it publishes a slice whose blockers are still open.

### `wontfix`
Will not be actioned. Applied by `/triage`. For bugs, paired with a polite explanation and close. For enhancements, paired with a `.out-of-scope/*.md` entry (see `triage/OUT-OF-SCOPE.md`).

## Heartbeat Comments

While `running`, `/afk` posts a heartbeat comment every 10 minutes so the issue is never silent during long executions:

```
t=10 min  →  :one:
t=20 min  →  :two:
t=30 min  →  :three:
t=40 min  →  :four:
t=50 min  →  :one:   (cycle resets)
```

Stops on any terminal transition out of `running`.

## Optional Auxiliary Labels

These exist for filtering and don't drive lifecycle transitions:

| Label          | Meaning                                         | Applied by                       |
| -------------- | ----------------------------------------------- | -------------------------------- |
| `bug`          | Something is broken                             | `/triage`                        |
| `enhancement`  | New feature or improvement                      | `/triage`                        |
| `priority:high` | Urgent / high-impact — `/afk` drains these first | `/triage` or maintainer        |
| `priority:low`  | Everything else                                  | `/triage` or maintainer        |
| `prd:{N}`      | Issue belongs to PRD #N                         | `/to-issues` when splitting a PRD |
| `slice:hitl`   | Slice that needs human-in-the-loop              | `/to-issues`                     |
| `slice:afk`    | Slice that can run unattended                   | `/to-issues`                     |
| `runner-error` | `/afk` fleet supervisor parked a slot after fast-death streak; affected issues were restored to `ready-for-agent` after the runner was discarded | `/afk` fleet supervisor on circuit trip |

`runner-error` is the only auxiliary label `/afk` may create autonomously: the fleet supervisor calls `gh label create runner-error` when it trips the circuit breaker, so the cleanup never fails just because the label has not been provisioned.

## Dependency Edges (`req:N`) + Auto-Unblock

Dependencies between issues are **first-class queryable edges**, not buried in prose. They mirror the `prd:N` convention.

| Label    | Meaning                                              | Applied by      |
| -------- | ---------------------------------------------------- | --------------- |
| `req:{N}` | This issue **requires** #N to close before it can run | `/to-issues` (one per blocker) |

How the edge drives the lifecycle:

- A slice published with open blockers carries **`blocked:dependency`** + one **`req:N`** label per blocker (and the human-facing `## Blocked by` task list in the body). It is **not** `ready-for-human` and never pages.
- **Event-driven cascade (on close):** when `/afk` closes issue #N, it runs `gh issue list --label req:N --state open`; for every dependent whose **all** `req:*` referenced issues are now closed, it removes `blocked:dependency`, adds `ready-for-agent`, and posts `🤖 /afk unblocked: all dependencies closed (#…)`. The unblock happens **the moment the last dependency closes**, not on the next boot.
- **Boot sweep (safety net):** at `/afk` boot, the *Unblock Sweep* re-scans `blocked:dependency` issues by their `req:*` labels (preferring labels; falling back to the legacy `## Blocked by` body parse for pre-`req:N` issues) and promotes any whose deps all closed — catching events the cascade missed.

`req:N` labels, like `prd:N`, are created on demand (`gh label create req:<n>` when first applied); `blocked:dependency` is provisioned by `/setup-red-skills`.

## Naming Convention

All labels follow one of two shapes:

- **kebab-case** — `needs-triage`, `ready-for-agent`, `running`, `wontfix`, `bug`.
- **`prefix:value`** — `priority:high`, `slice:afk`, `prd:42`.

No uppercase, CamelCase, snake_case, or spaces. GitHub matches labels case-insensitively for filtering but stores the case you create them with — keep the tracker clean by normalising on creation. `/setup-red-skills` surfaces non-conforming labels and offers to rename via `gh label edit "Old Name" --name "new-name"`.
