# redskilled

The host-scoped execution daemon of ADR 0130: **exactly one singleton per
machine, behind a unix socket**, owning Worker processes across every project on
that machine while each project's bundle keeps owning the work. A second OS user
on the same machine is refused by name rather than served or silently doubled
(Amendment 3).

The core exists, is reachable, honest about its own life — and **births Workers**:
a project hands over an argv, a placement target, a budget and two opaque
strings, and the daemon launches the Worker into a resource unit of its own.
**A restart costs none of it**: the daemon re-attaches to its live Workers by
unit name and rehydrates identity and budget from its own append-only event lane.

## Why its own app

The vendored `packages/red-castle` cannot *be* this daemon: every checkout
carries its own copy, so a host-scoped singleton living there would be N
singletons. The rsp core is repository-scoped and deliberately minimal, so the
daemon does not belong inside it either. It lives here and consumes the shared
resident infrastructure (`packages/shared/resident-core.ts`) rather than a copy
of it.

## What it owns

| Concern | Where it lives |
| --- | --- |
| Which session a daemon serves | `src/paths.ts` — session key, socket, lock, lease |
| Who owns the session across restarts | `src/session-lease.ts` — pid + start time, TOON on disk |
| Who owns the socket right now | `src/daemon.ts` — exclusive bind |
| The frozen wire contract | `src/protocol.ts` — `ping`, `host-state`, `statusline-payload`, `statusline-string`, `worker-start`, `worker-command`, `worker-heartbeat`, `shutdown` |
| Who may read and who may write | `src/session-reach.ts` — read the host, write the project |
| What this machine is doing, in one document | `src/statusline-payload.ts` — Workers, projects, vitals, budgets, staleness |
| That same answer, as a finished line | `src/statusline-render.ts` — modes, degradation, width; a pure function of the payload |
| The declared defaults and the flag above them | `src/statusline-config.ts` — `plugins.dev.statusline.*`, resolved client-side |
| A Worker's last logged line, published not read | `src/worker-log.ts` — the heartbeat's opaque string, and the restart-only recovery |
| Where a Worker's resources are charged | `src/worker-placement.ts` — pure planner over injected probes |
| Birth itself | `src/worker-launch.ts` — plan, spawn once, report the downgrade |
| The host-wide read | `src/host-state.ts` — total shape, Workers plus the budget total |
| What the daemon remembers across a restart | `src/event-lane.ts` — append-only TOONL: birth, death, budget-kill, and the daemon's own stop |
| What a stop is giving up | `src/daemon-stop.ts` — the pure report: what is held, what survives, why it stopped |
| Finding the Workers a restart left running | `src/reattach.ts` — the unit name first, the pid only as fallback |
| What the host has been promised | `src/budget-accounting.ts` — pure totals over the Worker set |
| Reaching (and starting) the daemon | `src/client.ts` — auto-spawn, loser joins the winner |
| Which file a spawn runs | `src/daemon-entry.ts` — the published bundle by name, never the caller's own entry |
| Reviving a daemon nobody asked for | `src/supervision.ts` — the optional user unit, `Restart=on-failure` |
| Becoming the version that is published | `src/self-replace.ts` — decide, find the successor, hand the session over |
| The home, and the route to a reachable daemon | `src/provision.ts` — the ONE creator of `~/.red/redskilled/`, the pure provisioning audit, and the optional user unit |
| Clearing the sessions that died | `src/reclaim.ts` — the lease decides, another tool's directory is left alone |

## Behaviours worth knowing

- **The start race resolves twice.** The spawn lock stops N clients launching N
  processes; the exclusive bind stops the ones that slip past from both
  believing they own the socket. The loser waits and connects to the winner — it
  never fails.
