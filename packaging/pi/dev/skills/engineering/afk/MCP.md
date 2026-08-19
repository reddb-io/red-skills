# The `rs_dev` MCP — RedSkills' complete project interface

**The `rs_dev` MCP is the one canonical interface to every project execution
capability, and every other surface is a client of it.** `/afk`, `/go`, the
`red-skills-dev` CLI, and any future command-center UI all drive the same tools
over the same value-returning cores (ADR 0120, public name amended by ADR 0142).
The name identifies the operator-facing system boundary; `red-castle` remains
the execution substrate and its `Castle*` contracts remain internal. This file
is the client contract; the skills that reference it never restate the tool list.

**The stdio server is a wire client, not the resident.** One versioned Castle
resident per canonical project owns engine state, GitHub adapters, registration
renewal, and background belts (ADR 0143); the Primary checkout and sibling
Worktrees rendezvous through Git's common directory. `redskilled` remains the
separate host authority for process birth, death, placement, and budgets. A
typed `INCOMPATIBLE_RESIDENT_PROTOCOL` response is terminal for the call —
surface it directly because no client carries an in-process workflow fallback.
The proxy and resident are a matching-version artifact pair in development,
installed-cache, npm, and Release layouts; a launcher must refuse a missing
half instead of falling back to a local engine. `status { scope: project }`
reports the resident version, protocol, PID, uptime, client count, handover
state, and a bounded resource sample without socket secrets or process argv.
For local 1/4/8-session comparison after `pnpm -C apps/dev build`, run
`pnpm -C apps/dev diagnose:castle-sessions`; it prints diagnostics to stdout
and never writes benchmark results into the repository or Issue tracker.

## How to reach the tools

The server is registered as `redskilled` in `plugins/dev/.mcp.json`, so a host that
loaded the `dev` plugin already has it. **Hosts prefix MCP tool names — call the
tool your host actually exposes, not the bare name.** Claude Code and Codex
surface plugin MCP tools as `mcp__<server-slug>__<tool>` (for example
`mcp__plugin_dev_rs_dev__status` under Claude Code); the slug is derived
from the server name, so it never contains a colon — codex rejects `:` in server
names. Resolve the exact identifier with a tool search for the bare name in the
table below before the first call, then reuse it for the rest of the session.
Tables and prose here always use the bare name.

Every tool returns TOON, never prose: one structured document per call, encoded
by the server. Read the fields; do not re-parse rendered text.

**First step when the MCP is not reachable: was the plugin installed or updated
in THIS session? Then run `/reload-plugins`, or start a new session.** A host
registers MCP servers **at plugin load** — Claude Code even says so
(`✓ Installed dev. Run /reload-plugins to apply.`) — so a mid-session install
writes the declaration and starts no process. `.mcp.json`, the manifests and the
launchers all read valid on disk while the session sees zero tools, which is a
load-lifecycle gap wearing the exact shape of an outage. `/red-doctor` names the
same cure from its check 27 when it is told what the session sees
(`--session-mcp`).

**Only once the reload is ruled out: say the MCP is unreachable and fall back to
the `red-skills-dev` CLI — never hand-roll the operation.** The CLI is the same
engine behind the same cores, so the fallback is a transport change, not a
behavior change. Falling back FIRST is what turns a one-line cure into a
forensic investigation.
Resolve the runtime through [`../_report-runtime/WRAPPER.md`](../_report-runtime/WRAPPER.md):
the canonical ADR 0091 npm direct-run form
`npx -y -p @reddb-io/red-skills@<version> red-skills-dev …`, which works on
every installation; an installed shim on `PATH` is only a warm-cache
optimization for the same command.

## Mutation modes are binding

`read` tools are free to call — they touch no state, spawn no process, and cost
no tokens. `mutating` tools spawn processes, land code, cost tokens, or change
issue state: **announce a `mutating` call before you make it, and never issue
one to "check" something a `read` tool already answers.** The server marks each
mutating tool with a `MUTATING:` description prefix; the table below mirrors it.

## Tool surface by domain

### Help — the situational front door

| Tool | Mode | What it does |
| --- | --- | --- |
| `help` | read | Read the daemon, registration, last socket-local queue poll, Workers, and latest refusal; return where this project stands, one pasteable next call, and an intent map generated from this live tool table. It makes no GitHub request. |

When the next redskilled call is unclear, call `help` and follow its structured
`next` action. It is the sole runtime source of operating choreography; this
document defines the protocol without copying its state-dependent routes.

### Status — one scoped read intent

| Tool | Mode | What it does |
| --- | --- | --- |
| `status` | read | With `scope: worker`, return normalized worker state, vitals, and monitor inputs; with `scope: project`, return registration, slots, latch, and live workers; with `scope: host`, return daemon state, the global dashboard, provisioning check, and unit status. Worker scope also accepts `worker`, `live_only`, and `fields`. |

