# AFK Monitor — running `afk monitor` (readonly dashboard + task mirror)

This file serves the `afk monitor` branch: the readonly aggregated dashboard
across all live workers, the native-task mirror and its self-cancel teardown, and
the Codex monitor agent. Reached from *When To Use* (`/afk monitor`).

## Observability reads come from the `castle` MCP

**Every observability verb is a read tool — free to call, and never a reason to
touch a mutating one.** The tools return structured TOON; the bundle's `monitor`
command renders the same truth for a human terminal. See [`MCP.md`](./MCP.md).

| Question | Tool |
| --- | --- |
| What are the workers, history events, and fleet inputs right now? | `monitor` |
| Is a quiet worker actually alive? | `worker_vitals`, `worker_status` |
| What is drainable, and what is parked for a human? | `queue_status` |
| What happened over the last N days? | `dashboard` (`periodDays`), `history` |
| What did one lane actually record? | `logs` |

`queue_status` is the census tool: zero eligible `ready-for-agent` entries with
a non-empty open backlog is a flow bug to diagnose, never a clean stop. A
non-empty `held_for_summon` bucket is still zero drainable work; release it with
`triage:summon`, `dev triage --summon`, or `afk.trust-gate.allowlist`.

## The binding mirror rule (authoritative — stated once)

**The mirror is binding: every monitor tick must (1) render the dashboard and (2) mirror live workers onto the host runner's native task surface, re-checking `afk.state.json` on every tick.** It is never optional and never a shortcut — skipping it because "nothing changed" or because the user "only asked for status" is a bug, not an optimization, since `monitor --mirror-plan` is idempotent and emits zero descriptors when nothing changed. Per-runner mapping:

- **Claude Code:** pipe the tracked-task JSONL into the bundle's `monitor --mirror-plan` and apply the emitted call plan via `TaskCreate` (one task per live worker, titled `#<n> w<id> — <title>`) and `TaskUpdate` (description carries `stage:<x>`, terminal events flip `state` to `completed`/`failed`). See *Task Mirror* below for the full protocol.
- **Codex:** run `monitor --mirror-plan --runner codex`. Today Codex exposes no native task surface, so the sink emits an empty plan and the mirror falls back to the dashboard plus a one-line notice — that *is* the mirror under Codex; do not silently skip. If Codex grows a native surface, the sink emits the same call-plan descriptors against it.
- **Bare terminal / unknown runner:** skip the mirror silently — the `monitor` dashboard is the canonical view.

## Dashboard

`/afk monitor` is the readonly aggregated view across all live workers. **Call the castle `monitor` tool for the data, and pair it with `worker_vitals` when liveness is the question — do not reinvent the rendering in inline bash.** The bundle's `monitor` command renders the same truth for a human terminal and is the no-MCP fallback. Either way it:

1. Globs `.red/tmp/workers/*/*/afk.state.json` and renders one section per active attempt.
2. Verifies liveness via the orchestrator PID recorded in `afk.state.json` (`.pid` field), paired with `pid_start_time` when the platform exposes a stable process-start token. Attempts whose PID identity is dead or mismatched are flagged `stale`/`gone`; PID-live but agent-lane-quiet workers render `[quiet]` and are still counted as running.
3. Reads sibling `afk.log` line counts through the monitor cursor and renders `log:<total>(+<new>)` when available, without re-reading whole logs on every tick.
4. Renders WorkerVitals activity counters (`tools:<n> reason:<n> text:<n> wait:<n>`) so a quiet but pid-live worker can show useful progress signals.
5. Renders the 48h sparkline header (next subsection) on every refresh.

The **no-MCP fallback** renders the same dashboard from the project root — for a headless cron or a host that never loaded the `castle` server:

```bash
RED_AFK_RUNNER=<runner> npx -y -p @reddb-io/red-skills@<version> red-skills-dev monitor
```

The command has **two modes**, auto-selected by stdout type:

- **TTY (real terminal)**: full box-drawing layout, refreshes every 3 s, `clear` between frames. Ctrl-C to exit.
- **Non-TTY (piped, captured by an agent, redirected)**: one-shot **compact dashboard** — one sparkline header + one line per worker, then exit 0. Force this with `--once` or `RED_AFK_MONITOR_COMPACT=1` even from a TTY.

