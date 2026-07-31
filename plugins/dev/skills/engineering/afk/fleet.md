# AFK Fleet Mode — running `afk fleet` (multi-worker supervisor)

This file serves the `afk fleet` branch: launching, stopping, and supervising `N`
concurrent `run` workers on one checkout. Reached from *When To Use*
(`/afk fleet [N]`, `/afk fleet stop`) in [`SKILL.md`](./SKILL.md).

## Drive this project's workers through the `castle` MCP

**A project has one producer, and the `castle` MCP owns its lifecycle.** The
named fleet is gone (ADR 0130) — with the budget owned host-wide there is nothing
for a name to address and no registry of profiles to keep. The four project tools
are the primary surface; the CLI forms documented below are the fallback
transport for the same operations. Read [`MCP.md`](./MCP.md) for host prefixing
and mutation modes.

| Verb | Tool | Notes |
| --- | --- | --- |
| launch | `project_start` | `{runner, target, selector?, config?, base?}` — hands the work policy to the host daemon as a registration; the project spawns nothing. |
| resize / switch | `project_resize` | Same fields, all optional; sends the live resize directive instead of a second supervisor. |
| ground truth | `project_status` | Supervisor pid, slots, churn, live workers for this project. |
| shutdown | `project_stop` | Gracefully stops this project's supervisor; `force: true` hard-stops only workers attributed to its lane. |
| logs | `logs` | One structured lane per call (`supervisor` / `worker` / `monitor` / `liveness`). |

**The work policy survived the fleet that used to hold it**: runner + work-scope
`selector` (`{spec, lane, label, issues, tags, user}`) + `config` knobs + `base`.
The `tags` facet ANDs over `tag:<value>` labels — a candidate must carry EVERY
requested tag, so an untagged issue is outside every tag-scoped selector; `user`
keeps only issues authored by that GitHub login (`@me` is resolved to a concrete
login before the selector is matched). **Several selectors are an ordered
priority inside ONE producer, never competing loops**: the first selector takes
what it wants and a lower one gets whatever room survives, which is exactly the
property a share-based split would lose. An invocation that still names a fleet
is refused with the replacement named rather than failing internally.

