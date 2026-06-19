# AFK worker vitals are one canonical vocabulary across the whole chain

## Status

proposed.

Relates: [ADR 0033](0033-red-castle-owns-afk-execution-substrate.md) (red-castle owns
execution + stream normalization), [ADR 0044](0044-afk-attempt-progress-guard.md) /
[ADR 0045](0045-externalized-proof-of-life-heartbeat.md) (the proof-of-life heartbeat
this formalizes), [ADR 0061](0061-red-castle-is-a-vendored-submodule.md) (red-castle is
vendored, so we can change its extraction freely), [ADR 0060](0060-root-apps-packages-with-pnpm-catalog.md)
(the `apps/dev` + `packages/` layout the contract spans).

## Context

We own the entire observability chain end to end:

- **red-castle** (`packages/red-castle`) extracts the raw signal — it normalizes each
  CLI's stream (claude / codex / opencode) into `AgentStreamEvent`s (`text`,
  `toolCall`, `reasoning`, `usage`, …).
- **apps/dev** (the AFK runtime) counts and derives — `activity-meter.ts`, the
  proof-of-life heartbeat (`heartbeat.ts`), the worker state file
  (`afk.state.json` via `AfkCurrentSchema`), and the firehose (`log.jsonl`).
- **consumers** — the statusline, the `monitor`, and the `dashboard` all read the
  state file and the firehose to show "is this worker alive and making progress".

Because we built it in slices, **the same concept wears a different name in every
layer**, and two signals we already have are silently dropped:

| Concept | red-castle | activity-meter | heartbeat / `current.*` | render |
|---|---|---|---|---|
| tool invocation | `toolCall` | `toolsCalled` | `tools_called_count` | `tools:N` |
| model reasoning | `reasoning` | `reasoningCount` | **`thinking_called_count`** | `think:N` |
| lines changed | — | — | `diff_added` **and** `loc_added` (alias) | `+N` |
| last advance | — | — | `last_progress_at` (= last **commit**) | — |

Three concrete defects fall out of this drift:

1. **`thinking` vs `reasoning`** — red-castle says `reasoning`; the state says
   `thinking_called_count`. One concept, two names, translated by accident.
2. **`diff_*` aliased to `loc_*`** — the heartbeat writes both keys for the same
   number "for back-compat", so every consumer must know they are the same.
3. **`last_progress_at` is mislabeled** — it tracks the last *commit*, not activity,
   so a worker that has been exploring (streaming tools, never committing) for ten
   minutes looks stalled. The honest liveness clock — **the time of the last stream
   event** — does not exist anywhere, even though `apps/dev`'s `recordAgentEvent`
   sink observes every event. Likewise red-castle parses a `usage` event (token
   counts / cost) that `apps/dev` never persists.

## Decision

Define **one canonical vocabulary — `WorkerVitals` — for every observable signal a
running AFK worker emits**, flowing red-castle → state → all consumers with exactly
one name per signal and a single translation boundary.

### 1. The canonical signal set

Grouped by the question each group answers. These names are the contract; no
consumer renames on the way through.

```
WorkerVitals
├─ identity      issue · runner · attempt · retries
├─ lifecycle     stage · iteration · iteration_max · sentinel (none|done|blocked)
├─ progress      loc_added · loc_removed · commits · last_commit_at
├─ activity      tools_called · text_chunks · reasoning_events · last_event_at
├─ liveness      waiting_windows · silent_for_s  (derived: now − last_event_at)
└─ cost          input_tokens · output_tokens · reasoning_tokens · cost_usd
```

### 2. The renames / alias-kills (the debt this pays down)

- `thinking_called_count` → **`reasoning_events`** (align with red-castle's `reasoning`).
- Drop the `diff_*` alias; keep **`loc_added` / `loc_removed`** as the single name.
  `AfkCurrentSchema` retains `diff_*` as a read-only back-compat shim for one release,
  then removes it.
- `last_progress_at` → **`last_commit_at`** (say what it is); add the new
  **`last_event_at`** as the true liveness clock.
- Add the **cost** group, sourced from red-castle's `usage` event.

### 3. The two new extractions we already have but throw away

- **`last_event_at`** — stamped by `apps/dev` in `recordAgentEvent` (it already sees
  every event). No red-castle change needed. This is the honest "is it alive" clock,
  distinct from `last_commit_at` ("is it advancing").
- **`cost` / `tokens`** — red-castle emits a `usage` event per CLI; `apps/dev`
  forwards it into `WorkerVitals.cost`. Surfaces per-worker spend on the statusline
  and monitor.

### 4. The layering (who owns what)

- **red-castle** extracts and emits raw, CLI-normalized events — including `usage`.
  It never speaks the `WorkerVitals` vocabulary; it stays the substrate (ADR 0033).
- **apps/dev** owns the **single translation boundary**: the `recordAgentEvent` +
  heartbeat sink maps red-castle events into `WorkerVitals` and persists them on
  `current.*` (and the firehose). This is the only place a rename may happen.
- **consumers** (statusline, monitor, dashboard) read `WorkerVitals` off the state
  file and render — never re-deriving, never re-naming.

A shared TypeScript type `WorkerVitals` is the contract, lived next to
`AfkCurrentSchema`; the schema's `current.*` fields ARE that type. Because
`updateState` round-trips the whole state through the schema before writing, every
canonical field must be declared there or it is stripped on both write and read.

## Consequences

- **Migration spans the chain but is mechanical**: schema field renames + back-compat
  read shims, the heartbeat builder, and each consumer's read site. The statusline
  liveness slice (stage suffix + `💤` waiting) is the first vertical slice and lands
  under this contract.
- **One red-castle change**: surface the `usage` event's token/cost numbers through
  `apps/dev` (extraction already exists; the wiring does not).
- **`last_event_at` replaces `last_progress_at` as the liveness signal** in the
  attempt-progress guard's *display* (the guard's *abort* logic stays commit-anchored
  per ADR 0044 — a worker streaming forever without committing is still stalled work).
- **Tests pin the vocabulary**: a single test asserts the red-castle event → `current.*`
  field name map, so a future per-CLI parser cannot silently reintroduce drift.
- Old firehose records and state files keep their legacy keys; the back-compat read
  shim means no monitor breaks across the upgrade.
