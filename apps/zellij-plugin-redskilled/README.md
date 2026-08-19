# zellij-plugin-dashboard

The RedSkills worker dashboard as a Zellij tab: three panes, one screen, no
polling of anything that costs GitHub budget.

```
┌───────────────────────────────┬──────────────────────┐
│ fleet                         │ host                 │
│ per-Worker rows: issue,       │ slots, projects,     │
│ phase, activity, age          │ ready counts, deaths │
│                               ├──────────────────────┤
│                               │ spend                │
│                               │ this host's own API  │
│                               │ attribution, by pool │
└───────────────────────────────┴──────────────────────┘
```

## Run it

```bash
apps/zellij-plugin-redskilled/bin/red-dashboard.sh
```

That is the entry point: it exports `RED_PANE` (the path each pane execs) and
hands the layout to Zellij, so the tab works from any working directory.

To make it a named layout instead:

```bash
mkdir -p ~/.config/zellij/layouts
cp apps/zellij-plugin-redskilled/layouts/red-dashboard.kdl ~/.config/zellij/layouts/
export RED_PANE=$PWD/apps/zellij-plugin-redskilled/bin/red-pane.sh
zellij --layout red-dashboard
```

A pane launched without `RED_PANE` set fails loudly with the path it wanted,
rather than opening blank.

`RED_PANE_INTERVAL` sets the repaint seconds (default `3`). `RED_PANE_VERSION`
pins the package version used when no PATH shim exists.

## Why these three panes

`fleet` and `host` are the two obvious questions — what is each Worker doing,
and are there slots to birth more.

`spend` is the one worth arguing for. A drained REST pool is **invisible** in the
other two: the fleet just goes quiet and the host just shows zero Workers, while
the real cause is a pool this host emptied itself. On 2026-08-15 that exact blind
spot cost an hour — every Worker died at boot on `AFK queue visibility`, and
`gh api rate_limit` read healthy the whole time because the Workers authenticate
as the GitHub App, a **different identity** from the operator's `gh` login. The
pane that would have answered it in one glance is now on screen by default.

## Why no pane calls GitHub

A pane repaints every few seconds, forever. A single gh-backed surface on that
loop drains the token's REST pool on its own — which is precisely the failure
that empties the queue and kills every Worker at boot.

So every surface here is a local read. Each runs through the canonical form,
`npx -y -p @reddb-io/red-skills@<version> <binary> <subcommand>`, with a PATH
shim used only as a warm-cache shortcut:

| pane | binary | subcommand | reads |
| --- | --- | --- | --- |
| `fleet` | `red-skills-dev` | `monitor --plain` | worker state files, local history ledger |
| `host` | `red-skills-redskilled` | `dashboard` | the daemon socket |
| `spend` | `red-skills-redskilled` | `github-spend --pool all` | this host's durable spend attribution |

`github-spend` reports what the host observed **itself** spending. It is never
GitHub's authoritative balance, and it asks GitHub nothing.

## Why a layout and not a WASM plugin

Zellij plugins are WASM modules under a WASI sandbox that does not hand out unix
socket access, and every surface here reads either the daemon socket or files
under `.red/`. A layout runs the same binaries an operator already has, works on
upstream Zellij as well as `reddb-io/zellij`, and needs no build step.

The repaint loop lives here, at the host edge, rather than as a `--watch` flag on
`monitor`: a watch flag would add a sleep loop to `apps/plugin-dev/src`, which is the
exact shape the declared-wait ratchet refuses.
