# The `dev:afk` MCP — the castle's complete capability interface

**red-castle is the AFK MCP: `dev:afk` is the one canonical interface to every
castle capability, and every other surface is a client of it.** `/afk`, `/go`,
the `red-skills-dev` CLI, and any future command-center UI all drive the same
tools over the same value-returning cores (ADR 0120). This file is the client
contract; the skills that reference it never restate the tool list.

## How to reach the tools

The server is registered as `dev:afk` in `plugins/dev/.mcp.json`, so a host that
loaded the `dev` plugin already has it. **Hosts prefix MCP tool names — call the
tool your host actually exposes, not the bare name.** Claude Code and Codex
surface plugin MCP tools as `mcp__<server-slug>__<tool>` (for example
`mcp__…__fleet_status`); resolve the exact identifier with a tool search for the
bare name in the table below before the first call, then reuse it for the rest
of the session. Tables and prose here always use the bare name.

Every tool returns TOON, never prose: one structured document per call, encoded
by the server. Read the fields; do not re-parse rendered text.

**When the MCP is not reachable, say so and fall back to the `red-skills-dev`
CLI — never hand-roll the operation.** The CLI is the same engine behind the
same cores, so the fallback is a transport change, not a behavior change.
Resolve the runtime through [`../_report-runtime/WRAPPER.md`](../_report-runtime/WRAPPER.md):
an installed `red-skills-dev` shim on `PATH` first, otherwise the ADR 0091
npm direct-run form `npx -y -p @reddb-io/red-skills@<version> red-skills-dev …`.

## Mutation modes are binding

`read` tools are free to call — they touch no state, spawn no process, and cost
no tokens. `mutating` tools spawn processes, land code, cost tokens, or change
issue state: **announce a `mutating` call before you make it, and never issue
one to "check" something a `read` tool already answers.** The server marks each
mutating tool with a `MUTATING:` description prefix; the table below mirrors it.

## Tool surface by domain

### Fleet — named multi-fleet lifecycle

A **named fleet** is a full profile: runner + work-scope selector + config knobs
+ base. Several named fleets run concurrently on one checkout; the three-layer
claim keeps two fleets on the same backlog from double-claiming an issue.

| Tool | Mode | What it does |
| --- | --- | --- |
| `fleet_list` | read | List every registered named fleet profile. |
| `fleet_status` | read | Supervisor pid, slots, churn, and live workers for one fleet. |
| `fleet_create` | mutating | Persist a named profile and spawn its supervisor. |
| `fleet_edit` | mutating | Update a profile; sends a live resize directive when asked. |
| `fleet_stop` | mutating | Stop one named fleet and its detached workers. |

`selector` scopes what a fleet drains — `{spec, lane, label, issues}`. Omit
`fleet` on the read and stop tools to address the `default` fleet.

### Worker — one worker's lifecycle

| Tool | Mode | What it does |
| --- | --- | --- |
| `worker_dispatch` | mutating | Run one tracked issue, or mint and run one disposable demand. |
| `worker_status` | read | Liveness-qualified state for one worker or all of them. |
| `worker_stop` | mutating | Terminate one worker process tree. |
| `worker_recycle` | mutating | Terminate one fleet worker so its supervisor refills the slot. |
| `worker_request` | mutating | Dispatch a worker with a special request injected at spawn time. |

`worker_dispatch` takes **exactly one** of `issue` or `demand`; `mode`
(`no-mistakes` / `direct-PR` / `local-only`) is valid only for a `demand`.

### Runner — backends and live steering

| Tool | Mode | What it does |
| --- | --- | --- |
| `runner_list` | read | The canonical runner specification registry. |
| `runner_detect` | read | The runner an override or this host resolves to. |
| `runner_steer` | mutating | Inject a prompt into a **live** worker's next iteration. |

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
never tracks the base branch as red (#2380).

### Landing — merge and cascade

| Tool | Mode | What it does |
| --- | --- | --- |
| `land_branch` | mutating | Land one validated worker branch through the full landing sequence. |
| `cascade_status` | read | The dependents of an issue and which ones the close cascade promotes. |

### Claim — the three-layer lock

| Tool | Mode | What it does |
| --- | --- | --- |
| `claim_status` | read | Parsed claim markers for one issue and the worker holding it. |
| `claim_release` | mutating | Concede every un-conceded claim so the issue is claimable again. |

`claim_release` is the cure for a ghost claim — an issue that instantly reports
`1/1 100%` with no attempt. Release it through the tool, never by flipping
labels by hand.

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
| `worker_vitals` | read | Liveness-qualified state of every local worker. |
| `dashboard` | read | The operational dashboard over a `periodDays` window. |
| `monitor` | read | Current workers, history events, and fleet monitor inputs. |
| `history` | read | Structured castle history records, newest last. |

### Queue — what is drainable now

| Tool | Mode | What it does |
| --- | --- | --- |
| `queue_status` | read | `ready-for-agent` and `ready-for-human` queue candidates. |

`queue_status` is the first call of any drain: an empty `ready-for-agent` queue
with a non-empty open backlog is a flow bug to census, not a clean stop.

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
- ADR 0113 — castle owns the truth, dev owns the host boundary.
- [`SKILL.md`](./SKILL.md), [`fleet.md`](./fleet.md), [`monitor.md`](./monitor.md) — the `/afk` clients.
- [`../go/SKILL.md`](../go/SKILL.md) — the `/go` client.
