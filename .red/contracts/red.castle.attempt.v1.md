# Castle Attempt Record

schema id: `red.castle.attempt.v1`

Exported TypeScript contract types: `CastleAttemptEntry`, `CastleAttemptRecord`,
`CastleAttemptEvent`, `CastleAttemptWriter`, `CastleAttemptClaim`,
`CastleAttemptRouting`, `CastleAttemptGateVerdict`, `CastleAttemptLandingStep`,
`CastleAttemptOutcome`, `CastleAttemptOutcomeKind`, `CastleAttemptResources`,
`CastleAttemptArtifact`.

The **attempt** — one worker × one ticket × one try — is the unit of truth of
the execution plane (ADR 0128). Its record is the append-only TOONL lane
`.red/state/castle/attempts.toonl`: durable state per ADR 0098, never `.red/tmp/`,
which holds only the attempt's disposable workspace.

Three rules the writer enforces:

1. **The resident writes it, never the worker.** Every entry carries
   `writer: "resident"` and an entry stamped otherwise is rejected — the record
   matters most exactly when the worker is already gone, so a self-reported one
   is unavailable when it is needed.
2. **The write path degrades, it never fails an attempt.** A malformed entry or
   an unwritable lane is surfaced as a diagnostic and execution continues. The
   record is diagnostic; it must never break execution.
3. **The lane is append-only.** A later fact about an attempt is a new line, not
   an edit of an earlier one. A prior attempt's record is never rewritten.

An attempt's `CastleAttemptRecord` is the **fold** of every entry sharing its
`attempt_id` (`<worker_id>:<issue>:<try>`). A ticket's history and a worker's
history are filters over that fold — derived views, never separately maintained
state.

## Entry fields

Required on every entry — a missing one is rejected before the lane is touched:

- `schema`
- `attempt_id`
- `worker_id`
- `issue`
- `try`
- `at`
- `event`
- `writer`

Narrative and pointer fields, each optional and each carried by the event that
learned it:

- `claim` — claim and concede, with the reason
- `routing` — the routing decision: runner, tier, model, effort
- `branch` — the attempt's branch
- `commit` — one commit; the fold accumulates them in order
- `pr` — the pull request number
- `gate` — one gate verdict; the fold accumulates them
- `landing` — one landing step; the fold accumulates them
- `outcome` — the terminal outcome; a `budget-exceeded` outcome NAMES its
  budget and is never recorded as a stall
- `resources` — wall clock, peak RSS, cost
- `artifact` — one artifact left behind, with its reclaim eligibility, so the
  janitor reclaims on the record's verdict rather than on a missing pid file
- `note` — a one-line human-readable gloss
- `payload` — event-specific detail that has no dedicated field yet

## Retention and reclaim

**An artifact is reclaimable when its attempt record says so, never when a pid
file happens to be missing.** Keying on pid-file absence produced the exact
inversion it was meant to prevent: the live supervisor's lane was deleted while
the dead ones survived (#2679). The planner (`planCastleReclaim`) reads nothing
but the record — no pid, no pid file, no mtime.

An attempt's **retention tier** comes from its terminal outcome:

| Tier | Record state | What survives | What is reclaimable |
| --- | --- | --- | --- |
| `live` | no terminal outcome | everything | nothing |
| `landed` | `outcome.kind: done` | the record and its pointers | the workspace and the evidence |
| `failed` | any other terminal outcome | the record, its pointers, and the cheap evidence | the expensive workspace only |
| `discarded` | `outcome.kind: discarded` | the record and its pointers | the workspace and the evidence |

An artifact's **class** decides what keeping it costs:

- **workspace** (`worktree`, `workspace`, `node_modules`, `checkout`,
  `build-cache`, `sandbox`) — expensive and regenerable: the bytes that fill a
  disk.
- **evidence** (`log`, `diagnostic`, `envelope`, `transcript`, `patch`,
  `handoff`, `report`) — cheap and irreplaceable: what a human reads to rescue
  orphaned work after the worker is gone.
- **pointer** (`branch`, `pr`, `commit`, `tag`, `issue`) — named by the record,
  not stored by it, so there are no bytes here to reclaim.
- **unknown** — anything else. Retained AND reported; the janitor never deletes
  what it cannot classify.

Two record-level overrides win inside any closed tier: `reclaimable: false` pins
an artifact the tier would otherwise reclaim, and `reclaim_after` holds one until
that instant has passed.

**Liveness wins at path granularity, not just per record.** A retry is a fresh
attempt on the same workspace path (ADR 0103), so a path any live attempt owns is
retained even when an older, closed attempt's own outcome would release it.

**A silent truncation is a failure.** Every artifact considered lands in exactly
one of `reclaim`, `retain`, or `dropped`, and `totals` states that identity so a
caller can assert it. A reclaim cap reports each artifact it held back
(`reason: limit`), and an observed path no record accounts for is reported
(`reason: no-record`) and left alone rather than swept.

## Pinned fixture

`.red/contracts/fixtures/attempt-record/` pins the lane bytes and the folded
record the writer must produce, plus the invalid entries it must reject. Both
the writer and every reader are tested against it.
