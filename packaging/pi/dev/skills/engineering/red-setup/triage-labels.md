# Triage Labels

Canonical label vocabulary and full issue lifecycle. This is the single source of truth — `/triage`, `/afk`, `/to-tickets`, and `/to-spec` all reference this file.

## Label Mapping

The skills speak in terms of canonical triage roles. Map them here to the actual label strings used in this repo's issue tracker.

| Canonical role     | Label in our tracker | Applied by                            | Removed by                          |
| ------------------ | -------------------- | ------------------------------------- | ----------------------------------- |
| `needs-triage`     | `needs-triage`       | `red-issues-needs-triage` workflow, `/triage` | `/triage` (when state transitions) |
| `needs-info`       | `needs-info`         | `/triage`                             | `/triage` (when reporter replies)   |
| `ready-for-agent`  | `ready-for-agent`    | `/triage`, `/to-tickets`               | `/afk` (when claiming)              |
| `running`          | `running`            | `/afk` (when claiming an issue)       | `/afk` (on close, blocker, or release) |
| `ready-for-human`  | `ready-for-human`    | `/triage`, `/afk` (on blocker)        | maintainer                          |
| `wontfix`          | `wontfix`            | `/triage` (then close)                | rarely — usually issue closes       |
| `needs-slicing`    | `needs-slicing`      | `/to-spec` (on publish)                | `/to-tickets` (when slices are created) |
| `type:spec`         | `type:spec`           | `/to-spec` (on publish)                | never — type marker, permanent       |

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
The issue body contains a complete `## Agent brief` section (see `triage/AGENT-BRIEF.md`) that forms a contract sufficient for an AFK agent to implement without human context. **This is the only state `/afk` consumes.** Applied by `/triage` (after grilling) or `/to-tickets` (on creation when the slice is AFK-safe).

### `running`
`/afk` has claimed the issue and is actively executing it. Applied atomically with the removal of `ready-for-agent` so two parallel `/afk` runs cannot race on the same issue. The orchestrator's heartbeat sub-shell posts `:one:` → `:four:` comments every 10 min while this label is present. Removed on close (success), on blocker (replaced with `ready-for-human`), or on graceful release (if the user interrupts the loop).