### Fleet — named multi-fleet lifecycle

**A project has exactly one producer.** The named fleet is gone (ADR 0130): the
host daemon owns the budget, so nothing is left for a fleet name to address and
no registry of profiles to keep. What the profile carried that was about *work* —
the selector, the runner, the base branch — is registered by the project tools.
`drain` is the ensure-style front door; `project_start` and `project_resize`
remain available for specialized lifecycle operations during consolidation.

When `.red/config.yaml` declares both
`plugins.dev.afk.standing.runner` and `plugins.dev.afk.standing.target`, MCP
startup reaches the Castle resident, which calls the same ensure-style drain
automatically and renews it for the resident lifetime. The standing marker travels in the registration, allowing the
daemon to retain its recoverable intent while a counted backlog remains. Without
that block, startup preserves the explicit-only `drain`/`project_start` behavior.

| Tool | Mode | What it does |
| --- | --- | --- |
| `project_activation` | read | Report whether this project opted into RedSkills and the canonical runner and target that a no-argument `drain` would register. |
| `drain` | mutating | Ensure the daemon is reachable and this project is registered at the requested runner and target. Repeated calls succeed with a four-dimension difference report; a runner change is refused with the explicit stop-then-drain repair. |
| `project_start` | mutating | Register this project with the host daemon — a runner, a target width, and its work policy. It registers; it launches no process of the project's own. |
| `project_resize` | mutating | Change the target width, runner, or work policy; sends the live directive. |
| `project_reset` | mutating | Clear the named `project-birth-breaker` latch. Call it from `status {scope: project}` at `birth_latch.repair`; the structured repair supplies the exact args. |
| `project_stop` | mutating | Give this project's registration back and stop what it still holds; pass `force: true` to hard-stop only its attributed workers. |

### Host daemon diagnostics

`status {scope: host}` describes the machine-wide `redskilled` daemon, not only
the current project. Its one answer contains every project and Worker, the
global dashboard, the provisioning audit, and optional supervisor-unit state.
No host-scoped mutation is available here: provisioning and reclaim remain
operator commands.

`selector` scopes what the producer drains — `{spec, lane, label, issues, tags,
user}`. Graceful stop leaves in-flight detached workers to finish; force never
kills workers stamped for another lane or unstamped standalone workers. Passing
`fleet` to any of these tools is refused with the replacement named, so a stale
caller reads an answer rather than an internal error.