Compact output shape (≈3 lines total for 2 workers — fits inline without truncation in an agent transcript):

```
48h: ···············································█  (4 closed, peak 4/h, all workers)   Δ fleet +382 -45
wZ2R4 [live] claude  issues 4/5  #150 [blog/D] Agent SDK on RedDB  stage:impl  00:23:01  +382 -45  tools:39 reason:4 text:112 wait:2  log:540(+12)
wK7M2 [live] codex   issues 0/16  idle  +0 -0
```

The progress counter is `issues <done>/<total>` — issues *closed* over the queue total, **not** a completion percentage (the old `(80%)` form read as "no work done" while a worker had already committed thousands of lines). The real volume signal is the `+A -R` **diff** (committed + uncommitted, measured from the branch's merge-base with `origin/main`), which is rendered on **every** worker line unconditionally — idle and `+0 -0` included — and **summed across the fleet** into the `Δ fleet +A -R` suffix on the sparkline header, so the total diff volume is always visible at a glance.

When invoking from inside another agent session (Claude Code, Codex), prefer `--once` even if stdin is a pipe — explicit beats inference. Don't use the full TTY mode in agent transcripts; the 3 s refresh loop floods the captured stream and gets truncated to garbage.

Single-worker operation shows one section/line. Multi-worker adds one section/line per live worker, sorted by `started_at`. The sparkline aggregates **all workers** in this checkout's `.red/state/castle/history.toonl` — not fractured per-worker; the `Δ fleet` diff total likewise sums every worker.

The header of every render shows a **48h sparkline** of issues closed, one glyph per hour, scaled to the peak hour:

```
48h: ·▁··▁·▁·▁··█▁▁··▁·▁···▁·▁·▆▁▁··▁···▁▆·▁··▁▃▁·▃▁·  (35 closed, peak 5/h)
```

Source data: `.red/state/castle/history.toonl`, an append-only TOONL event log written by the orchestrator on every terminal event. `tq` is the pinned required reader for this lane; do not document or use a jq fallback.

```toonl
[]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:
"2026-05-17T12:14:00-03:00",1747494840,wK7M2,571,done,816,codex,0936ba54,null
"2026-05-17T12:18:00-03:00",1747495080,wK7M2,569,blocked,120,codex,null,merge-conflict
"2026-05-17T12:20:00-03:00",1747495200,wK7M2,568,exhausted,0,claude,null,both-runners
```

Example inspection:

```bash
tq -p toonl -o json 'select(.event == "done") | {issue: .issue, worker: .worker, runner: .runner}' .red/state/castle/history.toonl
```

`.red/state/` is gitignored. The orchestrator creates it during bootstrap, parallel workers serialise appends via `flock`, and the boot-time orphan sweep truncates the file to the last 10000 lines if it grows past that cap.

The sparkline only counts `event == "done"`. Blockers and exhausted runs are recorded for forensics but excluded from the throughput view.

## Self-Cancel (binding when invoked under Claude Code via a manual /loop)

When the user has manually set up a `/loop`-based recurring `/dev:afk monitor` run, each tick is responsible for tearing down the loop once there are no workers left to watch.

After rendering the dashboard, the agent must:

1. Count observable workers with status `[live]` or `[quiet]` in the rendered output (i.e., orchestrator pid identity alive, post-orphan-cleanup).
2. If `observable_workers == 0`:
   - Fetch `CronList` and `CronDelete` via `ToolSearch` if not already loaded.
   - `CronList` — find every job with `prompt == "/dev:afk monitor"`.
   - `CronDelete` each match.
   - Append one line to the user-facing output: `🛑 no live workers — cancelled monitor loop (cron <id>).`

When `CronList` / `CronDelete` are unavailable (Codex runner, or `/afk monitor` invoked outside Claude Code), skip the teardown silently — the cron infrastructure isn't running there to begin with.

## Task Mirror

Every `/dev:afk monitor` run also **mirrors each live worker onto the runner's native task list when that runner exposes one**, so a `/afk` session surfaces progress on the host's native UI — advancing through stages on its own, with no extra typing. This is a **read-only reflection of `afk.state.json`**; the mirror never writes state and never touches the orchestration.

**Host capability matrix (binding — no parity).** The Task mirror is per-runner by construction (ADR 0003/0015): there is **no shared native task API** across the hosts, so each runner gets its own explicit adapter, never a generic cross-runner abstraction. The honest matrix — encoded as `taskMirrorCapability(host)` in `core/mirror.ts` and exercised by `tests/mirror.test.ts` — is:

| Host (Agent runner) | Surface | Native task API | Adapter / sink | Today's behavior |
|---|---|---|---|---|
| Claude Code | `native-task` | yes | `mirrorPlan` (`TaskCreate`/`TaskUpdate`) | the in-session Agent runner drives the native Task mirror through the host task tools |
| Codex | `monitor-agent` | no | `codexSinkPlan` | no task API — the mirror falls back to the `monitor` dashboard plus **one read-only Codex monitor agent** |
| OpenCode runner | `headless` | no | none (empty plan) | a headless API-auth **Worker** with no host session — there is no surface to mirror into, so no native calls are ever emitted |

The three surfaces are deliberately distinct values (never a single `supported: boolean`) so the matrix can **never imply parity**. Exactly one host (Claude Code) exposes a native task API; the other two degrade explicitly, each on its own adapter. An unknown host fails loudly rather than silently inheriting the Claude native path.

The mirror surfaces **two signals on one lifecycle** (issue #811): the task **title** carries the calm **macro phase** — `w<id> [<n>/5 <phase>] #<issue> <slug>` — while the task **description** carries the fine **micro stage** — `stage: <impl|explore|tests|commit>`. The phase vocabulary is the ordered `setup → coding → validating → merging → done` (1-based `n/5`), plus the terminal `blocked` which drops the `n/5` and renders `[blocked]`. The title changes only when the macro phase moves, so it never flickers on every inner-agent tool call.

The mirror is a pure diff: it reconciles the live worker state files against the tasks already on the native surface and emits a **call plan**. After rendering the dashboard, the agent (under Claude Code only) must:

1. Fetch `TaskCreate`, `TaskUpdate`, and `TaskList` via `ToolSearch` if not already loaded (deferred tools).
2. **Build the tracked set.** `TaskList` → keep the mirror-owned tasks (those whose title matches `w<id> [<…>] #<n> <slug>`). For each, emit one JSONL line `{"key":"<worker_id>:<issue>","stage":"<last stage>","phase":"<last phase>"}`, reading the key (`worker_id` from the leading token, `issue` from the `#<n>`) and the **phase** (the word inside the title's `[…]` bracket, after any `n/5 `) from the title, and the **stage** from the description (`stage: <x>`). Keep a key→task_id map for step 4.
3. **Compute the plan.** The mirror reconciler is host-plumbing, not castle truth, so it has **no castle tool** — this is a standing no-MCP fallback, not a lapse. Pipe the tracked JSONL from step 2 into the bundle's `monitor --mirror-plan` subcommand:
   ```bash
   printf '%s\n' "$tracked" | red-skills-dev monitor --mirror-plan
   ```
   The command globs the state files and reconciles them against the tracked set on stdin (keyed by `worker_id:issue`, so parallel workers each get exactly one task and re-runs never duplicate), then prints a JSONL **call plan** to stdout — one descriptor per harness call (empty stdin → cold reconcile; empty plan → no output). A `TaskUpdate` rewrites the **title** when the macro phase moves and refreshes the **description** when the micro stage moves; a terminal failure re-titles to `[blocked]` and flips the task to `failed`:
   ```jsonl
   {"call":"TaskCreate","key":"wAAAA:22","title":"wAAAA [2/5 coding] #22 extract state.sh","description":"stage: impl","state":"in_progress"}
   {"call":"TaskUpdate","key":"wAAAA:22","title":"wAAAA [3/5 validating] #22 extract state.sh","description":"stage: tests","state":"in_progress"}
   {"call":"TaskUpdate","key":"wAAAA:22","state":"completed"}
   ```
4. **Apply the plan.** For each descriptor in order:
   - `TaskCreate` → create the task; record `key → task_id`.
   - `TaskUpdate` → resolve `key` to its `task_id` via the map and update. A `state` of `completed`/`failed` marks the worker's terminal event (`done`/`blocked`); the task drops off the active list and the mirror self-cleans. A descriptor whose `key` has no known `task_id` (e.g. a complete for a task that was never created in this session) is skipped.

An empty plan means nothing changed since the last tick — apply no calls. Because the plan is keyed by `worker_id:issue`, an idempotent re-run with no stage advance emits zero descriptors.

**Re-hydration on session reopen.** A native task dies with the Claude Code session; the `nohup` AFK worker does not. When a session opens with workers still running, `TaskList` (step 2) returns no mirror-owned tasks, so the tracked set is **empty** and `monitor --mirror-plan` reconciles cold — emitting a `TaskCreate` for every live worker. The status bar recovers the per-worker tasks with no operator action. This is the same path as steady-state, not a new one: only workers whose orchestrator PID (the `.pid` field in `afk.state.json`, via `state_is_live`) is alive re-hydrate (dead workers are untracked-terminal on a cold tick → no ghost task), and the next tick is idempotent because the freshly-created tasks now form the tracked set.

When `TaskCreate` / `TaskUpdate` are unavailable because the session is **outside any runner** (a bare terminal), **skip the mirror silently** — there is no native surface to drive, and the `monitor` dashboard is already the canonical view.

**Codex sink (runner-specific — binding).** The mirror is per-runner, mirroring the `runner-claude.md` / `runner-codex.md` split (ADR 0003). Under Codex the state reader and plan reconciler are reused unchanged — only the sink differs. After rendering the dashboard, the Codex agent runs `monitor --mirror-plan --runner codex` instead of the Claude `TaskCreate`/`TaskUpdate` loop:

- If Codex grows a native background-task surface, the sink emits the **same call-plan descriptors** the Claude sink applies — apply them against the Codex primitive.
- Otherwise (today's reality), `--runner codex` emits an **empty plan**, so the mirror falls back to the `monitor` dashboard and a one-line notice. No native calls are emitted, so there is no half-rendered state, and a dashboard hiccup is swallowed so the tick never crashes.

Do **not** invent a cross-runner task abstraction (rejected in ADR 0003) — keep the adapter explicitly per-runner.

## Codex Monitor Agent (Codex only — binding)

Codex does not expose Claude Code's `TaskCreate` / `TaskUpdate` task surface, and
its `tui.status_line` only renders built-in footer widgets. It does expose a
native sub-agent UI in hosts where the sub-agent primitive is available. For
Codex runs, use that sub-agent UI as a read-only presentation layer over the
canonical `/afk monitor` dashboard.

When `/afk` launches a normal detached worker under Codex (`run`, not
`monitor`, not `--once`, not `--boot-only`), or `/dev:afk fleet N` launches a new
supervisor under Codex:

1. Fetch a sub-agent spawn primitive via `ToolSearch` (query:
   `spawn agent background monitor`).
2. If unavailable, continue the worker launch and print:
   `monitor loop unavailable in this runner; call the castle monitor tool (and worker_vitals for liveness); no-MCP fallback: run /dev:afk monitor or tail .red/tmp/workers/*/*/afk.log manually.`
3. If available, emit the canonical prompt from the bundle (use `--mode run` for a
   single worker, `--mode fleet` for a supervisor, so the read-only rules stay
   identical across launches):
   ```bash
   RED_AFK_RUNNER=codex npx -y -p @reddb-io/red-skills@<version> red-skills-dev codex-monitor-agent --project-root "$PWD" --mode run
   ```
   Spawn exactly one monitor agent with that prompt. The monitor agent is a
   presentation consumer only: it periodically reads the castle `monitor` tool
   (with `worker_vitals` for liveness), reports concise progress in the Codex
   UI, and exits once no supervisor or live workers remain. Its prompt carries
   the `/dev:afk monitor --once` CLI form as the no-MCP fallback.
4. Tell the user one line:
   `Codex monitor agent spawned — auto-closes when AFK exits; manual monitor: the castle monitor tool, or /dev:afk monitor without the MCP.`

Hard boundaries for the monitor agent are non-negotiable: it must never edit
files, claim issues, change labels, comment, stop workers, run validation, push,
merge, `/retake`, `/go`, `/hitl`, `/triage`, `/afk run`, `/afk fleet`, `/afk fleet stop`,
`/afk reap`, or `/afk requeue`. Closing it manually must not affect the AFK
worker.
