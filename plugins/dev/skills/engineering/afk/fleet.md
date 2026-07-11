# AFK Fleet Mode — running `afk fleet` (multi-worker supervisor)

This file serves the `afk fleet` branch: launching, stopping, and supervising `N`
concurrent `run` workers on one checkout. Reached from *When To Use*
(`/afk fleet [N]`, `/afk fleet stop`) in [`SKILL.md`](./SKILL.md).

## Fleet Mode (runner-portable — binding)

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are the user-facing fleet commands. They let one terminal command spin up (or shut down) `N` concurrent `run` workers on the current checkout, with the supervisor handling respawn, the circuit breaker, the **passive stall detector** (samples each slot's per-attempt **agent lane** `agent.log.jsonl` mtime — the clean liveness signal — every `RED_AFK_STALL_POLL_S=30s`; flags any slot alive ≥ `RED_AFK_STALL_THRESHOLD_S=600` whose agent lane has been idle ≥ the same — surfaces as `⏸️ stalled` in `/dev:afk monitor`. It keys off the agent lane, never `afk.log`/`log.jsonl`, because the orchestrator heartbeat writes those every minute and would mask a real stall — the masking that defeated detection in #243), the **hard stall reaper** (a slot silent on the agent lane past `RED_AFK_STALL_KILL_THRESHOLD_S=1800` is only a *candidate*: the irreversible kill is gated behind a reaper-signal predicate, so a worker mid-build/test — an active `vitest`/`tsc`/`cargo`/… descendant under its tree, or non-trivial aggregate cpu — is **busy** and left alone, while a genuinely stuck worker [idle past the threshold, no active descendant, flat cpu] is killed tree-wide, a `data-attempt-status="no-sentinel"` envelope is posted with the attempt-dir `afk.log` tail, the issue label is rotated back to `ready-for-agent`, the worktree + attempt dir are removed, and the slot is freed for the next health-check respawn — `RED_AFK_STALL_KILL_THRESHOLD_S` must be strictly greater than `RED_AFK_STALL_THRESHOLD_S`, validated at supervisor boot), and per-slot build isolation.

**Worker env passthrough.** Any `RED_AFK_*` variable exported in the operator's shell before `/dev:afk fleet` is auto-forwarded to every worker the supervisor spawns. Use this for worker-side toggles like `RED_AFK_SKIP_PERF=1` or `RED_AFK_SKIP_COMPETITIVE_BASELINE=1` without writing a hook. Internal supervisor knobs (`RED_AFK_TARGET`, `RED_AFK_POLL_S`, `RED_AFK_STALL_*`, `RED_AFK_CIRCUIT_*`, `RED_AFK_RUNNER`, `RED_AFK_REQUEST`, `RED_AFK_PLUGIN_DIR`) and the per-slot `*_BASE` build-isolation vars are excluded — they have dedicated wiring and the supervisor denylists them from passthrough. The supervisor re-pins `RED_AFK_RUNNER=<runner>` for each worker.

```bash
$ export RED_AFK_SKIP_PERF=1
$ export RED_AFK_SKIP_COMPETITIVE_BASELINE=1
$ /dev:afk fleet 1   # every worker sees both vars
```

Fleet mode is **runner-portable**: the supervisor is plain process orchestration, not a Claude Code primitive. Claude Code, Codex, and bare terminals may all launch and stop the supervisor when the normal AFK hard preconditions pass. Runner-specific observability degrades independently:

- Claude Code: launch fleet. For manual monitoring, run `/dev:afk monitor` or tail `.red/tmp/afk-supervisor.log`.
- Codex: launch fleet with `RED_AFK_RUNNER=codex` and spawn one read-only Codex monitor agent from the bundle's `codex-monitor-agent --mode fleet` prompt when a sub-agent primitive is available. If no sub-agent primitive is available, launch fleet anyway and print `monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.`
- Bare terminal / unknown runner: launch fleet and print the manual-monitor guidance.

### `/dev:afk fleet [N]` — launch

`N` is optional and defaults to `2`. Parse it as a non-negative integer; reject anything else (including `stop`, which is the other subcommand and routes below). Steps the agent must perform, in order:

1. **Resolve runner.** Determine the active runner using the same intent as the normal AFK cascade: explicit user `--runner` if present, else `RED_AFK_RUNNER`, else runner env/process/path signals, else `claude`. The resolved value is carried into the supervisor as `RED_AFK_RUNNER=<runner>` so detached workers do not fall through to the supervisor's historical `claude` fallback. Under Codex, this must resolve to `codex`.
2. **PID-file pre-check.** Read `.red/tmp/afk-supervisor.pid`. If it exists and `kill -0 <pid>` succeeds, refuse the launch:
   ```
   ✗ fleet already running (supervisor pid=<pid>, log .red/tmp/afk-supervisor.log).
     to stop it: /dev:afk fleet stop
   ```
   Do **not** touch the file or attempt to recover. A stale PID file (file exists but `kill -0` fails) is left alone — the `fleet` command clears it itself when it acquires the supervisor lock.
3. **Launch the fleet.** From the project root, run the bundle's `fleet` command with the target and any flags:
   ```bash
   RED_AFK_RUNNER=<runner> red-skills-dev fleet <N> [--request <text>]
   ```
   The command performs the PID-file pre-check from step 2 itself (refusing if a live supervisor already runs), detaches the supervisor, and forwards the resolved runner and the `--request/-r` text to every worker it spawns. It waits up to 3 s for `.red/tmp/afk-supervisor.pid` to appear and contain a live PID, then prints the launched supervisor PID and target; on failure it reports the tail of `.red/tmp/afk-supervisor.log`. Capture the reported PID for the *Report back* step. The launched supervisor is the native `__supervise` entrypoint of the same bundle.
4. **Attach the best available monitor surface.**
   - Claude Code: no automatic monitor cron. Tell the user to run `/dev:afk monitor` manually or tail `.red/tmp/afk-supervisor.log`.
   - Codex: fetch a sub-agent spawn primitive via `ToolSearch` (query: `spawn agent background monitor`). If available, emit the canonical prompt with `RED_AFK_RUNNER=codex red-skills-dev codex-monitor-agent --project-root "$PWD" --mode fleet` and spawn exactly one read-only Codex monitor agent for this newly-launched supervisor. Its task: from the project root, periodically run `/dev:afk monitor --once` (the bundle's `monitor --once`), report concise progress, and auto-close when `.red/tmp/afk-supervisor.pid` is missing/dead and no `[live]` workers remain. It must never edit files, claim issues, stop workers, or run merges. The user may close it manually; workers continue. If the primitive is unavailable, skip and use the manual-monitor line.
   - Bare/unknown: skip native monitor setup and use the manual-monitor line.
5. **Report back.** Print:
   ```
   🚀 fleet launched (supervisor pid=<pid>, target=<N>)
      log:   .red/tmp/afk-supervisor.log
      stop:  /dev:afk fleet stop
      <monitor-status-line>
   ```
   Monitor status line choices:
   - Claude Code: `monitor: run /dev:afk monitor or tail .red/tmp/afk-supervisor.log`
   - Codex monitor agent spawned: `Codex monitor agent spawned — auto-closes when fleet exits; manual monitor: /dev:afk monitor.`
   - Codex monitor unavailable: `monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.`
   - Bare/unknown: `monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.`

### `/dev:afk fleet stop` — graceful shutdown

Steps, in order:

1. **Liveness check.** Read `.red/tmp/afk-supervisor.pid`. The three cases:
   - File missing → print `no fleet running.` and continue to step 3 (still try runner-specific monitor teardown).
   - File present but `kill -0` fails → stale. Print `no fleet running (stale pid file at .red/tmp/afk-supervisor.pid — cleaning).`, `rm -f` it, and continue to step 3.
   - File present and PID alive → continue to step 2.
2. **Touch the stop file.** `touch .red/tmp/afk-supervisor.stop`. The supervisor's health-check cycle (default `RED_AFK_POLL_S=15s`) picks it up and runs `cleanup`, which SIGTERMs every worker, removes the PID file, removes the stop file, and exits. Wait up to **30 s** for the PID file to disappear (poll every 1 s, deadline-bounded — never bare `while`). If it's gone, print `🛑 fleet stopped (supervisor pid=<pid> exited).`. If the deadline trips, print one warning line naming the PID and the log path, and continue to step 3 anyway — the stop file is still there and the supervisor will pick it up eventually.
3. **Tear down runner-specific monitors.**
   - Claude Code: no automatic monitor cron to cancel. Print `no auto-monitor cron (manual monitoring only).`
   - Codex: do not stop workers through the monitor agent. It auto-closes when it observes no supervisor/live workers, and the user may close it manually. Print `Codex monitor agent will self-close when it observes fleet stopped.`
   - Bare/unknown: print `no native monitor teardown for this runner.`
4. **Idempotency.** Re-running `/dev:afk fleet stop` after a successful stop just hits the "file missing" branch in step 1 and the runner-specific teardown no-op in step 3. Exit 0 either way.

### Circuit Trip Sweep

When the circuit breaker parks a slot (`CIRCUIT_K` fast deaths inside `CIRCUIT_WINDOW_S`) the supervisor — not a human — runs `sweep_parked_slot` to clean up after the burned workers. Three actions, in order, gated on the trip:

1. **Sweep affected attempt dirs.** From the slot log (`afk-supervisor-slot-{slot}.log`) the supervisor parses every `[afk] worker: w…` boot stamp emitted while the slot was alive, globs `.red/tmp/workers/{wid}/*/` for each ID, and reads `afk.state.json`'s `.current.number` to identify the affected issues. Each attempt dir is `rm -rf`'d after its issue has been processed.
2. **Post a discard envelope on each affected issue.** Same `<details data-attempt-status="…">` schema as the per-issue terminal envelope, with `status="discarded"` and a summary line that names the runner and the trip cause (`runner-broken, slot parked after K fast deaths`). The envelope's `data-section="summary"` block carries the slot index, comma-joined worker IDs, fast-death count, and the supervisor log path. No `notes`, `drop`, or `log` sections — the attempts produced no usable artefacts.
3. **Restore label state on each affected issue.** Single `gh issue edit` adds `ready-for-agent` and `runner-error`, removes `ready-for-human` and (defensively) `running` — covers both the "issue had already been promoted to `ready-for-human`" path and the "issue was still `running` at the moment of trip" path.

The `runner-error` label is created idempotently by `/red-setup` (see [triage-labels.md](../red-setup/triage-labels.md)). The supervisor still calls `gh label create runner-error` on the fly during a trip so cleanup never fails just because the label is missing.

Idempotency: `SLOT_SWEPT[slot]=1` blocks a second sweep within the same supervisor lifetime. Across restarts a new trip yields fresh worker IDs and fresh attempt dirs, so re-tripping never re-touches the previously swept issues. A trip that finds no claimed issues (all workers exited before claiming) parks the slot but posts no envelopes — the attempt-dir sweep is a no-op.

## Fleet Width by Disjunction

The safe fleet width for a given queue is the **degree of disjunction** — the maximum number of concurrently `ready-for-agent` slices that touch non-overlapping file sets.

- **Disjoint queue** (each slice writes to files no other ready slice touches): run the full fleet. `fleet 4` is safe when the queue has four independent file cones.
- **Partially entangled queue**: lower the fleet width to the number of disjoint groups. If two groups of two slices each are independent between groups but internally serialized via `req:N`, `fleet 2` drains both chains in parallel without risk.
- **Fully entangled refactor** (every slice touches shared files, serialized via `req:N`): run `fleet 1` or bare `/afk`. Parallel workers share no ready-for-agent work at any moment — extra slots sit idle and raise the risk of a spurious merge conflict should a `req:N` edge be missing.

**Rule: fleet width = degree of disjunction.** Raise it when the queue is disjoint; lower it to `fleet 1` when slices are entangled. The `/to-tickets` slicing skill is responsible for expressing file-level dependencies as `req:N` edges before the queue is published, so a correctly-sliced backlog never produces a file-overlap merge conflict from concurrent workers.

### Refs

- The bundle's `fleet` / `fleet stop` commands — the entrypoints this section drives. Stop-file path, env contract, circuit breaker, and trip-sweep are part of the supervisor behaviour described above.
- [`monitor.md`](./monitor.md) — the readonly dashboard and native-task mirror.