### `ready-for-human`
The issue requires human decision or resolution before it can proceed or be delegated. Two sources: `/triage` decides it during evaluation (e.g. architectural call, design review needed), or `/afk` promotes it from `running` after a blocker (inner agent gave up, merge conflict couldn't be auto-resolved, both runners exhausted). When `/afk` promotes, the worktree is **preserved at the moment of blocker** so the human can inspect or resolve the blocker in place.

### `wontfix`
Will not be actioned. Applied by `/triage`. For bugs, paired with a polite explanation and close. For enhancements, paired with a `.out-of-scope/*.md` entry (see `triage/OUT-OF-SCOPE.md`).

### `type:spec`
Permanent type marker for Spec issues created by `/to-spec`. A Spec is a planning artifact, **not an implementable slice** — it describes *what* to build at the product level and must be split into child issues by `/to-tickets` before any agent can execute. `/afk` hard-filters issues carrying `type:spec` from its candidate list even if `ready-for-agent` was applied by mistake. Never remove this label.

### `needs-slicing`
The Spec has been published but `/to-tickets` has not yet split it into child slices. Applied by `/to-spec` on publish, removed by `/to-tickets` once at least one child issue with `spec:{N}` exists. `/afk` counts these in its straggler check so a forgotten Spec surfaces before the loop runs dry.

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
| `spec:{N}`      | Issue belongs to Spec #N                         | `/to-tickets` when splitting a Spec |
| `wayfinder:map` | Planning map Ticket for work too large for one agent session. Carries `## Destination`, `## Not yet specified`, and `## Out of scope`; the map is an index, not a store. | `/wayfinder` |
| `wayfinder:research` | Wayfinder child type for AFK-typed research scoped to one session. Unblocked children use `ready-for-agent`; blocked children use `blocked:dependency` plus `req:N`. | `/wayfinder` |
| `wayfinder:grilling` | Wayfinder child type for HITL-typed decision work routed to a `/start` session and claimed by assignment. | `/wayfinder` |
| `wayfinder:prototype` | Wayfinder child type for HITL-typed design or logic exploration routed to a `/prototype` session and claimed by assignment. | `/wayfinder` |
| `wayfinder:task` | Wayfinder child type for AFK-typed implementation/docs work scoped to one session. Unblocked children use `ready-for-agent`; blocked children use `blocked:dependency` plus `req:N`. | `/wayfinder` |
| `runner-error` | `/afk` fleet supervisor parked a slot after fast-death streak; affected issues were restored to `ready-for-agent` after the runner was discarded | `/afk` fleet supervisor on circuit trip |
| `landing:manual` | Per-issue **manual-landing** mode (#1049): on a `ready-for-agent` issue, `/afk` runs the full pipeline + opens the PR, then **holds for a human's merge click** (parks `ready-for-human`, never auto-merges, never re-runs the agent). The issue auto-closes on PR merge via `Closes #N`. Lets agent-codable slices that must not be auto-merged stay in the autonomous lane instead of being hand-dispatched via `/go`. | `/triage` at brief time, or `/hitl`'s **delegable-manual-landing** disposition |

`runner-error` is the only auxiliary label `/afk` may create autonomously: the fleet supervisor calls `gh label create runner-error` when it trips the circuit breaker, so the cleanup never fails just because the label has not been provisioned. Provision it up front via `/red-setup` to keep colour/description consistent across repos.

## Blocked Reasons (`blocked:<reason>`) — typed, auto-classified

`/afk` already computes a precise terminal outcome for every iteration; instead of flattening every failure to one `blocked`, it tags the issue with the matching **`blocked:<reason>`** label so the backlog is filterable by *what kind* of block it is. The reason is derived automatically from the outcome — **no human classification**.

| Outcome (runtime) | Label | Recovery | Retry cap (env) |
| ----------------- | ----- | -------- | --------------- |
| runner quota / both exhausted | `blocked:quota` | **auto-retry** → ready-for-agent | 3 (`RED_AFK_RETRY_QUOTA`) |
| runner transport/setup failed | `blocked:runner-transient` | **auto-retry** → ready-for-agent | 3 (`RED_AFK_RETRY_RUNNER_TRANSIENT`) |
| couldn't integrate or land | `blocked:merge-conflict` | **auto-retry** (base settles) | 3 (`RED_AFK_RETRY_MERGE`) |
| mergeable PR blocked by CI (required check failed / still pending) | `blocked:ci` | **pages** → ready-for-human / CI-aware finisher (never re-runs the agent) | — (never auto) |
| agent exited without a sentinel | `blocked:crashed` | **auto-retry once** (transient) | 1 (`RED_AFK_RETRY_CRASH`) |
| a user `pre_*` guard hook rejected it | `blocked:policy` | **auto-retry once** | 1 (`RED_AFK_RETRY_POLICY`) |
| agent emitted `<promise>BLOCKED</promise>` | `blocked:spec` | **pages** → ready-for-human (decide/clarify) | — (never auto) |
| feedback gate failed (test/lint/build) | `blocked:validation` | **pages** → ready-for-human (review diff) | — (never auto) |
| stall-reaper killed a hung worker | `blocked:stalled` | **auto-retry** → ready-for-agent (clean) | 3 (`RED_AFK_RETRY_STALLED`) |
| worktree/base/push setup failed | `blocked:infra` | pages → ready-for-human (ops) | — |

**Bounded auto-recovery (live).** The recoverable reasons loop back to `ready-for-agent` and are retried, up to their per-reason cap (counting real attempt-ledger attempts); on the cap they **escalate** to `ready-for-human` with a `🤖 /afk escalating … retry budget exhausted (attempt N/cap)` comment. So a transient hiccup self-heals and never pages, but a persistent one still surfaces — bounded, no runaway loop. The supervisor stall-reaper's `blocked:stalled` re-queue is bounded by the **same** policy (`RED_AFK_RETRY_STALLED`, default 3). Caps are env-tunable (non-numeric/0 → default). `spec`, `validation`, and `ci` **always page** (a human must decide / review the diff / drive the open PR to merge); `dependency` waits on its `req:N` edges (never pages). `blocked:ci` (#812) is deliberately non-recoverable: the work is already complete and committed on the open PR, so re-running the agent would re-spend tokens for nothing — a human / CI-aware finisher merges the existing PR once CI is green. **A re-queue is hygienic:** promoting an issue to `ready-for-agent` (auto-retry) or `running` (claim) sheds any `blocked:*` label in the same edit, so no live/queued issue ever carries `ready-for-agent`/`running` together with `blocked:*`. The typed `blocked:<reason>` label rides only the `ready-for-human` escalation.

> Not yet wired: time-based backoff (today the re-queue is immediate; the cap is what prevents runaway).

All `blocked:*` labels are created on the fly when first applied (mirroring `runner-error`) and provisioned by `/red-setup`.

## Naming Convention

All labels follow one of two shapes:

- **kebab-case** — `needs-triage`, `ready-for-agent`, `running`, `wontfix`, `bug`.
- **`prefix:value`** — `priority:high`, `spec:42`.

No uppercase, CamelCase, snake_case, or spaces. GitHub matches labels case-insensitively for filtering but stores the case you create them with — keep the tracker clean by normalising on creation. `/red-setup` surfaces non-conforming labels and offers to rename via `gh label edit "Old Name" --name "new-name"`.
