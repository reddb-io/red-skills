# AFK liveness: heartbeat + solo-run stall protection (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> How a running worker signals it is alive and how a hung inner agent is caught. Bundle-internal; the agent does not drive these.

## Heartbeat (local-only, post-Slice-D)

The issue-thread heartbeat (`:one:` / `:two:` / `:three:` / `:four:` cycling every 10 minutes via `gh issue comment`) was removed in Slice D. The issue thread is now timeline-only: boot stamp, attempt envelopes, human guidance, closing envelope. No periodic noise.

Local liveness is signalled by:

- **Inner-agent stream**, captured by sandcastle (drained to the attempt dir's `sandcastle.log` via the `logging.path` lane) and surfaced through the `onAgentStreamEvent` callback AFK forwards into `afk.log` + the JSONL lanes — forensic inspection of a running worker tails these files.
- **Clean agent lane + firehose** (issue #250) — alongside `afk.log`, the runtime fans each assistant turn out to a clean single-writer `agent.log.jsonl` (one `type=agent` record per turn, nothing synthetic — the true liveness signal, readable as a live transcript with `tail -f … | jq -r .msg`) and to a `log.jsonl` firehose that also carries the heartbeat vitals, hook dispatches, runner timings, and errors in the uniform JSONL envelope. The heartbeat writes its vitals to the firehose as a `type=heartbeat` record but never to the agent lane, so the agent lane's silence is real silence (the masking that defeated stall/reaper detection in #243). `afk.log` is unchanged and still carries the tee'd stdout + heartbeat lines below.
- **State-file mtime**, bumped on every state update. The monitor combines orchestrator pid liveness with state-file freshness to render `🟢 live` vs `🟡 stale`.
- **Iteration boundary markers** — `heartbeat_start` / `heartbeat_stop` write a single `[heartbeat] iteration started/stopped` line each to `afk.log` so forensic readers can see when an iteration entered and left the inner-agent stage.
- **Periodic orchestrator heartbeat** (issue #194) — `heartbeat_start` also spawns a side-channel sub-shell that appends one line every `RED_AFK_HEARTBEAT_S` (default 60s) to `afk.log`:

  ```
  [heartbeat] stage:tests t+00:14:02 last_stream_line="..." cpu=12% rss=420M
  ```

  The loop re-reads `current.stage` and `current.last_stream_line` from `afk.state.json` on every tick (so a mid-iteration stage flip shows up in the next heartbeat) and reads cpu/rss from `ps` against the orchestrator pid. Because it lives in its own sub-shell — independent of the inner-agent stream tee that buffers inside the runner pipeline — a forcibly hung worker (`kill -STOP` on the inner agent, or a runner that never flushes) still produces one heartbeat line per minute with stage frozen and wall-clock advancing. The `no-sentinel` envelope's `data-section=log` carries these lines, so the issue thread alone is enough to diagnose where the hang occurred. Set `RED_AFK_HEARTBEAT_S=0` to disable the periodic loop (boundary markers still fire).

The terminal header has its own independent 3 s redraw tick — see *Live Header* below. It is unrelated to (and survives the removal of) the GitHub-thread heartbeat.

**Deprecated state fields.** `current.heartbeat_glyph` and `current.heartbeat_pid` are kept as `null` for one release window so older monitors don't error on read; they are no longer written meaningfully and may be removed in a future release.

## Solo-run stall protection (issues #400, #363)

A solo `/afk run` worker is protected against a hung inner agent by **two complementary in-process layers**, both armed only under no-sandbox isolation (under docker/podman the agent commits and builds in an isolated copy the host can't see, so both guards stand down and only the per-iteration idle timeout + max-iterations apply):

- **Attempt progress guard (#400, commit-anchored).** Polls the worker branch HEAD on the attempt-guard cadence and **aborts the run when no NEW commit lands within `RED_AFK_ATTEMPT_TIMEOUT_S` (default 2700s)**, resetting the deadline on every commit. This catches the *productive-looking infinite loop* — an agent that is busy and emitting output but never converging on work. The abort maps to the `timeout` outcome → `blocked:stalled`, `ready-for-human`, PR/worktree preserved. It is the backstop for the fatal "hang forever" case (applies solo and fleet) and is the **progress** signal — never duplicated by the layer below.
- **Lane-idle reaper (#363, idle-anchored).** The solo-path port of Fleet Mode's passive stall detector + hard stall reaper, reusing the SAME fleet detector (`computeStalled`) and reaper-signal busy-predicate (`deriveSnapshot` + `decideReaperSignal`) — not a second mechanism. It samples the active attempt's **agent lane** `agent.log.jsonl` mtime (the clean liveness signal — never `afk.log` / the firehose `log.jsonl`, which the per-minute heartbeat keeps fresh and would mask a real stall, the #243 masking) every `RED_AFK_STALL_POLL_S` (default 30s) on a side-channel poll independent of the inner-agent stream, so a fully-hung runner is still observed. A worker alive ≥ `RED_AFK_STALL_THRESHOLD_S` (default 600s) whose agent lane has been idle ≥ the same is a **candidate**; once the lane is idle past `RED_AFK_STALL_KILL_THRESHOLD_S` (default 1800s) the irreversible kill is **gated behind the busy-predicate** — a worker with an active `vitest`/`tsc`/`cargo`/build descendant under its process tree, or non-trivial aggregate cpu, is **busy** and left alone, while a genuinely stuck worker [idle past the threshold, no active descendant, flat cpu] is reaped tree-wide (SIGTERM then SIGKILL after the grace). The reap aborts the run → `no-sentinel`, which flows through the existing no-sentinel terminal policy (envelope with the attempt-dir `afk.log` tail, label rotated back to `ready-for-agent`/`ready-for-human`, worktree dropped). This is the **faster idle layer**: it cuts an idle hang at the stall threshold (minutes) rather than only at the progress cap. `RED_AFK_STALL_KILL_THRESHOLD_S` must be strictly greater than `RED_AFK_STALL_THRESHOLD_S`, validated at boot (the same invariant the supervisor enforces) — a `<=` config fails fast before the run claims an issue.

The two layers share the run's `AbortController`: progress watches commits, lane-idle watches the agent lane. The threshold env vars (`RED_AFK_STALL_THRESHOLD_S`, `RED_AFK_STALL_KILL_THRESHOLD_S`, `RED_AFK_STALL_POLL_S`) are consistent with Fleet Mode.

