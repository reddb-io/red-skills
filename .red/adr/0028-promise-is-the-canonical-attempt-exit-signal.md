# The `<promise>` sentinel is the canonical attempt-exit signal; pipe EOF and process exit are only crash detectors

## Status

accepted.

## Context

`/afk` invokes the inner agent (claude/codex) as a child process and reads its
stdout. The protocol the orchestrator advertises to the agent is the
`<promise>…</promise>` sentinel — `<promise>DONE</promise>`,
`<promise>BLOCKED</promise>`, `<promise>NO MORE TASKS</promise>`. The
orchestrator grep's the stream for those tokens to decide what to do next
(merge / re-label `ready-for-human` / exit the outer loop).

In practice the **process** of the inner agent — and therefore the **pipe** —
is what the orchestrator ends up trusting:

- Loop bodies `wait` on the child PID or read until EOF on the pipe; they treat
  pipe-closure as "the attempt is over."
- Stage detection runs on the streamed text, but the decision of *when the
  attempt is finished* defers to the runner exiting.
- A misbehaved runner that emits `<promise>DONE</promise>` and then keeps
  background work running (an `&`-spawned poll loop, a daemon, a long-running
  tail) holds the pipe open. The orchestrator hangs.
- A runner that crashes after emitting the sentinel and before clean exit gets
  treated as success only if EOF arrives — there's no committed point at
  which we declare the attempt over.

This was the diagnosis path for the `#216` bash-hang scare: I was about to
attribute a 25-minute pnpm test run to "the runner is stuck on a background
poll" because the orchestrator's view of "attempt over" was *child closed the
pipe*, not *agent declared the attempt over*. The hang turned out to be
legitimate test work, but the architecture made the wrong shape of hang
*possible*, and that's worth fixing on its own.

A second motivation is ADR 0017's `attempt` node and ADR 0026's
`pre_attempt`/`post_attempt`/`on_attempt_error` lifecycle: the attempt boundary
needs a deterministic close *that the agent itself authored*, so the
`post_attempt` hook fires with the right `<promise>` outcome regardless of
how the child process winds down.

## Decision

The `<promise>` sentinel is the **canonical agent-authored termination signal**
for the happy path of an attempt: `<promise>DONE</promise>` and
`<promise>BLOCKED</promise>` (plus the outer-loop exhaustion sentinel,
`<promise>NO MORE TASKS</promise>`). Pipe EOF and child-process exit become
**crash detectors** — fallbacks that only matter when the agent failed to
author its own exit.

That canonicality is intentionally scoped to states the agent can author. Some
terminal paths are initiated by the runtime and emit no promise:

- The ADR 0044 attempt progress guard aborts a stalled attempt on `timeout`;
  `processIssue` maps that to `blocked:stalled` and parks the issue for human
  review. A stuck agent cannot reliably emit a `<promise>STALLED</promise>`
  sentinel, so the runtime must own this path.
- The no-sentinel-but-mergeable salvage path repairs a completed branch whose
  work passed feedback even though the agent exited without emitting the
  sentinel. The absence of a promise is the condition being salvaged, not a new
  sentinel outcome.

Concretely:

1. **Read the stream until a `<promise>` token is observed**, not until EOF.
   When `<promise>DONE</promise>`, `<promise>BLOCKED</promise>`, or
   `<promise>NO MORE TASKS</promise>` appears, the orchestrator considers
   the attempt *finished* and proceeds to feedback loops / labelling / outer
   exit — regardless of whether the child process has exited.
2. **After observing the sentinel, give the child a bounded grace period** to
   exit cleanly (e.g. 30s). If it does not, send SIGTERM, then SIGKILL after
   another bounded window. The child losing the pipe is a side effect of
   tearing down a finished attempt, not a precondition for the orchestrator
   to move on.
3. **EOF without a sentinel is `on_attempt_error`.** The pipe closing before
   `<promise>` is emitted means the agent crashed or was killed; the
   orchestrator records the attempt as errored (`on_attempt_error` fires) and
   the issue does not auto-close.
4. **Sentinel without process activity is still a success** — the orchestrator
   does not wait for stdout to quiesce after the sentinel. Anything the runner
   prints after `<promise>` is logged but does not gate the next step.
5. **Runner exhaustion stays out of the sentinel channel.** Rate-limit /
   quota errors (the `RUNNER_EXHAUSTED` signal in `runner-*.md`) are still
   raised the way the runner adapters define them today (parsed from stderr
   or a known string). They are an `on_attempt_error` variant with the
   fallback-runner swap, not a `<promise>` outcome.

