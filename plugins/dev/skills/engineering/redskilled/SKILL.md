---
name: redskilled
description: Operates the per-machine redskilled daemon through its published status, provisioning, policy, and lifecycle surfaces, and writes a self-serve debug dossier for the Worker(s) that touched one issue. Use when the operator needs to inspect, provision, configure, restart, or confirm the host-scoped execution daemon, or needs to know what the Worker on issue N is doing, where it stalled, or why it never started.
argument-hint: "nothing to operate the daemon, or an issue number (3351 / #3351) to debug its Worker"
disable-model-invocation: true
---

# Operate redskilled

Treat `redskilled` as the per-machine process authority: it owns Worker birth, death, limits, and placement across every project on the host.

**The argument picks the entry.** No argument means operate the host daemon — run *Operate the host daemon*. A bare issue number, with or without a leading `#` (`/redskilled 3351`, `/redskilled #3351`), means debug that issue's Worker — skip to *Debug a Worker by issue*. The two entries are independent: debugging is read-only and changes nothing on the host, so never provision, restart, or repair while answering a debug argument.

<what-to-do>

## Operate the host daemon

1. **Read status before changing it** — run both read surfaces:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --check
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled host-state
   ```

   The provisioning audit says whether the daemon answers and names its socket.
   `host-state` says the running `daemon_version`, standing `registrations`, live
   `workers`, and the resolved `ceiling`. Read `worker_source`, `memory_source`,
   and `validation_source` beside the values; each is `flag`, `environment`,
   `home-config`, or `derived-default`. If `host-state` cannot contact a daemon,
   continue to provisioning rather than treating an empty machine as healthy.

2. **Provision through the one owner** — on a fresh machine, run:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --workspace host
   ```

   This calls `provisionRedskilledHome`, the only authority allowed to create
   `~/.red/redskilled/`, creates the initial `~/.red/config.yaml` template when
   absent, starts the daemon through ordinary client auto-spawn, and prints the
   audit. Never replace this step with a bare `mkdir ~/.red` — call the owner.

3. **Configure the machine policy** — edit the existing home file at
   `~/.red/config.yaml`, preserving unrelated operator settings, and set the
   required values under the exact `plugins.dev.redskilled` mapping:

   ```yaml
   plugins:
     dev:
       redskilled:
         worker_ceiling: 6
         memory_ceiling: 8G
         validation_ceiling: 2
         idle_ms: 300000
   ```

   Resolution is `serve flag > environment > home config > derived default`.
   Keep these keys in the home config only: a project's `.red/config.yaml` may
   ask for Workers, but it may not redefine the machine's limit.

4. **Restart and adopt** — stop the daemon through its reporting verb:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled stop
   ```

   Read the survival report before continuing. Workers are init-system units and
   survive the daemon stop: this is a restart, never an evacuation. There is no
   standalone `start` verb; #3217 established client auto-spawn, so start the
   successor through the same idempotent provisioning client:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --workspace host
   ```

5. **Confirm adoption from the successor** — read the live daemon again:

   ```bash
   npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled host-state
   ```

   Finish only when the configured value is present and its source is
   `home-config` — for `worker_ceiling`, confirm `ceiling.worker_count` and
   `ceiling.worker_source: home-config`. A `flag` or `environment` source means
   a higher-precedence declaration still overrides the home policy; remove or
   change that declaration, repeat the restart, and read back again.

## Debug a Worker by issue

**The dossier is for the operator, not for you.** Write it so the user can keep digging after you stop: every claim carries the evidence it rests on, every open question carries the exact command that answers it. Never end the flow with a summary in chat only — the file is the deliverable.

**A dead Worker still gets a dossier.** A Worker refused at birth produced no agent rounds, so the daemon's refusal line and the death evidence *are* the content. Never report "nothing to debug" when the answer is "it never started, here is why".

