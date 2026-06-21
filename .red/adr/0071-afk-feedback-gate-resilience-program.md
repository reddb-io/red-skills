# AFK feedback-gate resilience program — infra/semantic failure split, baseline probe, worktree cache, death diagnostics

## Status

accepted.

Relates: [ADR 0008](0008-afk-feedback-is-the-merge-gate.md) (feedback is the merge
gate), [ADR 0055](0055-afk-reconcile-no-agent-worker-mode.md) (no-agent reconcile),
[ADR 0061](0061-afk-execution-substrate-is-vendored-red-castle.md) (red-castle
submodule source), [ADR 0070](0070-claude-minimax-runner-anthropic-compat-endpoint.md)
(the spike whose worker failures motivated this). Builds on the recovery policy
(`core/recovery.ts`), the attempt-outcome vocabulary (`core/attempt-outcome.ts`),
and the feedback worktree manager (`runtime/feedback-worktree.ts`).

## Context

The `claude-minimax` spike (PRD #788, June 2026) drained five child issues
(#791–#795) through `/afk`. Across **27+ worker attempts, zero issues
auto-merged** — every one was recovered by a manual cherry-pick. A post-mortem
of the worker logs, issue threads, and sandcastle state identified **seven
distinct failure patterns**, none of which the feedback gate (ADR 0008) was
equipped to absorb:

1. **Submodule lifecycle in a fresh worktree.** `git worktree add` does not
   populate submodules, so `packages/red-castle` (the `@reddb-io/red-castle`
   `workspace:*` source, ADR 0061) was an empty dir, `pnpm install` could not
   resolve it, and every gate check failed `Cannot find module` — a false
   `blocked:validation` on green work.
2. **Test drift between the worker branch and main.** A worker branch forked
   from main at T0; by the gate run at T1, main had moved (e.g.
   `CLAUDE_CODE_SIMPLE` added to `minimax-env.ts`), so a worker test expecting
   two env vars failed against the three the function now returns. Two
   different workers (wPB6F, wQYIB) independently re-derived the same fix.
3. **Pre-existing main failures inherited.** `memory-brain-boundary-docs.test.ts`
   was red on main; every worker's branch inherited it and the gate — which
   runs the whole touched package's tests — failed on it. 1670/1671 passing,
   one unrelated failure, gate closed.
4. **OOM under `fleet=2`.** `pnpm install` + four gate scripts × N packages,
   two workers in parallel, exhausted memory; the worker was SIGKILLed (exit
   137).
5. **Orchestrator process dying.** Every worker process (10+) died post-commit
   + `vitest` with **no exit code, no signal, no stack trace**. The cross-host
   stale-claim sweep recovered the issue, but the cause was opaque.
6. **Feedback gate not retryable.** `validation` was NON-recoverable in
   `recovery.ts` (cap 0, always escalate). The first gate failure for ANY
   reason — including the infra reasons above — stranded the branch.
7. **Claim race / cross-host stale-claim is a band-aid.** Each re-claim did a
   fresh `worktree add` + `submodule update` + `pnpm install`. #793 alone saw
   five re-claims (w8NT0 → wBSCD → wUF6D → wJVX3 → wMHZR), paying the full
   install cost five times for one issue.

The umbrella problem: the gate treated **a broken gate environment** and **a
broken worker's code** as the same terminal failure, and re-running was
expensive enough that the stale-claim loop amplified the cost.

## Decision

Adopt a **resilience program** — six coordinated changes, each independently
shippable and tested, that make the feedback gate distinguish infrastructure
failures from semantic failures, self-heal the infra class, and leave a
forensic trail when the cause is still unknown.

### 1. INFRA / SEMANTIC failure split (Pattern 1, 4, 6)

A new `AttemptOutcome` `feedback-failed-infra` (label `blocked:validation-infra`)
sits beside the existing `feedback-failed` (`blocked:validation`). A pure
classifier `isInfraFeedbackFailure(feedback)` reads the failing check's
`summary`: the worktree-setup/submodule-init/install markers
(`feedback-worktree.ts` already fails closed with those strings) and the
OOM-killer signature (`SIGKILL` / a standalone `137`). Infra failures route
through a new `validation-infra` recovery key (bounded retry, default cap 2,
knob `RED_AFK_RETRY_VALIDATION_INFRA`); the **semantic** `feedback-failed`
stays non-recoverable — a worker with a genuinely broken test still pages a
human. The simple→complex tier escalation only fires for semantic failures
(bumping the tier cannot fix a broken submodule).

### 2. Baseline probe for pre-existing failures (Pattern 3)

When the gate fails AND a `baselineWorktree` is supplied, the failing checks
re-run against the base branch. A check that also fails on the baseline is a
pre-existing flake (not the worker's fault) and is downgraded `failed` →
`skipped (pre-existing failure on baseline)`, surfaced as `baselineDowngraded`
for observability. The probe runs **only on failure**, so the happy path costs
nothing. Both the DONE path (`process-issue.ts`) and the no-agent reconcile
path (`reconcile.ts`) pass `base` as the baseline.

### 3. Tracked post-checkout hook (Pattern 1, prevention)

`scripts/git-hooks/post-checkout` (tracked) + `scripts/install-git-hooks.sh`
auto-init submodules (and `pnpm install` a fresh worktree) on every checkout,
mirroring CI's `actions/checkout submodules:recursive`. Tracking the hook means
a fresh clone can install the same behaviour; it is the only durable prevention
for the submodule-lifecycle pattern.

### 4. Cross-session worktree cache (Pattern 7)

The feedback worktree IS the cache. A worktree whose HEAD matches the live
branch HEAD is reused across sessions — no `worktree add` / `submodule update`
/ `pnpm install` on re-claim. SHA mismatch (force-push, new commit) is the only
invalidation signal; there is no mtime/TTL GC. `cleanup()` removes only
worktrees the session created, so a cache hit survives for the next session.
Opt-out via `cacheEnabled: false`.

### 5. Process-safety death diagnostic + liveness heartbeat (Pattern 5)

Every worker installs process-level handlers
(`uncaughtException`/`unhandledRejection`/`SIGTERM`/`SIGINT`/`SIGHUP`/`exit`)
that write one line per fatal event to `.red/tmp/diagnostics/<id>.log`. The
handlers **observe, never swallow** — swallowing would mask the bug. Opt-out
via `RED_AFK_NO_PROCESS_SAFETY=1`.

**The SIGKILL blind spot.** The most likely Pattern 5 cause — the OS OOM-killer
SIGKILLing the orchestrator — is *uncatchable*: SIGKILL fires no handler and no
`exit` event, so an OOM-killed worker leaves a log with `installed` but no
terminal line. To make that absence legible, the install runs a periodic
`alive` heartbeat (default 15s) carrying RSS. A reader (`classifyDeathFromLog`)
then names the fate: a terminal line → that cause; `installed` + heartbeats with
no terminal line → `uncatchable` (SIGKILL/OOM), pinned to the last heartbeat
with memory climbing. The root cause stays under investigation, but the next
occurrence reports "uncatchable death (likely SIGKILL/OOM) at ~HH:MM, rss → N
MB" instead of nothing.

### 5b. maxBuffer overflow is INFRA, not semantic (Pattern 4/6 extension)

The gate runs `pnpm test` via `execFile` with a capture ceiling. A green-but-
verbose suite whose output exceeds the ceiling was killed by Node and folded
into the generic spawn-error path, parking a passing branch as a *semantic*
`blocked:validation`. The ceiling is raised (16MB → 64MB) and a maxBuffer
overflow now carries a distinct exit code + a `maxBuffer length exceeded`
marker that `isInfraFeedbackFailure` routes through bounded `validation-infra`
recovery — a config problem the operator fixes, never a human page for a green
suite.

### 6. Opt-in feedback-gate rebase onto base (Pattern 2)

The baseline probe (#2) *skips* a drifted check; the rebase *runs* it. When
`afk.feedback.rebase_on_base` is on (default off), a freshly materialised
worktree is rebased onto the session base before the gate runs, so the updated
test validates the worker's code. Best-effort: a conflict aborts and the gate
runs un-rebased (the baseline probe catches the residue). Off by default
because a repo that pins per-issue bases would rebase onto the wrong ref;
skipped on a cache hit (the worktree is already at the branch HEAD).

### The 7 patterns as a regression suite

`tests/afk-resilience.test.ts` codifies all seven patterns as deterministic
tests, one `describe` block per pattern number, so the file doubles as a
runbook: any pattern recurring in production trips a CI test first.

## Rejected alternatives

- **Make `validation` blanket-recoverable.** Rejected: it would auto-retry a
  worker with a genuinely broken test forever (until the cap), wasting fleet
  capacity. The infra/semantic split is the point.
- **A merge-train / bors model** (push → CI gate → auto-merge). A real option
  for the long term, but a much larger change to the landing path (ADR
  0030/0048) and out of scope for absorbing the seven observed patterns. The
  process-safety log now leaves a trail to keep investigating Pattern 5
  without it.
- **mtime/TTL GC for the worktree cache.** Rejected: SHA equality is the exact
  correctness condition; a time-based cache could serve a stale checkout for a
  branch that moved within the TTL.
- **Rebase on by default.** Rejected: per-issue pinned bases would rebase onto
  the wrong ref. Opt-in keeps the default safe; the baseline probe already
  prevents the false-park without it.

## Consequences

- Infra-class gate failures (submodule, OOM, install) self-heal within the
  `validation-infra` cap instead of stranding a green branch.
- A red main no longer fails unrelated workers (the baseline probe downgrades
  the inherited failure).
- Re-claims of an unchanged branch skip the dominant install cost.
- A dying worker now leaves a forensic record AND the uncatchable (SIGKILL/OOM)
  death is classifiable from the heartbeat trail; Pattern 5's root cause remains
  open but is no longer invisible.
- A green-but-verbose suite is no longer parked as a semantic failure for
  exceeding the output capture ceiling.
- The semantic `blocked:validation` contract is unchanged — a real worker bug
  still pages a human, so the gate's authority (ADR 0008) is preserved.
- New config surface: `afk.feedback.rebase_on_base` (default false),
  `RED_AFK_RETRY_VALIDATION_INFRA`, `RED_AFK_FEEDBACK_REBASE`,
  `RED_AFK_NO_PROCESS_SAFETY`. A new label `blocked:validation-infra`.

## Testing

`recovery.test.ts` (validation-infra cap + the semantic-stays-non-recoverable
regression), `attempt-outcome.test.ts` (the new outcome in the exhaustive
tables), `feedback.test.ts` (`isInfraFeedbackFailure` + the baseline probe),
`feedback-worktree.test.ts` (the cross-session cache + the rebase path),
`wire.test.ts` (`feedbackRebaseBase` resolution), `process-safety.test.ts`
(the death-handler lifecycle), and `afk-resilience.test.ts` (the seven
patterns as a suite). 1755 tests total at adoption.