## Why

- **The agent is the authority on whether the attempt is done.** It has the
  full view of its own state (commits made, tests passed, blockers
  encountered). Pipe EOF only tells us the kernel closed an fd, which is a
  much weaker statement.
- **Decouples the lifecycle from process behaviour.** A runner that spawns
  a background tail, a watcher, or a long-running stderr stream no longer
  hangs the orchestrator. The orchestrator owns its own tear-down timer.
- **`post_attempt` fires with the right semantics.** Today, if we wired
  `post_attempt` to the EOF moment, a daemonising agent would never fire it.
  Anchoring on the sentinel makes the hook contract honest.
- **Crash detection still works.** EOF-without-sentinel is a clean, narrow
  signal: the agent never authored an end state, so something went wrong.
  `on_attempt_error` is exactly the right hook for that case.
- **Bounded grace prevents new hang shapes.** A naïve "stop reading at
  `<promise>`" without a tear-down timer would leak child processes. The
  bounded SIGTERM / SIGKILL sequence keeps system-level cleanliness while
  the *decision* stays sentinel-driven.
- **Aligns with ADR 0026's interceptor model.** The lifecycle hooks already
  receive a typed event with mutable context; making the exit signal explicit
  removes the implicit "pipe closed = success" rule that no hook can see or
  intercept.

## Rejected alternatives

- **Keep EOF as the exit signal and ban background work in runners.**
  Rejected. It is brittle (runner authors don't read AFK's contract), it
  conflates "agent is done" with "all subprocesses are done," and it loses
  the `on_attempt_error` signal entirely (a crash and a daemon look the same).
- **Treat the sentinel as advisory and still wait for EOF.** Rejected. This
  is the current behaviour and it allows the daemonising-agent hang the
  decision is meant to fix. Anything advisory is, in practice, ignored.
- **Use an explicit IPC channel (Unix socket / named pipe) instead of grepping
  stdout.** Rejected for now. Stronger separation, but it requires every
  runner adapter to learn a new channel and breaks the "the agent's normal
  output declares its own end" property. Revisit if the sentinel turns out
  to be ambiguous in practice (e.g. agent quoting itself in a comment).
- **Promote the sentinel into a structured envelope on stdout (JSON line).**
  Rejected for the first cut. The current sentinel is already a near-unique
  token; upgrading the format is independent of the *when does the attempt
  end* decision and can land later.
- **Make the bounded grace period configurable per runner.** Rejected as
  premature. A fixed 30s/SIGTERM-then-SIGKILL window covers the observed
  cases; the only reason to make it configurable is a runner we don't have
  yet.

## Consequences

- AFK's inner-agent loop (`scripts/afk.sh` + `lib/`) changes its read model
  from "drain to EOF" to "read until `<promise>` token, then tear down."
  The exact location is the per-issue dispatch path, not the outer loop.
- A new utility (call it `lib/attempt-reader.sh`) owns the stream read +
  sentinel detection + bounded tear-down. The runner adapters call into
  it instead of their own ad-hoc loops.
- `post_attempt` (ADR 0026, amended) receives the parsed sentinel outcome
  (`done` / `blocked` / `no_more_tasks`) in its mutable context. Today's
  call site that fires once the child exits moves to firing once the
  sentinel is observed.
- `on_attempt_error` fires for: EOF-without-sentinel, child process killed by
  signal, `RUNNER_EXHAUSTED` from the runner adapter, or the bounded
  tear-down window expiring (child wouldn't die cleanly).
- Sentinel-after-DONE printing is logged but doesn't gate anything. The
  attempt log captures it for forensic review.
- Tests under `scripts/tests/` for the AFK harness gain a case for the
  daemonising-agent scenario (sentinel emitted, child holds pipe open,
  orchestrator moves on within the grace window).
- The Memory plugin's `attempt.hooks` field (shipped via #216) maps cleanly:
  one `pre_attempt` and one `post_attempt` per runner invocation, with the
  sentinel outcome on `post_attempt`. Daemonising-agent attempts no longer
  appear in memory as "ran forever."
- No change to the agent prompt — `AGENT-PROMPT.md` already instructs the
  agent to emit `<promise>…</promise>` at the end of the attempt. The
  orchestrator just starts trusting that contract.
- Codex / Claude parity: both runners emit the same sentinel; both pipes
  behave the same under tear-down. No runner-specific divergence introduced.

## Related

- ADR 0044 — AFK attempt progress guard (`timeout` routes to
  `blocked:stalled` without requiring an agent-authored sentinel).
