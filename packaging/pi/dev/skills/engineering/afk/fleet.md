# AFK Fleet Mode — running `N` concurrent workers on one checkout

This file serves the `afk fleet` branch: starting, re-aiming and stopping `N`
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
| resize / switch | `project_resize` | Same fields, all optional; restates the launch on the registration's renewal (Amendment 5). |
| ground truth | `project_status` | The registration the host holds, its renewal and last poll, plus slots and live workers. |
| reset birth latch | `project_reset` | Invoke the structured repair returned in `project_status.birth_latch`; clears only this project's birth breaker. |
| shutdown | `project_stop` | Asks the host to end this project's Workers, then gives the registration back. |
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

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are the user-facing fleet verbs; both are served by the `castle` MCP's project tools, never by a process of the project's own. They spin up (or shut down) `N` concurrent `run` workers on the current checkout, with the daemon handling birth and respawn, the circuit breaker, the **passive stall detector** (samples each slot's per-worker **agent lane** `agent.log.jsonl` mtime — the clean liveness signal — every `RED_AFK_STALL_POLL_S=30s`; flags any slot alive ≥ `RED_AFK_STALL_THRESHOLD_S=600` whose agent lane has been idle ≥ the same — surfaces as `⏸️ stalled` in `/dev:afk monitor`. It keys off the agent lane, never `afk.log`/`log.jsonl`, because the orchestrator heartbeat writes those every minute and would mask a real stall — the masking that defeated detection in #243), the **hard stall reaper** (a slot silent on the agent lane past `RED_AFK_STALL_KILL_THRESHOLD_S=1800` is only a *candidate*: the irreversible kill is gated behind a reaper-signal predicate, so a worker mid-build/test — an active `vitest`/`tsc`/`cargo`/… descendant under its tree, or non-trivial aggregate cpu — is **busy** and left alone, while a genuinely stuck worker [idle past the threshold, no active descendant, flat cpu] is killed tree-wide, a `data-attempt-status="no-sentinel"` envelope is posted with the attempt-dir `afk.log` tail, the issue label is rotated back to `ready-for-agent`, the worktree + worker dir are removed, and the slot is freed for the next health-check respawn — `RED_AFK_STALL_KILL_THRESHOLD_S` must be strictly greater than `RED_AFK_STALL_THRESHOLD_S`, validated at supervisor boot), and per-slot build isolation.

**Worker env passthrough.** Any `RED_AFK_*` variable exported in the operator's shell before `/dev:afk fleet` is auto-forwarded to every worker the supervisor spawns. Use this for worker-side toggles like `RED_AFK_SKIP_PERF=1` or `RED_AFK_SKIP_COMPETITIVE_BASELINE=1` without writing a hook. Internal supervisor knobs (`RED_AFK_TARGET`, `RED_AFK_POLL_S`, `RED_AFK_STALL_*`, `RED_AFK_CIRCUIT_*`, `RED_AFK_RUNNER`, `RED_AFK_REQUEST`, `RED_AFK_PLUGIN_DIR`) and the per-slot `*_BASE` build-isolation vars are excluded — they have dedicated wiring and the supervisor denylists them from passthrough. The supervisor re-pins `RED_AFK_RUNNER=<runner>` for each worker.

```bash
$ export RED_AFK_SKIP_PERF=1
$ export RED_AFK_SKIP_COMPETITIVE_BASELINE=1
$ /dev:afk fleet 1   # every worker sees both vars
```

Fleet mode is **runner-portable**: registering a project is plain host bookkeeping, not a Claude Code primitive. Claude Code, Codex, and bare terminals may all start and stop a project's workers when the normal AFK hard preconditions pass. Runner-specific observability degrades independently:

- Claude Code: register the project. For manual monitoring, read the castle `monitor` and `project_status` tools; without the MCP, run `/dev:afk monitor`.
- Codex: register with `RED_AFK_RUNNER=codex` and spawn one read-only Codex monitor agent from the bundle's `codex-monitor-agent --mode fleet` prompt when a sub-agent primitive is available. If no sub-agent primitive is available, register anyway and print the monitor status line below.
- Bare terminal / unknown runner: register and print the manual-monitor guidance.

**Self-heal is the host's, not a monitor side effect.** ADR 0130 Amendment 4
removed the per-project process and, with it, the detached watchdog that used to
relaunch it — a watchdog over a process nobody starts has nothing to watch. What
persists instead is the **registration**: it outlives the session that made it, is
renewed while that session lives, and lapses after a stated interval, so a closed
laptop stops polling on its own. A project whose queue drains **deregisters
itself**. Worker death, respawn and budget-kill are the daemon's, recorded on its
host event lane, so a death a project reacts to is one the host observed rather
than one inferred from a pid it happens to remember.

**Release recycle rule.** A registration names the bundle a Worker is born
against, resolved from the PUBLISHED version rather than from the registering
process's own. After any RedSkills release that changes AFK or
castle engine behavior, stop and re-register the project before starting or
counting a proving drain; otherwise the drain may still be executing on the
pre-release engine. `monitor` and the statusline fleet cell show the running
bundle version and mark skew against a newer locally cached bundle so a stale
project is visible. Automatic drain-and-respawn on version change is a future enhancement,
not part of the current fleet contract.

### Starting this project's workers — register, never launch

**A project contributes a registration, not a process** (ADR 0130 Amendment 4).
The `fleet` CLI command and the `__supervise` entrypoint it detached are removed:
there is no per-project process to start, refuse a second copy of, arm a watchdog
over, or read a pid file for. The steps below are the whole flow.

1. **Resolve runner.** Same intent as the normal AFK cascade: explicit user
   `--runner` if present, else `RED_AFK_RUNNER`, else runner env/process/path
   signals, else `claude`. Under Codex this must resolve to `codex`. The resolved
   value rides in the registration's argv, so every Worker the host births for
   this project runs it.
2. **Register.** Call `project_start { runner, target, selector?, base? }`. The
   MCP hands the daemon a repository identity, an opaque work selector, an opaque
   argv and a target width; the daemon polls the tracker and births the Workers.
   **A daemon that does not answer refuses the start** — falling back to a
   process of the project's own would put a producer on the machine that no host
   admitted, no host counts and no host can stop.
3. **Re-aim without re-registering.** `project_resize { runner }` restates the
   launch on the renewal a live session already sends, and the daemon holds it as
   the launch for the *next* Worker (Amendment 5). Restating is all-or-nothing.
   A `target` change does not travel on a renewal and is reported as unapplied
   rather than silently dropped.
4. **Attach the best available monitor surface.**
   - Claude Code: no automatic monitor cron. Tell the user to read the castle
     `monitor` tool (with `worker_vitals` for liveness), or — without the MCP —
     to run `/dev:afk monitor` manually.
   - Codex: fetch a sub-agent spawn primitive via `ToolSearch` (query:
     `spawn agent background monitor`). If available, spawn exactly one read-only
     Codex monitor agent with `RED_AFK_RUNNER=codex red-skills-dev
     codex-monitor-agent --project-root "$PWD" --mode fleet`. Its task:
     periodically read the castle `monitor` tool, report concise progress, and
     auto-close when this project holds no registration and no `[live]` workers
     remain. It must never edit files, claim issues, stop workers, or run merges.
   - Bare/unknown: skip native monitor setup and use the manual-monitor line.
5. **Report back.** Print the registration the daemon handed back — its project
   label, target, selector and renewal deadline — then the monitor line:
   `monitor: call the castle monitor tool (and worker_vitals for liveness);
   no-MCP fallback: run /dev:afk monitor.`

### Stopping — give the registration back

`project_stop` is the whole shutdown, and it is two moves in one direction: the
host ends the Workers it holds for this project, then the registration is
released. There is no process of the project's own to terminate, so there is no
graceful-versus-forced distinction left — **the kill is the daemon's either way**,
and `force` no longer selects a harder teardown.

- A Worker the host no longer names is the outcome asked for, not a failure:
  between the read and the stop it may have finished.
- `deregistered: false` is an answer, not a fault. Work stops from two
  directions — an operator, and a session that ends — and the second must read as
  done. A registration also lapses on its own renewal deadline.
- A stop that cannot reach the daemon **reports it and does not raise**, unlike a
  start: refusing to stop would leave an operator holding a project they cannot
  put down.
- Runner-specific monitor teardown is unchanged: the Codex monitor agent
  auto-closes when it observes no registration and no live workers; Claude Code
  and bare hosts have nothing to cancel.

### Reading the lanes

The `logs` tool takes one lane per call (`supervisor` / `worker` / `monitor` /
`liveness`) and returns raw `CastleLaneRecord` entries rather than rendered
lines. The lanes outlived the process that used to write the project's own: they
are directories the Workers and the monitor write to, addressed by the project
rather than by anything that supervises it.

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

- [`MCP.md`](./MCP.md) — the `castle` tool surface; `project_start`, `project_resize`, `project_status`, `project_reset`, `project_stop`, and `logs` are the primary interface.
- ADR 0130 Amendment 4 — why a project contributes a registration and holds no process of its own, and why the `fleet` launcher, the `__supervise` entrypoint and the self-heal watchdog were deleted rather than renamed.
- [`monitor.md`](./monitor.md) — the readonly dashboard and native-task mirror.
