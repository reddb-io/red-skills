# vscode-extension-red-skills

A VSCode extension that connects to the `redskilled` host daemon (ADR 0130) and
surfaces its state inside the editor: a status-bar statusline, a dashboard panel
carrying the same header and Worker rows, the live Workers with their vitals, a
per-Worker log panel, the host event lane, the open pull requests of every
registered project, and a notification whenever any of it changes.

**It reads and never writes.** ADR 0130 rule 9 makes reach asymmetric — a session
reads the whole host and writes only its own project — so the extension sends
`ping`, `host-state`, `statusline-payload` and `statusline-dashboard`, and
nothing else. It also never
starts the daemon: `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision`
and the dev bundle own auto-spawn, and
a tree view restoring with a window must not be what births a machine-wide
singleton. An absent daemon is reported as absent.

## What it shows

| View | Reads | Answers |
| --- | --- | --- |
| **Workers** | `statusline-payload` | What is running now — RSS against the declared ceiling, uptime, isolation, the last line each Worker logged |
| **Host events** | the TOONL event lane beside the socket | What *happened* — births, deaths with their exit status, budget kills, the daemon's own stop |
| **Pull requests** | `statusline-payload` | Each registered project's open PR and issue counts, as the host polled them |
| **Worker log** | the Worker's own `log_path` | The tail of one Worker's log, following it as it grows |
| **Status bar** | `statusline-dashboard` | The daemon's own header line: repo, version, model, slots, memory, prs/cpr/iss |
| **Dashboard panel** | `statusline-dashboard` | The same header plus one row per Worker — runner/model/effort, origin, issue, the pipeline bar, phase·step, elapsed, heartbeat, loc, tokens, tools, reasoning, text |

**THE DAEMON AGGREGATES AND RENDERS; SURFACES PRINT.** The header line and every
Worker row arrive finished from `statusline-dashboard`; nothing here recomputes a
cell. ADR 0130 rule 10 keeps that answer a pure function of the payload precisely
so no surface reimplements it — an editor panel and a herdr pane each doing their
own Worker math would be two dashboards lying in two different ways about the
same instant.

The socket answers "what is running NOW" and the lane answers "what happened".
Both are read every tick, because a view holding only one of them can always be
asked a question it cannot answer — a Worker that vanished between two reads tells
you it is gone, and only the lane tells you whether it exited 0, was killed over
its ceiling, or took a signal.

## Notifications

A notification is an interruption, so the bar is a **transition**, never a state:
"12 pull requests are open" is the tree's job and "a 13th opened" is the
notifier's. The first read of a session is deliberately silent, and so is the
first read after the daemon comes back — otherwise the loudest moment of the day
would be a wall of facts that had not changed.

Every kind can be turned off, and each has a renotify window
(`redskilled.renotifyMs`, five minutes by default) so a flapping host cannot
produce a stream of identical toasts. `redskilled.notifications.workerBirth` is
**off by default**; on a busy host it would be the loudest thing in the editor.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `redskilled.socketPath` | *(empty)* | Pin the daemon's unix socket. Empty derives it exactly as the daemon does: `REDSKILLED_SESSION`, then `XDG_RUNTIME_DIR`, then the uid. A pin moves the event lane with it. |
| `redskilled.pollIntervalMs` | `4000` | How often to read the host; clamped to 500 ms. |
| `redskilled.renotifyMs` | `300000` | How long one notification key stays silent after it fired. |
| `redskilled.notifications.*` | see above | Which transitions are worth interrupting for. |

The socket path is reported in the "not answering" tooltip along with the rule
that produced it, because that is the question asked precisely when nothing
answers.

## Installing

**Download the `.vsix` from a release and install it.** No checkout, no `pnpm`,
no build:

```sh
gh release download --repo reddb-io/red-skills --pattern 'vscode-extension-red-skills-*.vsix'

code --install-extension vscode-extension-red-skills-*.vsix     # VS Code
codium --install-extension vscode-extension-red-skills-*.vsix   # VSCodium
```

