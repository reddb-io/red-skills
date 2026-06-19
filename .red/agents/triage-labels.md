# Triage Labels

Canonical label vocabulary and full issue lifecycle. This is the single source of truth — `/triage`, `/afk`, `/to-issues`, and `/to-prd` all reference this file.

## Label Mapping

The skills speak in terms of canonical triage roles. Map them here to the actual label strings used in this repo's issue tracker.

| Canonical role     | Label in our tracker | Applied by                            | Removed by                          |
| ------------------ | -------------------- | ------------------------------------- | ----------------------------------- |
| `needs-triage`     | `needs-triage`       | `red-issues-needs-triage` workflow, `/triage` | `/triage` (when state transitions) |
| `needs-info`       | `needs-info`         | `/triage`                             | `/triage` (when reporter replies)   |
| `ready-for-agent`  | `ready-for-agent`    | `/triage`, `/to-issues`               | `/afk` (when claiming)              |
| `ready-for-review` | `ready-for-review`   | maintainer (on a **PR**)              | `dev review` (when starting the advisory review) |
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
                  │   timeline-only)     │
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
`/afk` has claimed the issue and is actively executing it. Applied atomically with the removal of `ready-for-agent` so two parallel `/afk` runs cannot race on the same issue. The issue thread stays **timeline-only** while this label is present (boot stamp, attempt envelopes, human guidance, closing envelope) — there is no periodic heartbeat comment; liveness is signalled locally (inner-agent stream, agent-lane JSONL, state-file mtime), not on the thread (Slice D). Removed on close (success), on blocker (replaced with `ready-for-human`), or on graceful release (if the user interrupts the loop).