1. **Resolve the issue to Worker(s) — tool surface first, lanes second.** Ask the
   `redskilled` MCP before touching a file:

   - `status { scope: "worker", live_only: false }` — the Worker vitals records.
     Each record's `number` is the issue it holds, so the resolution is a filter
     over that answer. Keep every record whose `number` matches the argument.
   - `claim_status { issue: <n> }` — who holds or held the Ticket's claim.
   - `history { limit: 200 }` and `events_since {}` — AFK history and lane
     records for the recent past, which name the Worker around park and landing.

   Then read the lanes for whatever the tools could not answer — a Worker the
   daemon refused, a Worker from before the current daemon, or any run at all
   when the MCP is unreachable:

   ```bash
   ls -d .red/tmp/workers/*/<issue>
   grep -l ",<issue>," .red/tmp/workers/*/worker.log.toonl
   grep -E "worker-(birth|death|refused)" ~/.red/redskilled/redskilled.log.toonl
   ```

   **The directory glob is the authoritative answer; the grep is the widener.**
   The Worker id is the directory between `workers/` and the issue number, so
   the first command names exactly the Workers that ran the issue. The second
   also matches a log that merely *mentions* the number in narration, so treat
   any id it adds as a candidate to confirm against a `worker.claimed` row
   before you write it into the dossier. Match the daemon's lines to a Worker by
   `worker_id`, and confirm the project by
   `workspace_path` — the daemon log is host-scoped and holds every project's
   lines. **Resolve every Worker that touched the issue, not just the newest**: a
   requeued Ticket has more than one, and the failure is usually in the earlier
   one. Write one dossier covering all of them, ordered oldest first.

2. **Open with the fiche** — a header the operator can read in ten seconds:
   issue number, title, and GitHub link; PR number, branch, and link when one
   exists; project label; Worker id; runner, model, and effort; bundle version;
   started-at; pid; last heartbeat and its age; and the `loc_added` /
   `loc_removed` and token counters. **Each field has one owner — read it there.**
   Issue, title, runner, model, and effort come from the Worker's own
   `worker.claimed` and `worker.routed` rows; project label, pid, cgroup unit,
   and the host-side log path come from the daemon's `worker-birth` row; the
   counters come from the Worker vitals record. **State the phase in plain words, never as a
   bare enum** — "waiting for the merge poll, 127 of 180, against a PR whose test
   check is red" says what `landing` hides, and "dead at boot:
   refused-over-worker-ceiling" says what an empty vitals row hides. When a field
   has no answer, write `unknown` and name the surface that would have carried
   it; a silently missing field reads as a zero.

3. **Digest the event sequence** — one chronological table of the Worker's life,
   built from the `worker.*` kinds in its log merged with the daemon's
   admission, refusal, birth, and death lines for that Worker id. Keep every
   timestamp; drop the payload noise. The sequence must show the shape of the
   run — born, setup, agent rounds, push, gate, landing heartbeats, park or
   death — so a stall is visible as the gap between two adjacent rows.

4. **Quote the load-bearing log excerpts** — three of them, raw: the boot lines,
   the last agent activity, and the last twenty lines of the Worker log. **Print
   the full paths beside every excerpt**, because an excerpt the operator cannot
   widen is a dead end. Redact absolute home paths, tokens, and session
   identifiers as you copy.

5. **Close with the self-serve diagnosis** — the section the operator actually
   acts on. Say what the current phase means, whether the Worker is stuck and on
   what evidence, and what the evidence says about why. Then list the exact next
   moves as commands and tool calls the operator runs themselves: the `redskilled`
   MCP reads that widen the picture (`status`, `logs`, `claim_status`,
   `deadend_audit`), and the recovery verbs when the state calls for one —
   `hitl_resolve` for a parked human decision, `claim_release` for a claim a dead
   Worker never gave back, `project_reset` for a visible birth latch.
   **Recommend, never execute**: this entry is read-only, so a recovery verb
   belongs in the dossier as a line to run, and the operator decides.

6. **Write the file and print its path.** The dossier goes to the registered
   diagnostics lane as
   `.red/tmp/diagnostics/redskilled-debug-<issue>-<timestamp>.md`, with the
   timestamp from `date -u +%Y%m%dT%H%M%SZ`. Create the lane directory if it is
   absent — it is a registered `.red/tmp/` lane and gitignored. Print the path as
   the last thing you say, and keep the chat summary to a couple of sentences;
   the file carries the detail.