## Fleet Mode (runner-portable — binding)

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are the user-facing fleet commands. They let one terminal command spin up (or shut down) `N` concurrent `run` workers on the current checkout, with the supervisor handling respawn, the circuit breaker, the **passive stall detector** (samples each slot's per-worker **agent lane** `agent.log.jsonl` mtime — the clean liveness signal — every `RED_AFK_STALL_POLL_S=30s`; flags any slot alive ≥ `RED_AFK_STALL_THRESHOLD_S=600` whose agent lane has been idle ≥ the same — surfaces as `⏸️ stalled` in `/dev:afk monitor`. It keys off the agent lane, never `afk.log`/`log.jsonl`, because the orchestrator heartbeat writes those every minute and would mask a real stall — the masking that defeated detection in #243), the **hard stall reaper** (a slot silent on the agent lane past `RED_AFK_STALL_KILL_THRESHOLD_S=1800` is only a *candidate*: the irreversible kill is gated behind a reaper-signal predicate, so a worker mid-build/test — an active `vitest`/`tsc`/`cargo`/… descendant under its tree, or non-trivial aggregate cpu — is **busy** and left alone, while a genuinely stuck worker [idle past the threshold, no active descendant, flat cpu] is killed tree-wide, a `data-attempt-status="no-sentinel"` envelope is posted with the attempt-dir `afk.log` tail, the issue label is rotated back to `ready-for-agent`, the worktree + worker dir are removed, and the slot is freed for the next health-check respawn — `RED_AFK_STALL_KILL_THRESHOLD_S` must be strictly greater than `RED_AFK_STALL_THRESHOLD_S`, validated at supervisor boot), and per-slot build isolation.

**Worker env passthrough.** Any `RED_AFK_*` variable exported in the operator's shell before `/dev:afk fleet` is auto-forwarded to every worker the supervisor spawns. Use this for worker-side toggles like `RED_AFK_SKIP_PERF=1` or `RED_AFK_SKIP_COMPETITIVE_BASELINE=1` without writing a hook. Internal supervisor knobs (`RED_AFK_TARGET`, `RED_AFK_POLL_S`, `RED_AFK_STALL_*`, `RED_AFK_CIRCUIT_*`, `RED_AFK_RUNNER`, `RED_AFK_REQUEST`, `RED_AFK_PLUGIN_DIR`) and the per-slot `*_BASE` build-isolation vars are excluded — they have dedicated wiring and the supervisor denylists them from passthrough. The supervisor re-pins `RED_AFK_RUNNER=<runner>` for each worker.

```bash
$ export RED_AFK_SKIP_PERF=1
$ export RED_AFK_SKIP_COMPETITIVE_BASELINE=1
$ /dev:afk fleet 1   # every worker sees both vars
```

Fleet mode is **runner-portable**: the supervisor is plain process orchestration, not a Claude Code primitive. Claude Code, Codex, and bare terminals may all launch and stop the supervisor when the normal AFK hard preconditions pass. Runner-specific observability degrades independently:

- Claude Code: launch fleet. For manual monitoring, read the castle `monitor` and `project_status` tools; without the MCP, run `/dev:afk monitor` or tail `.red/tmp/supervisors/default/supervisor.log.toonl`.
- Codex: launch fleet with `RED_AFK_RUNNER=codex` and spawn one read-only Codex monitor agent from the bundle's `codex-monitor-agent --mode fleet` prompt when a sub-agent primitive is available. If no sub-agent primitive is available, launch fleet anyway and print the monitor status line below.
- Bare terminal / unknown runner: launch fleet and print the manual-monitor guidance.

**Self-heal is not a monitor side effect.** Every successful fleet launch also
arms one detached watchdog in that fleet's repo-scoped runtime lane. It probes
the exact `afk-supervisor.pid` plus `afk-supervisor.pid.start` identity once per
`RED_AFK_POLL_S` (15 seconds by default), so a same-command supervisor in a
sibling repo and a recycled PID cannot satisfy the liveness check. A dead
supervisor with `ready-for-agent > 0` and live workers below target is relaunched
within one poll window, subject to the existing bounded-restart guard. The new
supervisor boot runs the stale local/cross-host claim reconciliation before
draining again. Every catchable terminal path writes one `supervisor.exit`
record with `reason=signal|exception|explicit-stop|completed`; the process-exit
hook is the synchronous best-effort fallback for exits that bypass the awaited
path. SIGKILL cannot run user-space cleanup, so its retained pinned PID plus the
watchdog recovery record is the forensic signal.

**Release recycle rule.** A fleet supervisor keeps running the exact dev bundle
version it was launched from. After any RedSkills release that changes AFK or
castle engine behavior, stop and relaunch the fleet before starting or counting
a proving drain; otherwise the drain may still be executing on the pre-release
engine. `monitor` and the statusline fleet cell show the running bundle version
and mark skew against a newer locally cached bundle so stale supervisors are
visible. Automatic drain-and-respawn on version change is a future enhancement,
not part of the current fleet contract.

### `/dev:afk fleet [N]` — launch

`N` is optional and defaults to `2`. Parse it as a non-negative integer; reject anything else (including `stop`, which is the other subcommand and routes below). Steps the agent must perform, in order:

1. **Resolve runner.** Determine the active runner using the same intent as the normal AFK cascade: explicit user `--runner` if present, else `RED_AFK_RUNNER`, else runner env/process/path signals, else `claude`. The resolved value is carried into the supervisor as `RED_AFK_RUNNER=<runner>` so detached workers do not fall through to the supervisor's historical `claude` fallback. Under Codex, this must resolve to `codex`.
2. **PID-file pre-check / live directive.** Read `.red/tmp/supervisors/default/afk-supervisor.pid` and its `.pid.start` process-start pin. If the PID is live and the current start token matches, do not launch a second supervisor. Instead the bundle command writes the `afk-supervisor.resize` directive file in the supervisor runtime lane (`.red/tmp/supervisors/default/`) as the live directive:
   - `fleet <N>` changes the desired worker count while keeping the current runner.
   - `fleet <N> --shrink-mode hard-kill|drain-then-retire` changes the resize shrink behavior. The default is `drain-then-retire`.
   - `fleet <N> --runner <runner>` asks the running supervisor to switch runner. A changed runner is applied by re-pinning the supervisor's worker env, marking every live slot `drain-then-retire`, letting in-flight claims finish, then respawning replacement slots on the new runner. An unchanged runner is a no-op.
   After writing the directive, the launcher reads `.red/tmp/supervisors/default/state.toon` and prints `fleet directive applied ...` when the heartbeat already echoes the requested target/runner/shrink-mode, or `fleet directive pending ...` while waiting for the next supervisor tick to apply it.

   Older launch guidance used to say a live supervisor is refused:
   ```
   ✗ fleet already running (supervisor pid=<pid>, log .red/tmp/supervisors/default/supervisor.log.toonl).
     to stop it: /dev:afk fleet stop
   ```
   That remains the model for truly conflicting second supervisors, but `fleet <N>` is now the supported live resize/switch surface. A stale PID file (file exists but `kill -0` fails) is left alone — the `fleet` command clears it itself when it acquires the supervisor lock.
3. **Launch the fleet.** From the project root, run the bundle's `fleet` command with the target and any flags:
   ```bash
   RED_AFK_RUNNER=<runner> npx -y -p @reddb-io/red-skills@<version> red-skills-dev fleet <N> [--request <text>]
   ```
   The command performs the PID-file pre-check from step 2 itself (refusing if a live supervisor already runs), detaches the supervisor, and forwards the resolved runner and the `--request/-r` text to every worker it spawns. It waits up to 3 s for `.red/tmp/supervisors/default/afk-supervisor.pid` to appear and contain a live pinned PID, then arms the repo-scoped self-heal watchdog and prints both PIDs plus the target. Failure to arm either process fails the launch; supervisor failure reports the tail of `.red/tmp/supervisors/default/supervisor.log.toonl`. Capture the reported supervisor PID for the *Report back* step. The launched supervisor is the native `__supervise` entrypoint of the same bundle.
4. **Attach the best available monitor surface.**
   - Claude Code: no automatic monitor cron. Tell the user to read the castle `monitor` tool (with `worker_vitals` for liveness), or — without the MCP — to run `/dev:afk monitor` manually or tail `.red/tmp/supervisors/default/supervisor.log.toonl`.
   - Codex: fetch a sub-agent spawn primitive via `ToolSearch` (query: `spawn agent background monitor`). If available, emit the canonical prompt with `RED_AFK_RUNNER=codex red-skills-dev codex-monitor-agent --project-root "$PWD" --mode fleet` and spawn exactly one read-only Codex monitor agent for this newly-launched supervisor. Its task: periodically read the castle `monitor` tool (falling back to `monitor --once` from the project root when the MCP is unreachable), report concise progress, and auto-close when `.red/tmp/supervisors/default/afk-supervisor.pid` is missing/dead and no `[live]` workers remain. It must never edit files, claim issues, stop workers, or run merges. The user may close it manually; workers continue. If the primitive is unavailable, skip and use the manual-monitor line.
   - Bare/unknown: skip native monitor setup and use the manual-monitor line.
5. **Report back.** Print:
   ```
   🚀 fleet launched (supervisor pid=<pid>, target=<N>)
      self-heal: armed (watchdog pid=<pid>)
      log:   .red/tmp/supervisors/default/supervisor.log.toonl
      stop:  /dev:afk fleet stop
      <monitor-status-line>
   ```
   Monitor status line choices:
   The line is the same one `fleetMonitorSuggestion()` prints from the bundle — MCP tool first, CLI labelled as the fallback:
   - Claude Code / Codex monitor unavailable / bare/unknown: `monitor: call the castle monitor tool (and worker_vitals for liveness); no-MCP fallback: run /dev:afk monitor or tail .red/tmp/supervisors/default/supervisor.log.toonl manually.`
   - Codex monitor agent spawned: `Codex monitor agent spawned — auto-closes when fleet exits; manual monitor: the castle monitor tool, or /dev:afk monitor without the MCP.`

### `/dev:afk fleet stop [--force]` — graceful shutdown or scoped hard teardown

Steps, in order:

1. **Liveness check.** Read the project supervisor's pinned identity. The three cases:
   - File missing → print `no fleet running.` and continue to step 3. Do not inspect or kill worker directories: an absent fleet owns no teardown target.
   - File present but the pinned identity is stale → clean its supervisor files, print `no fleet running (reason=dead supervisor pid; stale files cleaned).`, and continue to step 3. Do not kill detached workers.
   - File present and PID alive → continue to step 2.
2. **Publish stop intent.** Write the supervisor's stop file and terminate its watchdog so it cannot relaunch the supervisor.
   - Default graceful stop: the supervisor stops spawning/claiming and exits. Its detached one-shot workers are deliberately left alive to finish their in-flight Tickets; a later relaunch may adopt survivors. Wait up to **30 s** for the supervisor to exit. If it remains live, return `timeout` and leave the stop file armed; never escalate implicitly.
   - Explicit force (`project_stop { force: true }`, CLI fallback `fleet stop --force`): terminate the supervisor immediately, then kill only detached workers whose castle worker snapshot has `supervisor_id` equal to this project's supervisor lane. Workers stamped for another lane and unstamped standalone workers are untouched. Reconcile claims only when scoped workers were actually killed.
3. **Tear down runner-specific monitors.**
   - Claude Code: no automatic monitor cron to cancel. Print `no auto-monitor cron (manual monitoring only).`
   - Codex: do not stop workers through the monitor agent. It auto-closes when it observes no supervisor/live workers, and the user may close it manually. Print `Codex monitor agent will self-close when it observes fleet stopped.`
   - Bare/unknown: print `no native monitor teardown for this runner.`
4. **Idempotency.** Re-running `/dev:afk fleet stop` after a successful stop just hits the "file missing" branch in step 1 and the runner-specific teardown no-op in step 3. It never broadens into a repo-wide worker sweep.

### `/dev:afk fleet logs` — local structured log reader

Through the MCP this is the `logs` tool: one call per lane, returning raw
`CastleLaneRecord` entries rather than rendered lines. The CLI forms below
render the same records for a human reader.

`/dev:afk fleet logs --supervisor`, `/dev:afk fleet logs --worker <id>`, and
`/dev:afk fleet logs --all` are read-only local views over the castle lanes.
They do not call GitHub and do not mutate fleet state. They decode structured
TOONL records and render human-readable lines only at read time:

- `--supervisor` reads supervisor lanes under `.red/tmp/supervisors/`.
- `--worker <id>` reads that worker's `.red/tmp/workers/<id>/worker.log.toonl`.
- `--all` reads every worker lane, merges records by timestamp, and prefixes
  each rendered line with `[worker-id]`.
- `--follow` keeps polling the selected lane set and streams appended records
  until the caller stops the command.

### Circuit Trip Sweep

When the circuit breaker parks a slot (`CIRCUIT_K` fast deaths inside `CIRCUIT_WINDOW_S`) the supervisor — not a human — runs `sweep_parked_slot` to clean up after the burned workers. Three actions, in order, gated on the trip:

1. **Sweep affected worker dirs.** From the dated slot log (`.red/tmp/logs/<yyyy-mm-dd>/afk-supervisor-slot-{slot}.log`) the supervisor parses every `[afk] worker: w…` boot stamp emitted while the slot was alive, globs `.red/tmp/workers/{wid}/*/` for each ID, and reads `afk.state.json`'s `.current.number` to identify the affected issues. During the logs TTL aging window, the reader also accepts the legacy tmp-root `afk-supervisor-slot-{slot}.log` path so pre-migration slot logs can be swept before the janitor reclaims them. Each worker dir is `rm -rf`'d after its issue has been processed.
2. **Post a discard envelope on each affected issue.** Same `<details data-attempt-status="…">` schema as the per-issue terminal envelope, with `status="discarded"` and a summary line that names the runner and the trip cause (`runner-broken, slot parked after K fast deaths`). The envelope's `data-section="summary"` block carries the slot index, comma-joined worker IDs, fast-death count, and the supervisor log path. No `notes`, `drop`, or `log` sections — the attempts produced no usable artefacts.
3. **Restore label state on each affected issue.** Single `gh issue edit` adds `ready-for-agent` and `runner-error`, removes `ready-for-human` and (defensively) `running` — covers both the "issue had already been promoted to `ready-for-human`" path and the "issue was still `running` at the moment of trip" path.

The `runner-error` label is created idempotently by `/red-setup` (see [triage-labels.md](../red-setup/triage-labels.md)). The supervisor still calls `gh label create runner-error` on the fly during a trip so cleanup never fails just because the label is missing.

Idempotency: `SLOT_SWEPT[slot]=1` blocks a second sweep within the same supervisor lifetime. Across restarts a new trip yields fresh worker IDs and fresh worker dirs, so re-tripping never re-touches the previously swept issues. A trip that finds no claimed issues (all workers exited before claiming) parks the slot but posts no envelopes — the attempt-dir sweep is a no-op.

## Fleet Width by Disjunction

The safe fleet width for a given queue is the **degree of disjunction** — the maximum number of concurrently `ready-for-agent` slices that touch non-overlapping file sets.

- **Disjoint queue** (each slice writes to files no other ready slice touches): run the full fleet. `fleet 4` is safe when the queue has four independent file cones.
- **Partially entangled queue**: lower the fleet width to the number of disjoint groups. If two groups of two slices each are independent between groups but internally serialized via `req:N`, `fleet 2` drains both chains in parallel without risk.
- **Fully entangled refactor** (every slice touches shared files, serialized via `req:N`): run `fleet 1` or bare `/afk`. Parallel workers share no ready-for-agent work at any moment — extra slots sit idle and raise the risk of a spurious merge conflict should a `req:N` edge be missing.

**Rule: fleet width = degree of disjunction.** Raise it when the queue is disjoint; lower it to `fleet 1` when slices are entangled. The `/to-tickets` slicing skill is responsible for expressing file-level dependencies as `req:N` edges before the queue is published, so a correctly-sliced backlog never produces a file-overlap merge conflict from concurrent workers.

### Refs

- [`MCP.md`](./MCP.md) — the `castle` tool surface; `project_start`, `project_resize`, `project_status`, `project_stop`, and `logs` are the primary interface.
- The bundle's `fleet` / `fleet stop` commands — the CLI-fallback entrypoints this section drives. Stop-file path, env contract, circuit breaker, and trip-sweep are part of the supervisor behaviour described above.
- [`monitor.md`](./monitor.md) — the readonly dashboard and native-task mirror.