**The lane carries its own canary.** `project_start` once spawned every slot
against a bundle that cannot route `run`, so workers created through this
interface drained zero issues while the CLI lane kept working and no surface
reported the difference (#2677). Run
`npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled-mcp __mcp-canary --root <scratch-repo>` to walk the shipped lane end to
end — `project_start` → a registration the daemon holds → no process of the
project's own → `status {scope: project}` → `project_stop`. It exits non-zero naming the
step that went inert.

**The load-bearing assertion inverted with the lane.** The canary once refused
to accept a returned supervisor pid as proof of drainage; since the MCP
registers instead of launching, it refuses to accept a project that started
anything at all. A `registered` payload carrying a pid, or a live worker
appearing under the project, is a fallback launch the host never admitted,
never counts and cannot stop. #2677's own fact — whether the entry can route
`run` — travels one process out, in the argv the registration commits the host
to running, and the walk reads it there.

**The walk crosses the socket, because the lane does.** With no daemon
listening, `project_start` must REFUSE (ADR 0130 rule 6) rather than fall back
to spawning, so the canary's dead-daemon walk goes red at the first mutating
step. Its failure names the session socket path, because "restart the daemon"
and "fix the lane that stopped asking it" are different repairs.

**The canary fires without being remembered.** `red-mcp-lane-canary` runs the
walk daily, on every push that touches the lane, and on demand — against the
shipped bundle with a live daemon, and against a deliberately broken lane (a
session whose daemon socket is dead) that must come back red. It is deliberately
NOT a pull-request gate: its job is to make an inert lane loud, and a probe that blocks merges on an
unrelated transient is one people route around. `scripts/test-mcp-lane-canary-schedule.sh`
holds both halves of that in place.

### Worker — one worker's lifecycle

| Tool | Mode | What it does |
| --- | --- | --- |
| `worker_dispatch` | mutating | Run one tracked issue, or mint and run one disposable demand. |
| `worker_stop` | mutating | Terminate one worker process tree. |
| `worker_recycle` | mutating | Terminate one fleet worker so its supervisor refills the slot. |
| `worker_request` | mutating | Dispatch a worker with a special request injected at spawn time. |

`worker_dispatch` takes **exactly one** of `issue` or `demand`; `mode` is valid
only for a `demand`. Go modes (`no-mistakes` / `direct-PR` / `local-only`) run
the standard AFK engine and open a PR. The `scout` mode runs a **read-only
investigation**: it mints a disposable `lane:scout` issue, runs the engine with
`run_mode=scout` (no push, no PR, no merge), and posts the agent's report as a
comment before closing the issue. Scout cannot be combined with `issue`.

### Runner — backends and live steering

| Tool | Mode | What it does |
| --- | --- | --- |
| `runner_list` | read | The canonical runner specification registry. |
| `runner_detect` | read | The runner an override or this host resolves to. |
| `runner_steer` | mutating | Inject a prompt into a **live** worker's next iteration. |
| `steer_status` | read | Whether a worker's live steer is none, pending, or consumed. |

`runner_steer` is the steering surface for a run already in flight;
`worker_request` is the spawn-time equivalent. Reach for steer before killing a
worker that is merely pointed the wrong way.

### Gate — validation authority

| Tool | Mode | What it does |
| --- | --- | --- |
| `gate_run` | mutating | Materialize the feedback worktree and run the package-scoped gate. |

**The gate command is canonical.** `gate_run` runs exactly what the repo
declares; never widen it with stricter flags. When it fails, the baseline
comparison classifies the verdict as `branch-fault` or `inconclusive` — it
never tracks the base branch as red (#2380). A baseline that could not be
materialised is environment-inconclusive: its failed materialisation is not
cached, the next round retries it, and the round consumes no Re-seed budget.

### Landing — merge and cascade

| Tool | Mode | What it does |
| --- | --- | --- |
| `land_branch` | mutating | Land one validated worker branch through the full landing sequence. |
| `cascade_status` | read | The dependents of an issue and which ones the close cascade promotes. |

### Claim — the three-layer lock

| Tool | Mode | What it does |
| --- | --- | --- |
| `claim_status` | read | Parsed claim markers for one issue (`issue`) or a batch (`issues`), keyed per issue. |
| `claim_release` | mutating | Concede every un-conceded claim so the issue — or each issue in a batch — is claimable again. |
| `hitl_resolve` | mutating | One atomic human decision on a parked issue: `requeue`, `retake`, `park`, or `close`, with the rationale posted for the audit trail. |

`claim_release` is the cure for a ghost claim — an issue that instantly reports
`1/1 100%` with no attempt. Release it through the tool, never by flipping
labels by hand.

### Merge driver — explicit recovery custody

| Tool | Mode | What it does |
| --- | --- | --- |
| `merge_arm` | mutating | Hand one open PR to a live `merge-driver` process; refuses when that process is missing so custody cannot become orphaned. |
| `merge_status` | read | Whether the `merge-driver` process is `ticking` or `missing`, plus durable per-PR records whose `actionability` distinguishes armed records as `driver-ticking` or `orphaned`. |
| `merge_release` | mutating | Stop driver ownership of one PR (record kept as `released`). |

When the recovery driver (#2512) is running, its fixed cadence handles BEHIND →
update-branch, green at head → merge with the merge-commit strategy (never an
admin override), transient faults → bounded retries, and DIRTY or failing
checks → terminal `needs-medic`/`needs-human` classification instead of a loop.
Its state survives process restarts in `.red/state/castle/merge-driver.toon`.
The ordinary MCP session no longer starts this loop (ADR 0136): native intent
and the Queue Custodian own the normal landing tail. Therefore `merge_arm`
fails loudly unless a live recovery process owns the `merge-driver` singleton;
`merge_status` marks any older armed record `orphaned` when that owner is gone.

### Worktree — the disposable pool

| Tool | Mode | What it does |
| --- | --- | --- |
| `worktree_list` | read | Every checkout under the disposable `.red/tmp/worktrees/*` lanes. |
| `worktree_remove` | mutating | Remove one checkout under those lanes. |

### Hygiene — queue repair

| Tool | Mode | What it does |
| --- | --- | --- |
| `requeue` | mutating | Apply the full parked-issue requeue transition and record guidance. |
| `retake` | read | The issue/PR/branch/worktree report plus the recommended next action. |
| `reap` | mutating | Classify and delete stale local and remote AFK branches. |
| `unblock_sweep` | mutating | Promote dependency-blocked issues whose requirements all closed. |

`retake` only recommends; the action it names is a separate, explicit call.

### Observability — read-only structured truth

| Tool | Mode | What it does |
| --- | --- | --- |
| `logs` | read | Raw `CastleLaneRecord` entries from one lane (`worker`/`supervisor`/`monitor`/`liveness`). |
| `dashboard` | read | The operational dashboard over a `periodDays` window. |
| `history` | read | Structured AFK history records, newest last. |
| `statusline_aggregate` | read | Project-side statusline aggregate (project, repo counters, docs drift, drain, Worker rows, aggregated AFK block, queue) — the same data the command-backed `statusLine` renders, as structured data with the same 180s cache discipline. Host-side fields (session model/effort, context %, usage quotas) are out of scope. |

### Queue — what is drainable now

| Tool | Mode | What it does |
| --- | --- | --- |
| `queue_status` | read | Trust-partitioned `ready-for-agent` candidates (`eligible` and `held_for_summon`) plus `ready-for-human`. `degraded: true` names partial trust-read failures in `errors` while retaining successfully read candidates. Optional `selector` previews one fleet's scoped view (same facets as fleet selectors, e.g. `tags`/`user`). |
| `events_since` | read | AFK history events and Worker lane records after an opaque cursor, plus the next cursor. |
| `deadend_audit` | read | Every stuck AFK pattern with its recommended cure: dangling claims, red PRs with dead owners, superseded PRs, executable Tickets carrying an active Current blocker, dependency blocks whose `req:*` targets all closed, human-queue age outliers, and stale worktrees. Cache-backed — repeated calls within the refresh window cost zero GitHub quota. Detection only. |

`help` is the first call when operating a drain. Use `queue_status` when its
answer calls for the tracker-backed queue census: zero eligible `ready-for-agent`
entries with a non-empty open backlog is a flow bug to census, not a clean stop.
Treat `degraded: true` as a failed census, even when both candidate arrays are
empty; use the named `errors` instead of concluding that the queue is empty.
That rule includes a non-empty queue whose every entry is `held_for_summon`;
release it with `triage:summon`, `dev triage --summon`, or
`afk.trust-gate.allowlist`.

`deadend_audit` is the census surface for that flow bug: it names each stuck
pattern and the cure to apply, without mutating anything. The resident cron
refreshes it and `/red-doctor` renders the same report.

`events_since` is the incremental read surface: use it instead of re-calling
`queue_status` or `status` on every polling tick. **Cost
guidance:** omit `cursor` on the first call to get a baseline cursor with no
events; store that cursor; pass it on every subsequent tick to receive only
what changed. The resident caches `queue_status`, `claim_status`, and
`cascade_status` for ~15 s — within that window those reads are free. Use
`events_since` for longer-running monitors where you need sub-second awareness
of history completions and worker phase changes without polling GitHub directly.
Unknown or expired cursors (> 7 days old) are refused with a terse `refused:
true` response; re-baseline by calling `queue_status` and `status {scope: worker}` to
rebuild state, then call `events_since` with no cursor to get a fresh handle.

### Wait — programmatic outcome polling

| Tool | Mode | What it does |
| --- | --- | --- |
| `wait_start` | mutating | Spawn a detached rsp wait and return its registry id. |
| `wait_list` | read | Active-wait registry from `.red/tmp/waits`. |
| `wait_status` | read | Registry entry for a running wait or sealed result envelope for a finished one. |

`wait_start` accepts `pr`, `run`, `release`, and `cmd` targets; `timeout_ms` and
`reason` are optional. The returned `id` is the stable handle for `wait_status`.
Finished waits are distinguished by a populated `result` field carrying the
`rsp.wait.result` envelope; running waits carry `waits` with the active registry.
### Review and Triage — activity reporting and issue routing

| Tool | Mode | What it does |
| --- | --- | --- |
| `daily_review` | read | Structured daily activity review report for the local window. |
| `weekly_review` | read | Structured weekly activity review report for the local window. |
| `triage` | mutating | Apply the decided triage transition to one issue, gated by the per-repo trust policy. |
| `respond` | mutating | Parse a `/dev` comment summon, authorize the commenter, and route the advisory or mutation verb. |

`daily_review` and `weekly_review` are always rooted at the server's cwd — they
auto-resolve the repo and the time window, so no parameters are required.
`triage` requires `issue` and `decision` (`ready-for-agent` / `needs-info` /
`ready-for-human` / `wontfix`); pass `summon: true` to release an untrusted
author's issue. `respond` requires `body` and `number`; pass `is_pr: true` when
the comment is on a pull request.

## Refs

- ADR 0120 — red-castle is the AFK MCP; CLI and skills are clients.
- ADR 0128 §7 — the CLI is a thin client of the same core, so the MCP lane
  carries a canary that exercises the shipped path end to end and fails loudly.
- ADR 0130 — the lane spans two processes and a socket, so the canary carries a
  step for the daemon boundary that a single-process walk could not see.
- ADR 0113 — castle owns the truth, dev owns the host boundary.
- [`SKILL.md`](./SKILL.md), [`fleet.md`](./fleet.md), [`monitor.md`](./monitor.md) — the `/afk` clients.
- [`../go/SKILL.md`](../go/SKILL.md) — the `/go` client.