</what-to-do>

<supporting-info>

## Scope Boundary

`/redskilled` is per-machine: it owns the daemon home, host ceilings, status,
and lifecycle. `/red-setup` is per-repository: it is the only authority allowed
to create a checkout's `.red/` and enable plugins there. Route repository setup
to `/red-setup`; route host daemon operation here.

The debug entry is scoped the same way — it explains one Worker's process life
from the daemon's and the Worker's own records. Queue health across the backlog
stays with `/dashboard`, reconstructing one Ticket's *work* state (PRs,
branches, worktrees, blocker) stays with `/retake`, and a parked human decision
stays with `/hitl`. The dossier names those routes; it does not perform them.

Use the ADR 0091 npm direct-run form for every daemon operation. The published
binary is `red-skills-redskilled`; `redskilled` is only the daemon's name, and a
bare invocation is not installed on an operator's machine by default.

## Where the evidence lives

| Surface | Path | What it answers |
| --- | --- | --- |
| Worker log | `.red/tmp/workers/<worker-id>/worker.log.toonl` | Everything the Worker did: lifecycle, stdout, narration, waits, heartbeats |
| Worker workspace | `.red/tmp/workers/<worker-id>/<issue>/` | The run's scratch; `worktree/` is the git checkout |
| Gate artifact | `.red/tmp/workers/<worker-id>/<issue>/validation.jsonl` | What the merge gate ran and what it returned |
| Liveness anchor | `.red/tmp/workers/<worker-id>/liveness.toonl` | Whether the process was alive, independent of narration |
| Host-side stdout | `.red/tmp/logs/<yyyy-mm-dd>/worker-<worker-id>.log` | The raw stream the daemon redirected; its exact path is the `log_path` on the `worker-birth` row |
| Safety log | `.red/tmp/diagnostics/<worker-id>.log` | Process-safety installation and signal handling |
| Daemon log | `~/.red/redskilled/redskilled.log.toonl` | Typed Worker lifecycle, drift, heal, refusal, and daemon-stop records, host-scoped |
| Daemon deaths | `~/.red/redskilled/state/deaths/deaths.toonl` | The daemon's own exit evidence |
| Checkout deaths | `.red/state/deaths/deaths.toonl`, `.red/state/deaths/attributions.toonl` | Launcher and Worker death evidence, with sender attribution |

All of these are TOONL: a segment header declares the columns once and the rows
follow positionally, so read the nearest preceding `[]{...}` header before
interpreting a row. A crash-truncated tail is valid TOONL, not corruption.

## Worker log kinds worth reading

- **Birth and routing** — `worker.claimed` (issue and title), `worker.routed`
  (runner, model tier, effort), `worker.run-started`, `worker.pid`,
  `worker.validation_schedule` (which validation moments are declared),
  `worker.steered` (the handoff path), `worker.implementer-environment`.
- **Progress** — `worker.log` (the narration stream), `worker.heartbeat`,
  `worker.agent`, `worker.subagent_started` / `worker.subagent_heartbeat` /
  `worker.subagent_finished`, `worker.state`.
- **Waiting** — `worker.gate_wait` and `worker.lock_wait` carry a declared
  wait's subject, deadline, and escalation; `worker.landing_heartbeat` carries
  the landing `phase`. A long run of identical landing heartbeats is the exact
  shape of a merge poll that will not converge.
- **Ending** — `worker.validated`, `worker.completed`, `worker.landed`,
  `worker.blocked` (with its `outcome`), `worker.park_loop_detected`,
  `worker.session-error`, `worker.reseeded`.

## Daemon events worth reading

Every row is a flat TOONL record with `version`, `ts`, and the stable `kind`
discriminator. `event` is the one-release compatibility alias for `kind`; new
queries use `kind`. Worker rows also carry `worker_id`, `project_label`, `pid`,
`workspace_path`, `log_path`, `isolated`, `unit`, `memory_high`, `memory_max`,
and `cpu_weight`. Fields that do not apply to a kind are `null`, never omitted,
so one segment header remains valid for the complete vocabulary.

