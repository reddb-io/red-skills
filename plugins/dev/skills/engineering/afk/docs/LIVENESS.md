# AFK liveness: heartbeat + solo-run stall protection (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> How a running worker signals it is alive and how a hung inner agent is caught. Bundle-internal; the agent does not drive these.

## Heartbeat (local-only, post-Slice-D)

The issue-thread heartbeat (`:one:` / `:two:` / `:three:` / `:four:` cycling every 10 minutes via `gh issue comment`) was removed in Slice D. The issue thread is now timeline-only: boot stamp, attempt envelopes, human guidance, closing envelope. No periodic noise.

Local liveness is signalled by:

- **Worker log**, `.red/tmp/workers/{id}/worker.log.toonl`, receives lifecycle, daemon-framed stdout/stderr, setup and agent narration, iteration markers, waits, and heartbeat messages. Every prose payload is one structured `msg`, so `tail -f` remains useful without a plain-text mirror. The retired `afk.log`, `agent.log.toonl`, and `log.toonl` lanes are not reader choices.
- **Protected liveness anchor**, `{issue}/liveness.toonl`, is the evaluator/reaper input. It remains separate precisely so narration and periodic log heartbeats cannot manufacture proof of life. `validation.jsonl` likewise remains separate as a gate artifact rather than a log.
- **Fleet supervisor firehose** — the supervisor's shared live lane at `.red/tmp/supervisors/default/supervisor.log.toonl` is written as append-only TOONL records with an honest extension. A one-time boot migration moves the legacy structured firehose copies out of `.red/tmp/` / `.red/state/afk/` / `.red/state/castle/`. Tail heartbeat messages with `tail -f .red/tmp/supervisors/default/supervisor.log.toonl | tq -p toonl -o json -r .msg`. Readers sniff each row, so older JSONL rows and mixed legacy+TOONL files remain readable; history is never rewritten.
- **Monitor activity counters** — compact `/afk monitor --once` renders the canonical WorkerVitals activity group (`tools:<n> reason:<n> text:<n> wait:<n>`) and a cursor-backed `worker.log.toonl` line count (`log:<total>(+<new>)`).
- **State-file liveness verdict**, derived once by the Worker state reader. The monitor pairs the orchestrator `pid` with `pid_start_time` when the platform exposes a stable process-start token, so a recycled PID does not resurrect a finished worker. It then combines pid identity with activity freshness to render `[live]` (pid identity matches + recent activity), `[quiet]` (pid identity matches, agent lane quiet), or `[stale]` (pid dead/identity mismatch).
- **Iteration boundary markers** — iteration start/stop are structured records in `worker.log.toonl`, so forensic readers see when the inner-agent stage was entered and left.
- **Periodic orchestrator heartbeat** (issue #194) — the side-channel appends one `worker.heartbeat` record every `RED_AFK_HEARTBEAT_S` (default 60s) to `worker.log.toonl`:

  ```
  [heartbeat] stage:tests t+00:14:02 last_stream_line="..." cpu=12% rss=420M
  ```

  The loop re-reads `current.stage` and `current.last_stream_line` from `afk.state.json` on every tick (so a mid-iteration stage flip shows up in the next heartbeat) and reads cpu/rss from `ps` against the orchestrator pid. Because it lives in its own sub-shell — independent of the inner-agent stream tee that buffers inside the runner pipeline — a forcibly hung worker (`kill -STOP` on the inner agent, or a runner that never flushes) still produces one heartbeat line per minute with stage frozen and wall-clock advancing. The `no-sentinel` envelope's `data-section=log` carries these lines, so the issue thread alone is enough to diagnose where the hang occurred. Set `RED_AFK_HEARTBEAT_S=0` to disable the periodic loop (boundary markers still fire).

The terminal header has its own independent 3 s redraw tick — see *Live Header* below. It is unrelated to (and survives the removal of) the GitHub-thread heartbeat.

**Deprecated state fields.** `current.heartbeat_glyph` and `current.heartbeat_pid` are kept as `null` for one release window so older monitors don't error on read; they are no longer written meaningfully and may be removed in a future release.

## Solo-run stall protection (issue #363)

**There is exactly one stall authority: the Worker's liveness lane + evaluator** (`@reddb-io/worker`, renamed from red-castle by ADR 0153). ADR 0103 removed the attempt-progress guard — the commit-anchored wall-clock cap, the hard cap, and the edit-loop-stall abort are gone, and `runAgent` no longer arms anything of the sort. A busy-but-unproductive agent is no longer killed on a commit deadline; a genuinely *silent* one still is, by the layer below (solo) and by the daemon's reaper, both reading the same `LivenessVerdict`. Worker vitals (loc, tokens, tool/text/reasoning counters) ride an independent ~20s sampler and are unaffected by the removal.

The solo `/afk run` worker's in-process layer is armed only under no-sandbox isolation (under docker/podman its busy-predicate inspects the HOST process tree, which cannot see an agent inside a container, so it stands down and only the per-iteration idle timeout + max-iterations apply):

- **Lane-idle reaper (#363, idle-anchored).** The solo path reuses the fleet detector and reaper-signal busy predicate. It samples the protected `liveness.toonl` anchor every `RED_AFK_STALL_POLL_S` (default 30s), never the Worker log whose periodic heartbeat must remain readable without masking a stall. A Worker silent past the soft threshold becomes a candidate; past the hard threshold it is reaped only when no active build/test descendant and no meaningful CPU signal says it is busy. The failure envelope takes its readable tail from `worker.log.toonl`.

The reaper owns the run's `AbortController` (it constructs one when the ADR 0057 goal predicate has not already). The threshold env vars (`RED_AFK_STALL_THRESHOLD_S`, `RED_AFK_STALL_KILL_THRESHOLD_S`, `RED_AFK_STALL_POLL_S`) are consistent with Fleet Mode.

## Activity-independent wall-clock ceiling (#2286)

**Every cap above is silence-based, so none of them can see a busy attempt that never converges.** An attempt stuck in a self-feeding edit/test loop keeps its liveness lane fresh and its process tree hot, reads `alive` forever, and holds a slot forever. The wall-clock-per-issue ceiling is the age-based twin: once age **since claim** reaches `RED_AFK_ISSUE_WALL_CLOCK_MAX_S` (config `afk.issue_wall_clock_max_s`, default 2700s = 45 min), the evaluator returns `capped`: a status of its own, never `stalled` (#2701), carrying a reason distinct from the silence caps. It is evaluated *before* the lane-freshness, hard-silence, and descendant checks, so no activity signal can veto it.

The ceiling is a **deadline, not a countdown**: the reaper anchors the stall window to the kill threshold on first detection so escalation happens on that same tick, then routes the kill through the unchanged `decideReaperSignal` predicate and the `on_stall_reap` veto hook. A generous default is deliberate — this is a runaway backstop, not a pace-setter. An unknown claim epoch (no attempt state stamp) disables the ceiling rather than guessing an age.

**A cap is not a stall, and its work is not lost (#2701).** Three capped workers were once reported `no-sentinel · stall-reaped` seconds after their own heartbeats logged tool calls and reasoning, and the clean re-queue then sent the next worker to a fresh branch off main — 16 commits, an 852-line push, and an open green PR all redone from scratch. The cap therefore has its own terminal record: envelope status `wall-clock-capped` naming the ceiling it hit, typed label `blocked:wall-clock-capped`, no retry contest, and a hand-forward comment that publishes the attempt's branch **before** the labels rotate and names any open PR as the pending artifact. The next worker adopts that ref instead of starting over; the bounded re-queue budget (`RED_AFK_RETRY_STALLED`) is unchanged, so an issue that never converges still escalates.

## Per-worker resource budgets (#2707)

**The wall-clock ceiling above is one budget of three.** The supervisor measures
what every worker consumes — wall clock, peak RSS across its process tree, and
reported cost. `afk.attempt.budget.peak_rss_mb` and `afk.attempt.budget.cost_usd`
add the two ceilings nothing else watches; both default to `unlimited`, so an
unconfigured repo enforces today's behaviour and pays no sampling cost. Memory is
sampled from **one** process-table read per tick, so the accounting does not
scale with the number of workers.

A budgeted termination is a THIRD outcome, distinct from a stall and from a clean
finish, and it **names the budget** (`wall_clock_s` | `peak_rss_mb` |
`cost_usd`). It publishes its branch and names any open PR before the labels
rotate, exactly like the cap, so the retry adopts the work instead of restarting
from main. Memory and cost breaches page a human (`blocked:budget`) rather than
blind-retrying, because re-running a runaway just re-spends the budget.

The durable per-attempt record these numbers were also written into is gone
(Spec #2772): a Worker already is one Worker × one Ticket × one try, so the
record was a second copy of what the issue thread and git already say. The
budget's own comment on the issue is where a budgeted termination is read.

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