### `ready-for-human`
The issue requires human decision or resolution before it can proceed or be delegated. Two sources: `/triage` decides it during evaluation (e.g. architectural call, design review needed), or `/afk` promotes it from `running` after a blocker (inner agent gave up, merge conflict couldn't be auto-resolved, both runners exhausted). When `/afk` promotes, the worktree is **preserved at the moment of blocker** so the human can inspect or resolve the blocker in place.

### `blocked:dependency`
The issue is **waiting on one or more other issues to close** — it is healthy, not broken, and **needs no human action**. This is deliberately distinct from `ready-for-human`: a dependency-blocked issue must **never page a human** (nothing for them to do but wait). The specific edges live in `req:N` labels (one per dependency, see below) — the queryable source of truth — mirrored by the human-facing `## Blocked by` task list in the body. When the **last** `req:N` dependency closes, `/afk` auto-promotes the issue to `ready-for-agent` (see *Dependency Edges* below). Applied by `/to-issues` when it publishes a slice whose blockers are still open.

### `wontfix`
Will not be actioned. Applied by `/triage`. For bugs, paired with a polite explanation and close. For enhancements, paired with a `.out-of-scope/*.md` entry (see `triage/OUT-OF-SCOPE.md`).

## Liveness While `running` (timeline-only)

The periodic issue-thread heartbeat (`:one:` → `:four:` cycling every 10 min) was **removed in Slice D**. The issue thread is now **timeline-only**: it carries the boot stamp, the per-attempt terminal envelopes, human-guidance directives, and the closing envelope — no periodic noise.

Worker liveness during a long execution is signalled **locally**, not on the thread:

- the inner-agent stdout stream tee'd into the attempt's `afk.log`;
- the clean agent-lane `agent.log.jsonl` (one record per assistant turn — the true liveness signal) plus the `log.jsonl` firehose;
- the state-file mtime, combined with orchestrator-PID liveness, which `/afk monitor` renders as `🟢 live` vs `🟡 stale`.

See the AFK `SKILL.md` *Heartbeat (local-only, post-Slice-D)* section for the authoritative description.

## Pull Requests as a First-Class Object Type

Issues are not the only object that moves through this lifecycle. **Pull requests**
are a first-class object type too (PRD #745, cloud-agent interaction). A PR reuses
the **same** lifecycle vocabulary — `running`, `ready-for-human`, `blocked:*` — so
there is no bespoke PR state machine to learn; only the **entry** label differs.

### `ready-for-review` (PR entry label)

The only PR-specific label. A maintainer applies `ready-for-review` to a PR to
request the **advisory cloud review** (the `red-pr-review.yml` event-router
workflow fires on `pull_request: labeled` and invokes `dev review --pr N`).
Because only maintainers can apply labels, **label-application is itself the
write-access gate** — this surface needs no separate comment-author authorization.

### PR review lifecycle (reuses the issue labels)

```
   maintainer labels PR
   ready-for-review
          │
   dev review (advisory):
   remove ready-for-review,
   add running
          ▼
   ┌──────────────┐
   │   running    │   (review in flight — same label as a claimed issue)
   └──────┬───────┘
          │
   ┌──────┴───────────────────────────┐
   │                                   │
 clean pass                     blocking findings
   │                                   │
   ▼                                   ▼
 remove running              remove running, add
 (PR transitions             blocked:validation +
  out of review)             ready-for-human
```

The review is **advisory**: it posts inline comments (path + line) and a summary
back to the PR, then transitions the label. It **never pushes code**, and the
workflow requests no `contents: write`. A clean pass drops `running` (the PR
leaves the review state); blocking findings reuse `blocked:validation` +
`ready-for-human` (the same "a human must review the diff" semantics issues
already use) rather than minting a new vocabulary. When the structured review
cannot be extracted (e.g. the non-resumable OpenCode/MiniMax lane exhausts its
single attempt), the advisory path degrades to a top-level comment + a
`ready-for-human` hand-off — it never aborts silently.

`ready-for-review` is created on demand (`gh label create ready-for-review`) and
provisioned by `/setup-red-skills`.

## Optional Auxiliary Labels

These exist for filtering and don't drive lifecycle transitions:

| Label          | Meaning                                         | Applied by                       |
| -------------- | ----------------------------------------------- | -------------------------------- |
| `bug`          | Something is broken                             | `/triage`                        |
| `enhancement`  | New feature or improvement                      | `/triage`                        |
| `priority:high` | Urgent / high-impact — `/afk` drains these first | `/triage` or maintainer        |
| `priority:low`  | Everything else                                  | `/triage` or maintainer        |
| `prd:{N}`      | Issue belongs to PRD #N                         | `/to-issues` when splitting a PRD |
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

## Blocked Reasons (`blocked:<reason>`) — typed, auto-classified

`/afk` already computes a precise terminal outcome for every iteration; instead of flattening every failure to one `blocked`, it tags the issue with the matching **`blocked:<reason>`** label so the backlog is filterable by *what kind* of block it is. The reason is derived automatically from the outcome — **no human classification**.

| Outcome (runtime) | Label | Recovery | Retry cap (env) |
| ----------------- | ----- | -------- | --------------- |
| runner quota / both exhausted | `blocked:quota` | **auto-retry** → ready-for-agent | 3 (`RED_AFK_RETRY_QUOTA`) |
| runner transport/setup failed | `blocked:runner-transient` | **auto-retry** → ready-for-agent | 3 (`RED_AFK_RETRY_RUNNER_TRANSIENT`) |
| couldn't integrate or land | `blocked:merge-conflict` | **auto-retry** (base settles) | 3 (`RED_AFK_RETRY_MERGE`) |
| agent exited without a sentinel | `blocked:crashed` | **auto-retry once** (transient) | 1 (`RED_AFK_RETRY_CRASH`) |
| a user `pre_*` guard hook rejected it | `blocked:policy` | **auto-retry once** | 1 (`RED_AFK_RETRY_POLICY`) |
| agent emitted `<promise>BLOCKED</promise>` | `blocked:spec` | **pages** → ready-for-human (decide/clarify) | — (never auto) |
| feedback gate failed (test/lint/build) | `blocked:validation` | **pages** → ready-for-human (review diff) | — (never auto) |
| stall-reaper killed a hung worker | `blocked:stalled` | **auto-retry** → ready-for-agent (clean) | 3 (`RED_AFK_RETRY_STALLED`) |
| worktree/base/push setup failed | `blocked:infra` | pages → ready-for-human (ops) | — |

**Bounded auto-recovery (live).** The recoverable reasons loop back to `ready-for-agent` and are retried, up to their per-reason cap (counting real attempt-ledger attempts); on the cap they **escalate** to `ready-for-human` with a `🤖 /afk escalating … retry budget exhausted (attempt N/cap)` comment. So a transient hiccup self-heals and never pages, but a persistent one still surfaces — bounded, no runaway loop. The supervisor stall-reaper's `blocked:stalled` re-queue is bounded by the **same** policy (`RED_AFK_RETRY_STALLED`, default 3), sourcing the real attempt number from the reaped iter-dir path. Caps are env-tunable (non-numeric/0 → default). `spec` and `validation` **always page** (a human must decide / review the diff); `dependency` waits on its `req:N` edges (never pages). **A re-queue is hygienic:** promoting an issue to `ready-for-agent` (auto-retry) or `running` (claim) sheds any `blocked:*` label in the same edit, so no live/queued issue ever carries `ready-for-agent`/`running` together with `blocked:*`. The typed `blocked:<reason>` label rides only the `ready-for-human` escalation, keeping the parked backlog filterable by reason.

> Not yet wired: time-based backoff (today the re-queue is immediate; the cap is what prevents runaway).

All `blocked:*` labels are created on the fly when first applied (mirroring `runner-error`) and provisioned by `/setup-red-skills`.

## Naming Convention

All labels follow one of two shapes:

- **kebab-case** — `needs-triage`, `ready-for-agent`, `running`, `wontfix`, `bug`.
- **`prefix:value`** — `priority:high`, `prd:42`.

No uppercase, CamelCase, snake_case, or spaces. GitHub matches labels case-insensitively for filtering but stores the case you create them with — keep the tracker clean by normalising on creation. `/setup-red-skills` surfaces non-conforming labels and offers to rename via `gh label edit "Old Name" --name "new-name"`.