| `kind` | Kind-specific fields |
| --- | --- |
| `worker-birth` | `admission_verdict`, `fork_sha`; the common placement and budget fields describe what the host admitted |
| `worker-activity` | `phase`, `step`; appended only when either published value changes |
| `worker-drift` | `fork_sha`, `base_head_sha`, `base_commits_ahead`; one stamp when the daemon's refreshed comparison changes |
| `worker-heal` | `heal_kind` (`mechanical-regeneration`) and `detail` |
| `worker-death` | `detail`, `exit_code`, `signal`, `reason` |
| `worker-budget-kill` | `detail`, `exit_code`, `signal`, `reason`; distinct from ordinary death so host-pressure terminations are countable |
| `demand-refusal` | `project_label`, `detail`; no Worker existed, so `worker_id` is the synthetic `demand:<project>` key |
| `daemon-stop` | `reason`, `detail`, `signal`; `worker_id` uses the synthetic `daemon:<pid>` key |

The admission vocabulary carried by `admission_verdict` is `admitted`,
`admitted-interactive-reservation`, `refused-over-worker-ceiling`,
`refused-over-memory-ceiling`, `refused-over-interactive-reservation`,
`refused-unreachable-trunk-remote`, and `refused-unaccountable-budget`.

### Canonical `tq` recipes

Use `tq` directly on the daemon's TOONL lane; there is no report verb and no
separate metrics file. Replace the fixture date and Worker id with the instant
and Worker being investigated.

Today's performance — the chronological host facts since UTC midnight:

```bash
tq -p toonl -o json -c 'select(.ts >= "2026-08-05T00:00:00.000Z") | {ts: .ts, kind: .kind, worker_id: .worker_id, project_label: .project_label, phase: .phase, exit_code: .exit_code}' ~/.red/redskilled/redskilled.log.toonl
```

One Worker's story:

```bash
tq -p toonl -o json -c 'select(.worker_id == "wDOCS") | {ts: .ts, kind: .kind, phase: .phase, step: .step, base_commits_ahead: .base_commits_ahead, heal_kind: .heal_kind, exit_code: .exit_code}' ~/.red/redskilled/redskilled.log.toonl
```

Drift and mechanical-heal counts over the selected lane:

```bash
tq -p toonl -o json -c --slurp '{drift: map(select(.kind == "worker-drift")) | length, heals: map(select(.kind == "worker-heal")) | length}' ~/.red/redskilled/redskilled.log.toonl
```

## Dossier shape

Follow `/handoff`'s document conventions — hand over context, not content;
reference artifacts rather than reproducing them — with the sections adapted to
this dossier:

```markdown
# redskilled debug — issue #<n> — <UTC timestamp>

## Fiche
| Field | Value |
| --- | --- |
| Issue | #<n> — <title> — <link> |
| PR / branch | <#pr and link, or "none"> |
| Project | <project label> |
| Worker | <worker-id> (pid <pid>, unit <unit>) |
| Runner | <runner> / <model> / effort <effort> |
| Bundle | <version> |
| Started | <iso> |
| Phase | <plain-words state> |
| Last heartbeat | <iso> (<age> ago) |
| Progress | +<loc_added>/-<loc_removed>, <tools_called_count> tools, <input+output> tokens |

## Event sequence
| When | Source | What happened |
| --- | --- | --- |
| <iso> | daemon | worker-birth ... |
| <iso> | worker | worker.claimed ... |

## Log excerpts
### Boot — `<path>`
### Last agent activity — `<path>`
### Last 20 lines — `<path>`

## Diagnosis
<what the phase means, whether it is stuck, what the evidence says about why>

## Next moves
1. <exact command or redskilled tool call> — <what it answers or repairs>

## References
- <path-or-url>: <one-line description>
```

## Known gap: no issue-keyed resolver

No redskilled tool takes an issue number and returns the Worker(s) that ran it. The
tool answers are Worker-keyed, so resolution is a client-side filter over
`status { scope: "worker", live_only: false }` plus `claim_status`, and a Worker
the daemon refused never appears in either — only the lane scan finds it. This
entry documents the fallback rather than adding a verb; a future slice may key
the resolution in the tool surface.

</supporting-info>