Without `gh`, the same file over plain HTTP — the redirect on `/releases/latest`
names the version, which is the one thing a download URL cannot guess:

```sh
version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
  https://github.com/reddb-io/red-skills/releases/latest | sed 's#.*/v##')
curl -fsSLO "https://github.com/reddb-io/red-skills/releases/download/v${version}/vscode-extension-red-skills-${version}.vsix"
code --install-extension "vscode-extension-red-skills-${version}.vsix"
```

The archive is stamped with the product version, so a locally packaged successor
installs over the previous one instead of being refused as already installed.

### Building it yourself

The contributor path, for a change you are making rather than a version you want:

```sh
pnpm -C apps/vscode-extension-redskilled build      # typecheck + bundle out/extension.cjs
pnpm -C apps/vscode-extension-redskilled package    # write dist/vscode-extension-red-skills-<version>.vsix
code --install-extension dist/vscode-extension-red-skills-0.1.0.vsix
```

The `.vsix` reaches **no marketplace** — that is not a destination this repo has,
and a script that could push there is one an accident can run. It was for a while
attached to nothing either, which made a clone of the monorepo the only way to
install a finished extension; the maintainer reversed that in issue #3060, and
the package command now provides the installable archive directly.

It is built by `src/packaging/vsix.ts` rather than by `@vscode/vsce`: the archive
is a well-specified OPC zip, and the alternative was 290 packages and 130 MB in
every CI install of this workspace. The build is deterministic — a fixed
timestamp and a declared file list — so two builds of one tree produce identical
bytes.

## Tests

```sh
pnpm -C apps/vscode-extension-redskilled test
```

The suite runs against a **fake daemon**: a real unix socket in a temporary
directory, answering the frozen contract through the same `serveWireSocket` the
real daemon uses, with an event lane written by the daemon's own
`createRedskilledEventLane`. That is what makes the canned TOONL real TOONL — the
wire has been TOON since #2947/#2948, and a suite that spoke JSON to a JSON stub
would prove nothing about the encoding that ships.

Nothing under `src/model`, `src/watch` or `src/redskilled` imports `vscode`, which
is what lets the whole of the layout, the transition detection and the log
following be driven by tests that never open a window. `src/views/` and
`src/extension.ts` hold the editor-facing wiring and no logic of their own.

## Structure

```
src/
├── extension.ts          the only file that knows it is inside an editor
├── config.ts             the settings block, read into plain values
├── model/
│   ├── snapshot.ts       one read of everything, as a total answer
│   ├── dashboard-view.ts what the status bar says and the panel shows
│   ├── nodes.ts          what the three trees show, as plain values
│   ├── log-follow.ts     which lines of a re-read tail are new
│   └── format.ts         the handful of numbers a row shows
├── redskilled/
│   ├── paths.ts          where the daemon lives, and how we decided
│   ├── client.ts         the read half of the wire
│   ├── event-lane.ts     the TOONL lane, decoded by the daemon's own parser
│   └── log-tail.ts       a Worker's log, from the path the daemon was handed
├── watch/
│   ├── signals.ts        what changed, as things worth interrupting for
│   └── watcher.ts        the poll loop, with the editor kept outside
├── views/                TreeDataProvider, the log channel, the status bar, the dashboard panel
└── packaging/vsix.ts     the installable archive
```

## Prior art

The extension package shape follows `reddb-io/toon`'s `packages/vscode-toon`. The
daemon-reading core — socket discovery, the tolerant lane reader, the log tail,
and the transition-detection model behind the notifications — follows
`reddb-io/herdr-plugin-red-skills`, which reads the same daemon for a terminal
pane. Where that plugin mirrors the daemon's modules because it is installed
outside this workspace, this extension **imports** them, so it cannot drift into a
private idea of what a socket path or a lane row is.

<!-- TODO(#2997): when apps/herdr-plugin-redskilled/ lands, lift the read client and the
     lane reader into one shared module instead of a second local copy. -->
