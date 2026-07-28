# AFK liveness: heartbeat + solo-run stall protection (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> How a running worker signals it is alive and how a hung inner agent is caught. Bundle-internal; the agent does not drive these.

## Heartbeat (local-only, post-Slice-D)

The issue-thread heartbeat (`:one:` / `:two:` / `:three:` / `:four:` cycling every 10 minutes via `gh issue comment`) was removed in Slice D. The issue thread is now timeline-only: boot stamp, attempt envelopes, human guidance, closing envelope. No periodic noise.

Local liveness is signalled by:

- **Inner-agent stream**, captured by sandcastle whose `logging.path` lane is pointed at the worker dir's **`afk.log`** (the one unified human log — no separate `sandcastle.log`), and surfaced through the `onAgentStreamEvent` callback AFK forwards into the JSONL lanes — forensic inspection of a running worker tails this file. Because red-castle's file-log IS `afk.log`, the setup phase it narrates (worktree / sandbox / deps) lands there too, so the log is never empty before the agent streams; the plaintext `[agent]` mirror is dropped so turns are not doubled.
- **Clean agent lane + firehose** (issue #250) — alongside `afk.log`, the runtime fans each assistant turn out to a clean single-writer `agent.log.jsonl` TOONL lane (one `type=agent` record per turn, nothing synthetic — the true liveness signal, readable as a live transcript with `tail -f … | tq -p toonl -o json -r .msg`) and to a `log.jsonl` firehose that also carries the heartbeat vitals, hook dispatches, runner timings, and errors in the uniform envelope. `tq` is a pinned required host binary, so there is no jq fallback for reading RedSkills-owned TOONL lanes. The heartbeat writes its vitals to the firehose as a `type=heartbeat` record but never to the agent lane, so the agent lane's silence is real silence (the masking that defeated stall/reaper detection in #243). `afk.log` now carries red-castle's unified stream (setup narration + agent text/tools) plus the `[heartbeat]` lines.
- **Fleet supervisor firehose** — the supervisor's shared live lane at `.red/tmp/supervisors/default/supervisor.log.toonl` is written as append-only TOONL records with an honest extension. A one-time boot migration moves the legacy structured firehose copies out of `.red/tmp/` / `.red/state/afk/` / `.red/state/castle/`. Tail heartbeat messages with `tail -f .red/tmp/supervisors/default/supervisor.log.toonl | tq -p toonl -o json -r .msg`. Readers sniff each row, so older JSONL rows and mixed legacy+TOONL files remain readable; history is never rewritten.
- **Monitor activity counters** — compact `/afk monitor --once` renders the canonical WorkerVitals activity group (`tools:<n> reason:<n> text:<n> wait:<n>`) and a cursor-backed `afk.log` line count (`log:<total>(+<new>)`). These are tie-breakers for the common "quiet but pid-live" case: agent-lane silence alone must not mark a Worker done while the orchestrator pid is still alive.
- **State-file liveness verdict**, derived once by the Worker state reader. The monitor pairs the orchestrator `pid` with `pid_start_time` when the platform exposes a stable process-start token, so a recycled PID does not resurrect a finished worker. It then combines pid identity with activity freshness to render `[live]` (pid identity matches + recent activity), `[quiet]` (pid identity matches, agent lane quiet), or `[stale]` (pid dead/identity mismatch).
- **Iteration boundary markers** — `heartbeat_start` / `heartbeat_stop` write a single `[heartbeat] iteration started/stopped` line each to `afk.log` so forensic readers can see when an iteration entered and left the inner-agent stage.
- **Periodic orchestrator heartbeat** (issue #194) — `heartbeat_start` also spawns a side-channel sub-shell that appends one line every `RED_AFK_HEARTBEAT_S` (default 60s) to `afk.log`:

  ```
  [heartbeat] stage:tests t+00:14:02 last_stream_line="..." cpu=12% rss=420M
  ```

  The loop re-reads `current.stage` and `current.last_stream_line` from `afk.state.json` on every tick (so a mid-iteration stage flip shows up in the next heartbeat) and reads cpu/rss from `ps` against the orchestrator pid. Because it lives in its own sub-shell — independent of the inner-agent stream tee that buffers inside the runner pipeline — a forcibly hung worker (`kill -STOP` on the inner agent, or a runner that never flushes) still produces one heartbeat line per minute with stage frozen and wall-clock advancing. The `no-sentinel` envelope's `data-section=log` carries these lines, so the issue thread alone is enough to diagnose where the hang occurred. Set `RED_AFK_HEARTBEAT_S=0` to disable the periodic loop (boundary markers still fire).

The terminal header has its own independent 3 s redraw tick — see *Live Header* below. It is unrelated to (and survives the removal of) the GitHub-thread heartbeat.

**Deprecated state fields.** `current.heartbeat_glyph` and `current.heartbeat_pid` are kept as `null` for one release window so older monitors don't error on read; they are no longer written meaningfully and may be removed in a future release.

## Solo-run stall protection (issue #363)

**There is exactly one stall authority: the castle liveness lane + evaluator.** ADR 0103 removed the attempt-progress guard — the commit-anchored wall-clock cap, the hard cap, and the edit-loop-stall abort are gone, and `runAgent` no longer arms anything of the sort. A busy-but-unproductive agent is no longer killed on a commit deadline; a genuinely *silent* one still is, by the layer below (solo) and by the fleet supervisor's reaper (fleet), both reading the same `LivenessVerdict`. Worker vitals (loc, tokens, tool/text/reasoning counters) ride an independent ~20s sampler and are unaffected by the removal.

The solo `/afk run` worker's in-process layer is armed only under no-sandbox isolation (under docker/podman its busy-predicate inspects the HOST process tree, which cannot see an agent inside a container, so it stands down and only the per-iteration idle timeout + max-iterations apply):

- **Lane-idle reaper (#363, idle-anchored).** The solo-path port of Fleet Mode's passive stall detector + hard stall reaper, reusing the SAME fleet detector (`computeStalled`) and reaper-signal busy-predicate (`deriveSnapshot` + `decideReaperSignal`) — not a second mechanism. It samples the active attempt's **agent lane** `agent.log.jsonl` mtime (the clean liveness signal — never `afk.log` / the firehose `log.jsonl`, which the per-minute heartbeat keeps fresh and would mask a real stall, the #243 masking) every `RED_AFK_STALL_POLL_S` (default 30s) on a side-channel poll independent of the inner-agent stream, so a fully-hung runner is still observed. A worker alive ≥ `RED_AFK_STALL_THRESHOLD_S` (default 600s) whose agent lane has been idle ≥ the same is a **candidate**; once the lane is idle past `RED_AFK_STALL_KILL_THRESHOLD_S` (default 1800s) the irreversible kill is **gated behind the busy-predicate** — a worker with an active `vitest`/`tsc`/`cargo`/build descendant under its process tree, or non-trivial aggregate cpu, is **busy** and left alone, while a genuinely stuck worker [idle past the threshold, no active descendant, flat cpu] is reaped tree-wide (SIGTERM then SIGKILL after the grace). The reap aborts the run → `no-sentinel`, which flows through the existing no-sentinel terminal policy (envelope with the attempt-dir `afk.log` tail, label rotated back to `ready-for-agent`/`ready-for-human`, worktree dropped). `RED_AFK_STALL_KILL_THRESHOLD_S` must be strictly greater than `RED_AFK_STALL_THRESHOLD_S`, validated at boot (the same invariant the supervisor enforces) — a `<=` config fails fast before the run claims an issue.

The reaper owns the run's `AbortController` (it constructs one when the ADR 0057 goal predicate has not already). The threshold env vars (`RED_AFK_STALL_THRESHOLD_S`, `RED_AFK_STALL_KILL_THRESHOLD_S`, `RED_AFK_STALL_POLL_S`) are consistent with Fleet Mode.

## Activity-independent wall-clock ceiling (#2286)

**Every cap above is silence-based, so none of them can see a busy attempt that never converges.** An attempt stuck in a self-feeding edit/test loop keeps its liveness lane fresh and its process tree hot, reads `alive` forever, and holds a slot forever. The wall-clock-per-issue ceiling is the age-based twin: once age **since claim** reaches `RED_AFK_ISSUE_WALL_CLOCK_MAX_S` (config `afk.issue_wall_clock_max_s`, default 2700s = 45 min), the evaluator returns `capped`: a status of its own, never `stalled` (#2701), carrying a reason distinct from the silence caps. It is evaluated *before* the lane-freshness, hard-silence, and descendant checks, so no activity signal can veto it.

The ceiling is a **deadline, not a countdown**: the reaper anchors the stall window to the kill threshold on first detection so escalation happens on that same tick, then routes the kill through the unchanged `decideReaperSignal` predicate and the `on_stall_reap` veto hook. A generous default is deliberate — this is a runaway backstop, not a pace-setter. An unknown claim epoch (no attempt state stamp) disables the ceiling rather than guessing an age.

**A cap is not a stall, and its work is not lost (#2701).** Three capped workers were once reported `no-sentinel · stall-reaped` seconds after their own heartbeats logged tool calls and reasoning, and the clean re-queue then sent the next worker to a fresh branch off main — 16 commits, an 852-line push, and an open green PR all redone from scratch. The cap therefore has its own terminal record: envelope status `wall-clock-capped` naming the ceiling it hit, typed label `blocked:wall-clock-capped`, no retry contest, and a hand-forward comment that publishes the attempt's branch **before** the labels rotate and names any open PR as the pending artifact. The next worker adopts that ref instead of starting over; the bounded re-queue budget (`RED_AFK_RETRY_STALLED`) is unchanged, so an issue that never converges still escalates.

## Host-level OOM signature (#1758)

When the worker log, supervisor tick log, and an unrelated interactive operator
session all stop in the same short window, treat it as a host-level kill/OOM
signature, not a worker-code bug. The expected recovery path is:

- relaunch the fleet;
- let the boot sweep reconcile any dangling `running` claims and stale slots;
- inspect the preserved pushed `afk/*` branch before deciding whether work was
  lost.

Heavy validation suites are bounded by `afk.validation.*` config: validation
subprocesses receive a Node heap cap and Vitest worker cap, and known-heavy
validation admission serializes when another heavy validation is already active
or when available memory is below the configured threshold. On small reference
machines, keep the default `vitest_max_workers: 1` and avoid raising fleet width
without also raising the per-host memory budget.
