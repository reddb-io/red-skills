# AFK atomic GitHub-native claim: a pure reconciler over server-ordered claim comments; labels become an observability projection

> **Numbering note.** PRD #614 and issue #622 refer to this decision as
> "ADR 0056". That number was already taken by the landability reconciler
> (`0056-afk-landability-reconciler.md`) before this slice landed. The claim
> substrate was first drafted as ADR 0060, but `0060` is now the root
> `apps/`+`packages/` monorepo move (`0060-root-apps-packages-with-pnpm-catalog.md`),
> so it is recorded here as **ADR 0066** — the next free number (0065 was the
> previous max). Where the PRD says "ADR 0056 (atomic claim)", read "ADR 0066".

## Context

AFK's claim is a racy three layers (`process-issue.ts`):

1. a host-local POSIX `mkdir` lock at `.red/tmp/claims/{N}/` (#434),
2. a `running`-label pre-check (`gh issue view --json labels`), and
3. a label edit `ready-for-agent → running`.

Layer 1 only serialises workers **on one host** — it is invisible to a second
machine. Layers 2–3 are check-then-act across two `gh` round-trips: two workers
on different hosts both read `ready-for-agent` present / `running` absent, both
edit to `running`, and both proceed — a documented cross-host race. The `running`
label is the lock, so a malicious or naive auto-label is also an execution
trigger.

PRD #614 turns AFK into a **multi-user, GitHub-native, lights-out** executor: any
claimant on any host — local fleet workers, other users' fleets, GitHub Actions
runners — must compete for the same queue with no double-claim and **no required
coordinator beyond GitHub itself** (a hosted RedDB lease was explicitly rejected
because a required dependency kills drop-in adoption). The claim must become an
atomic, GitHub-native primitive, and labels must stop being the lock.

## Decision

### The ordered primitive: structured claim-comment ordering

Each claimant posts a structured marker comment on the issue:

```
<!-- afk:claim v1 worker=<host>:<worker_id> kind=claim runner=<r> ts=<iso> -->
🤖 AFK claim by worker `<host>:<worker_id>` (runner `<r>`).
```

GitHub assigns every issue comment a **globally monotonic, server-side numeric
`id`** (read via the REST API, `gh api issues/{n}/comments`). That id is a **total
order across all hosts** — the atomic ordered primitive. The **earliest active
claim wins**. Concession is a second marker (`kind=concede`); a worker's *latest*
marker is its current intent, and its *earliest* `claim` id is its order key, so a
flapping claimant cannot jump the queue by re-posting.

This is GitHub-native (works for any authenticated identity on any host,
including GHA and external users — comments need no repo push permission),
requires no external coordinator, and makes the winner a **pure function** of the
comment timeline plus the claimant's own id.

### Rejected alternatives

- **Assignee CAS** (`gh issue edit --add-assignee`). GitHub assignees are a *set*
  with **no atomic test-and-set** — every claimant's add succeeds, so you still
  need to order the `assigned` timeline events, i.e. the same ordering problem
  with a worse substrate. Assignment also requires **push/triage permission**,
  which excludes external claimants and many GHA tokens on public repos. The
  assignee header is nice observability but a poor lock — kept as a *projection*
  candidate, not the arbiter.
- **Check-run** (Checks API). Atomic and ordered, but **requires a GitHub App
  installation**, is **ref/commit-bound** (a claim is per-issue, pre-branch), and
  is heavyweight to create from a plain token. Adoption cost violates "nothing
  beyond GitHub itself for a plain `gh` user."

### The pure reconciler

The core is `reconcileClaim(records, self, opts)` (`core/claim.ts`) — **pure**,
GitHub client injected, mirroring the mirror-plan reconciler's three-layer shape
(`marker` parse → pure `reconciler` → injected-IO `orchestrator`). Given the
parsed claim records plus the claimant's own identity + comment id it returns
**won | lost** and the winner. Liveness/staleness is injected via `opts.isStale`
(exactly as the Task mirror injects each worker's `live` flag), so **cross-host
stale-claim recovery** is a pure function of injected facts rather than an I/O
call buried in the decision. Parsing is **garbage-tolerant**: any non-marker,
malformed, or worker-less comment is skipped, never throwing, so arbitrary issue
chatter and forged markers cannot corrupt the verdict. The thin
`acquireClaim(gh, self, issue)` orchestrator posts our claim, reads the markers,
runs the pure reconciler, and concedes cleanly when we lose.

### Labels become an observability projection

The `running` label is no longer consulted to arbitrate a winner. `process-issue`
still reads labels for the **state-validity recheck** (the issue must still carry
`ready-for-agent` — closed/blocked/re-triaged issues are skipped) and still
**projects** `running` best-effort after winning, but a failed projection no
longer abandons a won attempt. The single-winner authority is the claim.

### Multi-user invariants are unchanged

Urgent prepend and PRD exclusion live in the **selection** layer (`session.ts`),
upstream of the claim; the typed `blocked:*` recovery caps live in `recovery.ts`;
the terminal-envelope schema is untouched. The claim substrate replaces only the
*lock*, so every policy invariant survives on the new path — verified by the
existing selection/recovery tests still passing on top of it.

## Consequences

- Two workers on different machines can never both win an issue: the lowest
  server-assigned comment id is a single, total, cross-host order.
- A losing worker emits one `concede` marker and returns the existing
  `claim-lost` outcome — no terminal envelope, next issue picked. No envelope
  spam.
- Coordination requires nothing but GitHub. Local fleets, other users' fleets,
  and GHA runners are ordinary claimants.
- Labels are demoted to observability; an auto-applied or forged `running` label
  can no longer trigger or steal execution (it composes with the PRD's trust gate
  rather than being the gate).
- The host-local `mkdir` lock is retained as a **cheap same-host dedupe** in front
  of the GitHub round-trip, not the authority.
- A claim costs one POST + one paginated GET (~1–2 s); throughput degrades
  gracefully under GitHub latency rather than corrupting state.
- The reconciler is back-compat seamed: callers that do not inject `claimGh` keep
  the legacy `running`-label lock, so the substrate rolls out without a flag day.

## Status

Accepted.

## Related

- PRD #614 — multi-user GitHub-native AFK (this is the claim-substrate slice,
  issue #622); references this decision as "ADR 0056".
- ADR 0056 — AFK landability reconciler (the decision that took the 0056 number;
  unrelated). Both reuse the "pure reconciler, injected client" shape.
- The Task-mirror reconciler (`core/mirror.ts`) — the pure-core / injected-IO /
  injected-liveness pattern this mirrors.
- #434 — the POSIX `mkdir` claim lock, now a same-host dedupe in front of the
  GitHub-native claim.
- ADR 0030 / 0048 — the landing + binding merge gates the won path proceeds into.