- **A spawn runs the published bundle, and refuses rather than fall back.** The
  entry is resolved by name — `REDSKILLED_BIN`, the caller's entry *only when it
  is itself a redskilled entry*, then the bundle shipped beside a host, the repo
  `dist/`, the workspace, the installed package, the bundle cache — and an
  unresolvable bundle throws `RedskilledDaemonEntryError` naming every path it
  probed. Re-executing the caller's own entry is the defect this repository has
  already fixed twice (#2736, #2677): the launcher's version becomes the
  daemon's, so a stale caller mints a staler daemon and the skew widens.
- **No host answered is not the host answering nothing.** Every failure to reach
  the daemon — an unresolvable bundle, a spawn that never bound, a socket that
  died mid-request — surfaces as `RedskilledUnreachableError` carrying its cause.
  An operator reading an empty host state must be reading an idle machine, never
  a failed lookup.
- **A pid is not an identity.** The lease pins `pid` *and* `start_time`, so a
  former process whose pid the OS reused cannot renew or release the current
  holder's lease. A crash leaves the record behind on purpose; the next acquirer
  reaps it.
- **Idle exit is gated on Workers.** The daemon rearms instead of exiting while
  it believes a Worker is alive (ADR 0130 rule 7).
- **Fail closed.** No daemon, no Worker. A client that cannot reach the daemon
  throws; there is no quiet local fallback, because for a launcher failing open
  costs the machine.
- **The daemon receives paths, never derives them.** No marker file is looked
  for, no parent directory walked, no layout assumed. That is what lets one
  daemon serve checkouts pinned to different bundle versions.
- **A transient service unit, never a scope.** A scope runs inside the caller's
  unit and cannot outlive it, so every Worker would die with the daemon that
  asked for it. A service unit is owned by the init system, which is what later
  lets the daemon restart without taking every project's work down with it.
- **Placement is decided at launch.** Moving a running process between resource
  groups does not move its existing memory charge, so a Worker born in the
  caller's group stays charged there for life no matter what is done afterwards.
- **A restart re-attaches, it does not restart the work.** The daemon replays its
  event lane, asks the host about each Worker by unit name, adopts the ones still
  running and records the deaths of the ones that ended while nobody was
  watching. A pid is only consulted for a Worker that never got a unit.
- **A death is the host's answer, never the launch client's exit.** Under the
  transient-unit backend the process the daemon watches is `systemd-run --wait`,
  standing beside the unit rather than being it — and the daemon's own teardown
  kills that client while the Worker keeps running. Writing the exit onto the lane
  as a death is what let a live Worker escape the budget permanently (#2917):
  every successor replayed the death and adopted nothing. An exit is now resolved
  against the unit before it is believed, and the pid the daemon then watches is
  the unit's own, because a budget sampled through a reclaimed pid is unmeasured.
- **A birth is acknowledged only once it is on the lane.** The client is told its
  Worker exists after the record reaches disk, so a daemon replaced a millisecond
  later cannot leave a live Worker whose birth nothing wrote — and a signalled
  daemon stops rather than being cut off, flushing the lane on its way out.
- **The lane is this daemon's memory; the host is the machine's.** A start also
  asks the init system for the Worker units no lane accounts for and adopts them,
  named as unowned rather than left invisible: an unheld Worker is room the next
  admission believes the machine has and it does not. Only the daemon holding the
  machine-wide claim sweeps — a second instance adopting the arbiter's Workers
  would be the same accounting hole from the other side — and
  `REDSKILLED_UNIT_DISCOVERY=off` declines the sweep outright.
- **Three facts on the lane, and no per-Worker durable record.** Birth, death and
  budget-kill are the daemon's own — issue-to-PR belongs to the tracker and
  branch-to-commits to git, and a third copy of those would only drift.
- **A crash costs the event in flight, never the lane.** An unterminated final
  line is read as absent (TOONL's own rule for a truncated open tail) and dropped
  before the next append, so a half-written record can never fuse onto the next.
- **Reach is asymmetric: read the host, write the project.** A session reads
  every project's Workers, because diagnosing contention from wherever you happen
  to be is the problem the daemon exists to solve. Dispatch, stop, recycle and
  steer are refused into any project but the session's own — these sessions are
  largely driven by autonomous agents that do not understand a repository they
  were not started in. A refusal never distinguishes "no such Worker" from "not
  your Worker", so a session cannot map another project by guessing.
- **Staleness travels inside the payload.** The daemon measures on its own tick
  and dates the answer itself, so a consumer renders the age rather than
  re-deriving it — which is what stops two surfaces from reporting different
  answers about the same instant. A tick that failed to read the host ages the
  payload instead of refreshing it, and an unmeasured Worker is `null` and named,
  never a zero that reads as idle.
- **The string is a pure function of the payload.** Two surfaces exist because a
  host wants a line and a UI wants structure; purity is what stops them becoming
  two answers. The daemon renders the string from the very payload the other op
  returns, and a test proves the daemon's line equals `renderRedskilledStatusline`
  over the payload read beside it — so **no agent host renders anything**: it runs
  `redskilled statusline` and prints what comes back.
- **The default mode is the local project; `global` is the whole machine.** The
  common case is one operator in one repository, so the quiet default lists only
  that project's Workers. `global` lists every project's and names the owner of
  each — an anonymous Worker on a busy machine is what the mode exists to fix.
- **A crowded machine degrades, it never overflows.** When the Workers do not fit
  the count budget or the width, the line drops to one entry per project; when
  the projects do not fit either, it drops to the host total. Detail is lost on
  purpose and the loss is stated (`detail`, `degraded`) rather than left to be
  detected by re-parsing the line. The full picture stays with the dashboard and
  the monitor.
- **`--verbose` adds a second line per Worker, and the Worker supplies it.** The
  Worker publishes its last logged line on its heartbeat (`worker-heartbeat`) as an
  opaque string; the daemon stores and returns it without ever parsing it, so the
  whole global verbose view is still ONE read and opens no project's files. A
  statusline that read each Worker's log itself would cost a disk read per Worker
  per render, cross a project boundary, and hand every surface a private source.
  A Worker that has logged nothing gets no second line at all.
- **A restart is the one time the daemon reads a log — from the path it was given.**
  A daemon that just came back holds Workers it has heard no heartbeat from, so for
  those it reads once, using the `log_path` the client handed over at spawn and the
  event lane carried through. A Worker whose client gave no path waits for its next
  heartbeat; guessing a filename inside its workspace would be the derived layout
  rule 3 forbids. Recovery is not the normal path, and the payload says which lines
  came from it (`log.source`).
- **Defaults are declared once, in `plugins.dev.statusline.*`.** `mode`,
  `max_workers`, `max_projects`, `max_width` and `verbose`; a flag beats config, config
  beats the built-in. Config is read **client-side** — the daemon may not know
  what a `.red/config.yaml` is — so only decided values cross the socket. A
  malformed value is named on stderr and ignored, never fatal: this line renders
  on every turn, and a blank statusline is the harder failure to diagnose.
- **Supervision is optional; auto-spawn is the floor.** `redskilled unit install`
  writes a user unit whose `ExecStart` is the very argv a client spawn builds —
  one builder, so a flag cannot reach one start path and miss the other — plus
  `Restart=on-failure`, which is what revives a daemon that died *without a
  client having to want work first*. A host that never installs it is a supported
  configuration and the status says so (`floor: "auto-spawn"`); the binary, the
  socket and the contract are identical either way.
- **A superseded daemon replaces itself, and a Worker never notices.** The daemon
  resolves the published version on its own tick and, when a newer one exists,
  finds a successor that runs *exactly that version*, flushes the lane, lets go
  of the socket and the lease, and starts it — or, under a supervisor, exits
  non-zero so `Restart=on-failure` starts it. Workers are init-system units, so
  this is a restart and not an evacuation: the successor re-adopts every one of
  them off the lane. A published bundle this host cannot reach costs the upgrade
  and nothing else, because the successor is found *before* anything is given up.
- **The version it reports is the version it runs.** The published answer travels
  beside the running one (`upgrade.published_version` next to `daemon_version`),
  never folded into it, and an unresolvable read stays `published_unknown` rather
  than becoming a match — a manufactured zero skew is exactly how a stale process
  looks current while every Worker halts on the version it claimed to measure.
- **A major boundary is held, and the hold is said out loud.** The self-replacement
  only ever resolves inside the running major, because a breaking change must not
  arrive on a machine that is holding Workers just because a timer noticed it. The
  hold is reported rather than kept: `upgrade.newest_published_version` names the
  newest release whatever its major, `upgrade.major_held` is 1 while one is being
  withheld, and `upgrade.major_hold` carries the reason and the manual step that
  crosses it — re-pointing the unit under supervision, stopping this daemon
  without one. A silent hold is indistinguishable from being current, which is how
  an operator who updated the plugin to a new major and saw nothing change was
  left with no surface to ask (#2926). A daemon that is genuinely current, one
  merely behind inside its major, and one whose probe resolved nothing all report
  no hold at all.
- **Stop is asked for, never signalled.** `redskilled stop` reports the Workers
  and projects the daemon is holding, states that every one of them survives —
  they are init-system units, so a stop is a restart and not an evacuation — and
  writes the intent to the event lane BEFORE the operator is told, so a successor
  replaying the lane can tell a planned handover from a crash. A signal reaches
  the same code and records itself as a signal; the reason is a field, not a
  sentence to parse. A socket nobody answers on is a success with a stated reason:
  the operator asked for a machine with no daemon on it and that is what they have.
- **An unisolated launch is never silent.** When the host affords no transient
  unit the Worker still starts, and the reply — and the host-state record it
  keeps for its whole life — carries a warning naming what was lost. A declared
  budget that cannot be enforced says so as its own warning.

## Provisioning

A daemon starts on first use, but three things must exist before it can: the
host-scoped home, a published bundle to run, and a socket that answers. One
command establishes all three, and `/red-setup` (Section E3) runs it:

```bash
redskilled provision              # create the home, start the daemon, print the audit
redskilled provision --check      # the read-only half — creates nothing, starts nothing
redskilled provision --install-unit   # also write the optional supervising user unit
```

- **The home is this app's.** `~/.red/redskilled/` is operator-scoped and sits
  outside every checkout, so it is not the `.red/` ADR 0067 gave `/red-setup`
  sole authority over. `provisionRedskilledHome` is the only thing that creates
  it (ADR 0130 Amendment 2); every other surface reads the one namer in
  `packages/shared/redskilled-home.ts`. A home only an interactive installer
  could create would leave auto-spawn failing closed forever on a fresh machine.
- **Idempotent by construction.** An existing home is kept with everything in
  it, and the only thing a second run can change is a permission bit that
  drifted wider than owner-only — a repair, not a rewrite.
- **The audit is pure, and the doctor consumes it.** `/red-doctor` renders the
  same four checks (`home`, `daemon-entry`, `reach`, `supervisor-unit`) from
  `auditRedskilledProvisioning` over injected facts, probing the socket
  **without spawning** the daemon it reports on.
- **The optional unit is optional.** It adds `Restart=on-failure` over the same
  binary, socket and contract auto-spawn uses (rule 7), and an absent unit is
  reported as `ok`. An existing unit file is never rewritten.

## Reaching the binary

Three routes, and **which one you pick is a decision about pinning, not about
taste**:

```bash
npx -y -p @reddb-io/red-skills@<version> redskilled host-state   # CANONICAL
npx -y @reddb-io/red-skills@latest redskilled host-state         # alias, shorter
./bin/redskilled host-state                                      # this clone
```

- **The version-pinned `-p` form is canonical** (ADR 0091). It is the only form
  that states *which* installation answers: a bare name resolved off `PATH` can
  reach a different install than the one intended, which is the defect PR #2465
  fixed. Anything that dispatches programmatically — the self-replacement's own
  successor lookup included — uses this form.
- **`redskilled` is an ergonomic alias, not a second contract** (#2960). It is
  the name an operator reaches for, so the package publishes it; `rsp` already
  ships bare from the same `bin` map. The older `red-skills-redskilled` keeps
  working unchanged — this added a name, it renamed nothing — and all three
  execute the one `dist/redskilled.bundle.min.mjs`, so `--version` answers
  identically whichever you type.
- **`./bin/redskilled` runs out of the checkout**, resolving the repo from its
  own path rather than the cwd. It takes the built `dist/` artifact when there is
  one and the workspace TypeScript runner over `src/cli.ts` otherwise, and with
  neither it refuses and names both routes. It exists because an operator
  debugging a broken daemon should not need a working registry fetch to run the
  binary that reports what is broken.

## Commands

```bash
pnpm -C apps/redskilled test        # the focused suite
pnpm -C apps/redskilled typecheck
pnpm -C apps/redskilled serve       # run the daemon on this session's socket
```

```bash
redskilled stop                             # stop the daemon; print what survives it
redskilled stop --reason "moving to 3.0.3"  # the words ride onto the event lane
```

```bash
redskilled statusline                       # this project's Workers
redskilled statusline global                # every project's, each showing its owner
redskilled statusline --max-width 60        # a flag overrides the declared default
redskilled statusline global --verbose      # each Worker plus the last line it logged
redskilled statusline --no-verbose          # one read without the second lines
```

```bash
redskilled unit status                      # is a supervisor installed? (absent is fine)
redskilled unit install                     # write the user unit and enable it now
redskilled unit uninstall                   # remove it; auto-spawn stays the floor
```

```bash
redskilled reclaim --dry-run                # what a sweep would take, and why
redskilled reclaim                          # remove the runtime dirs whose owner is gone
redskilled reclaim --grace-ms 60000         # how old a lease-less dir must be to count
```

## Reclaiming dead sessions

A daemon that crashes leaves its runtime directory behind: a socket nothing
listens on, a lease naming a pid that died, an event lane nobody will rehydrate.
`redskilled reclaim` sweeps both runtime parents — the `XDG_RUNTIME_DIR` one and
the `tmpdir()` fallback — and reports every directory it looked at.

- **The lease decides, not the directory.** A dead pid in a lease is proof the
  holder is gone; nothing else on disk proves anything. A lease naming a live
  pid keeps its directory whatever else it contains.
- **A directory with no lease is only a corpse once it is stale.** A daemon
  mid-spawn has made its directory but not yet won its lease, so a lease-less
  directory younger than the grace window is reported `young` and kept — as is
  one whose socket still answers.
- **The runtime parent is shared, so foreignness is judged by name.** `rsp`'s
  resident sockets live under the same `red-skills/` parent. Only `redskilled.*`
  files are this sweep's business; a directory holding anything else is reported
  `foreign` and left alone.
- **The report is the point.** An operator reaching for this is usually
  mid-diagnosis — "which of these is a live daemon" is the question — so the
  sweep names every directory and its reason, and `--dry-run` is that same report
  with nothing removed.
