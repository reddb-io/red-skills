# herdr-plugin-red-skills

A [herdr](https://herdr.dev) plugin that watches **`redskilled`** — the
host-scoped execution daemon of [reddb-io/red-skills](https://github.com/reddb-io/red-skills)
(ADR 0130): exactly one singleton per machine, behind a unix socket, owning
Worker processes across every project on that machine.

It answers, in one pane, the question the daemon exists to make answerable:
**what is this machine currently doing.**

- **Workers** — every live Worker across every project, with its state, uptime,
  measured RSS against its declared budget, whether it got a unit of its own,
  and the last line it published.
- **Logs** — a Worker's own log tailed from the path the daemon was handed at
  spawn, and the host event lane: birth, death, budget-kill.
- **Pull requests** — each registered project's open PRs, open issues and
  recently closed work, polled once per interval for the whole host.
- **Notifications** — a herdr notification when a Worker ends, when one is
  killed over budget, when the daemon goes away or comes back, when a project's
  open PR count rises, and when the daemon has an upgrade waiting.

```
 redskilled 0.4.1 · pid 4242 · up 3h00m · proto 1                                                      ● live
 host b3f2a19c0d55 · session 9c0d41ba7e12 · scope machine · measured 5s ago
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 HOST   2 workers · 2 projects · slots 2/6   mem 3.00G/8.00G █████░░░░░░░░░  38%
        observed 900M · measured 1/2 · MemoryMax 3.00G · MemoryHigh 2.00G · cpu weight 200
        ⚠ 1 unisolated — charged to the daemon, not to a unit
─ WORKERS ────────────────────────────────────────────────────────────────────────────────────────────────────
   worker         project                    state           up      rss/budget  used          %
 ▸ w-2f91a        reddb-io/red-skills        running     18m00s     900M/2.00G   ████░░░░░░  44%
     ⤷ gate: vitest packages/red-castle …
   w-idle         reddb-io/red-dev           reattached   2m00s        —/—       ░░░░░░░░░░    —  ⚠ no unit
─ PROJECTS ───────────────────────────────────────────────────────────────────────────────────────────────────
   project                        workers  declared  observed  registration
   reddb-io/red-dev                     1     1.00G        0B  —
   reddb-io/red-skills                  1     2.00G      900M  renewing · target 3
─ PULL REQUESTS ──────────────────────────────────────────────────────────────────────────────────────────────
   repository                          open PR  issues  closed  state
   reddb-io/red-skills                      12      48      31  30s ago
   reddb-io/red-dev                          —       —       —  unreachable
   quota 4832 left · resets 13:02Z · one request for every project (ADR 0130 Am. 1)
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 q quit  r refresh  j/k select  l logs  e events  g local  v quiet  ? help
```

## Install

The plugin lives at `apps/herdr-plugin-red-skills/` in the
[reddb-io/red-skills](https://github.com/reddb-io/red-skills) monorepo (ADR
0131). Install it by linking that directory from a checkout with its workspace
installed:

```bash
pnpm install                             # from the repo root, once
herdr plugin link apps/herdr-plugin-red-skills
```

Nothing durable is kept in the plugin root, so replacing it loses nothing:
config and state live in `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR`.

Requirements: **herdr 0.7.5+** and **Node.js 20+ on PATH**. There is no build —
every command is plain Node ESM run straight from the checkout. Two workspace
dependencies are resolved by `pnpm install` and nothing else: `@reddb-io/toon`,
which is the format the daemon wire and this plugin's own files are written in,
and `@reddb-io/build-info`, which is where `--version` reads its answer.

You also need a `redskilled` daemon. This plugin never starts one; bring one up
the way red-skills does:

```bash
redskilled provision
```

### Trying it without one

On a machine that has never run `redskilled` there is nothing to point at, so
the panes would only ever show their "no host answered" frame. `scripts/demo.sh`
starts a fake daemon that speaks the same wire contract and **moves** — Workers
born and retired, RSS drifting until one crosses its budget, logs growing, the
event lane gaining rows, the PR count creeping up — which is what makes the log
view, the event view and every notification reachable by hand.

```bash
sh scripts/demo.sh start     # fake daemon + a config pointing at it
sh scripts/demo.sh status
sh scripts/demo.sh stop      # kill it and put your own config back
```

Nothing it shows is true, and the config it writes says so in a `_comment`. An
existing config is moved aside rather than overwritten, so `stop` gives back
exactly what was there.

## Use

| Action | What it does |
| --- | --- |
| `RedSkills: toggle dashboard` | the live pane, split beside the current one |
| `RedSkills: dashboard in a tab` | the same pane, in a tab of its own |
| `RedSkills: toggle worker log` | tail the newest Worker's log |
| `RedSkills: toggle host event lane` | birth, death and budget-kill, as they land |
| `RedSkills: notify host status` | one read, raised as a herdr notification |
| `RedSkills: doctor` | where the socket resolved from, and what answered |

Bind whichever you reach for; the rest live in herdr's action menu.

### Keys

| Key | In the dashboard |
| --- | --- |
| `q` | close the pane |
| `r` | re-read the daemon now |
| `j` `k` `↑` `↓` | move the Worker selection |
| `l` / `enter` | open the selected Worker's log in this pane |
| `e` | open the host event lane |
| `g` | toggle between this project and the whole machine |
| `v` | toggle each Worker's last published line |
| `n` | send the current status as a herdr notification |
| `?` | help |

In a log view: `q` back, `f` follow/pause, `j`/`k` scroll, `g`/`G` top/end,
`r` refresh.

### From a shell

The same entry runs outside herdr, which is what makes it debuggable:

```bash
node bin/red-skills-herdr.mjs doctor          # why this plugin sees what it sees
node bin/red-skills-herdr.mjs status          # the daemon's own status line
node bin/red-skills-herdr.mjs status --json   # the line, the payload, and the socket
node bin/red-skills-herdr.mjs dashboard       # the pane, in this terminal
node bin/red-skills-herdr.mjs logs --worker w-2f91a
node bin/red-skills-herdr.mjs logs --events
node bin/red-skills-herdr.mjs watch --once    # one poll, printing what it would notify
```

## Configuration

`herdr plugin config-dir reddb-io.red-skills` prints the directory; the file is
`config.toon` in it. `red-skills-herdr init-config` writes the defaults out once
so there is something to edit. A malformed file is named on stderr and ignored —
this runs a pane that opens on session restore, and a plugin that refused to
start over a stray comma is the harder failure to diagnose.

```toon
refreshMs: 2000
mode: global
verbose: true
socketPath: null
timeoutMs: 2000
notifications:
  enabled: true
  pollMs: 15000
  renotifyMs: 900000
  position: top-right
  sound: none
  workerBirth: false
  workerDeath: true
  budgetPressure: true
  budgetPressureAt: 0.9
  daemonReach: true
  pullRequests: true
  staleness: true
  upgrade: true
```

A `config.json` written against the pre-absorption plugin is not read. Every
value in it is a default the plugin already declares, so `init-config` writes a
fresh `config.toon` and there is nothing to migrate but the edits you made.

`REDSKILLED_SOCKET` (or `socketPath`) pins the daemon socket ahead of every
derivation. `--socket` does the same for one command.

## How it reads the daemon

The socket path is derived exactly as `redskilled` derives it —
`REDSKILLED_SESSION`, else `XDG_RUNTIME_DIR`, else the uid; hashed into
`<runtime>/red-skills/<hash>/redskilled.sock`, with the `tmpdir()` fallback for
a path too long for `sun_path`. Requests are TOON frames over that socket,
terminated by a blank line, exactly as `apps/redskilled/src/protocol.ts` and
`packages/shared/resident-wire.ts` specify. The wire is TOON in both directions
and carries no JSON fallback: a daemon too old to read a TOON frame (before
issue #2947) cannot answer this plugin's questions either, so its reply is
reported as "nothing intelligible answered" rather than decoded into a refusal.

Four ops, and no others:

| Op | What this plugin does with it |
| --- | --- |
| `ping` | the doctor's reachability check |
| `host-state` | registrations, scope, upgrade state |
| `statusline-payload` | Workers, vitals, budgets, projects, repository activity |
| `statusline-string` | the notification and `status` line, rendered by the daemon |

Some properties this plugin holds itself to, because the daemon holds itself to
them:

- **It reads and never writes.** ADR 0130 rule 9 makes reach asymmetric — read
  the host, write the project — and a monitor belongs entirely on the reading
  half. `worker-start`, `worker-command`, `project-register` and `shutdown` are
  never sent, and a test asserts it.
- **It never spawns the daemon.** A pane opening on session restore must not be
  what starts a machine-wide singleton. An absent daemon is reported as absent.
- **An absence is never a zero.** An unmeasured Worker renders `—`, not `0B`.
  An unreachable repository renders `—`, not `0` open PRs. A daemon that did not
  answer renders as an outage, not as an idle machine.
- **Staleness is rendered, never re-derived.** The payload dates itself and this
  pane prints the age it was handed, so it cannot disagree with the statusline
  beside it about the same instant.
- **The status line is the daemon's.** ADR 0130 rule 10 keeps the string a pure
  function of the payload precisely so no surface reimplements it; this plugin
  asks for it rather than drawing its own.
- **The event lane reader is tolerant.** The lane is written by a daemon version
  this plugin does not ship with, so it sniffs JSON, decodes TOONL segments, and
  keeps a line it cannot decode as raw text rather than dropping it.

## Notifications

The watcher is the only long-lived process here. herdr's startup hook runs
`watch --detach`, which re-execs the loop as a detached child and returns — the
hook must return and the poller must not. The child holds a single-instance
lock, so a herdr restart or a second session never becomes two watchers saying
the same thing twice.

The bar for a notification is a **transition**, never a state: "12 PRs are open"
is the dashboard's job and "a 13th opened" is the watcher's. A first read
announces nothing, and a daemon that just came back is treated as a fresh
baseline rather than a burst of births.

How a Worker ended comes from the event lane rather than from set arithmetic:
the lane knows whether it exited 0, was killed over budget, or took a signal,
and that difference is the reason anyone wanted to be told. When the lane cannot
be read, the notification says the host no longer holds the Worker and that the
lane did not say how it ended — rather than inventing a clean exit.

## Development

`pnpm -C apps/herdr-plugin-red-skills test` is what the shared gate runs: the manifest
check and the suite, in that order. Each half also runs on its own.

```bash
node --test "tests/*.test.mjs"        # 61 tests
python3 scripts/check-manifest.py     # ids unique, every unix entry has a Windows twin
sh scripts/smoke.sh                   # every command once, against the fake daemon
node scripts/preview.mjs --columns 80 --rows 24   # draw a frame from fixtures
node scripts/fake-daemon.mjs --socket /tmp/rs.sock --static &
REDSKILLED_SOCKET=/tmp/rs.sock node bin/red-skills-herdr.mjs dashboard
```

`scripts/preview.mjs` exists because a pane is the one surface you cannot
code-review by reading it: alignment, colour and truncation are only true at a
width.

## Layout

```
bin/red-skills-herdr.mjs  the single entrypoint; --help and --version answer offline
src/redskilled/           the daemon: socket derivation, wire, client, event lane, log tail
src/ui/                   ansi widths, formatters, the screen loop, the three views
src/commands/             dashboard, logs, status, watch, pane, doctor
src/watch/signals.mjs     what changed between two reads, as things worth interrupting for
herdr-plugin.toml         panes, actions, the startup hook, and their Windows twins
.upstream                 the repository this directory was absorbed from, and at which commit
```

The binary is `red-skills-herdr`, not `red-skills`: the monorepo already ships
`@reddb-io/red-skills`, and two packages claiming one bin name is a collision
resolved by whichever installed last.

## Licence

Apache-2.0, matching reddb-io/red-skills.
