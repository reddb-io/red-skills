# Host Notes

Reference material for the host branches in `SKILL.md`. Read only the section for
the branch you are wiring; these notes preserve the recipes, line-shape rules,
and rationale outside the hot path.

## Two-Client Architecture

The statusline data surface has two distinct client paths with different render-path constraints:

**1. Command-backed host (`statusLine` in `.claude/settings.json`)** — a DIRECT collector client. The `dev bundle statusline --no-workers` subcommand calls `collectStatuslineAfk`, `collectStatuslineRepo`, `collectStatuslineFleet` and `collectStatuslineDocs` directly, in-process, and emits the repo header line. **It does not render Worker rows**: those come from `redskilled statusline`, already rendered, and the host echoes them (ADR 0130 rule 10, #2928). This path must NEVER be rewired through the MCP server — an MCP handshake per render tick is a synchronous network call in the render path, which is the exact regression ADR 0084 forbids (it blanks the statusline on slow/failed transport and burns unnecessary overhead on every 60s tick). The daemon read is a local unix socket, not a transport handshake, and its failure renders a stated absence rather than a blank line.

**2. MCP `statusline_aggregate` tool** — an agent/UI surface. The `dev:afk` MCP server exposes a `statusline_aggregate` tool that calls the SAME collector cores with the SAME 180s cache discipline. Agents and UIs call this tool instead of shelling out to the command. The tool returns structured data (not a rendered line) so callers can choose their own presentation.

The two paths share collector cores and never duplicate them. Adding a new field to the statusline means adding it to the collector → both clients get it in the same change.

**Diagnosing a blank statusline**: the MCP is NOT in the `statusLine` render path. A blank line is always a problem with the command-backed path (node not on PATH, bundle not cached, opt-out in config). Run step 5 of the Claude Code recipe below to probe the command directly; do not look at MCP transport or the `statusline_aggregate` tool.

## Shared Architecture And Line Shapes

Install or inspect the RedSkills statusline for this repository. The shared producer renders the project name, branch, model/context data when the host provides it, repo counters, and live AFK state. **The two hosts get two shapes (per-runner split, ADR 0003):**

- **Claude Code — multi-line.** Claude Code's `statusLine` renders multiple rows, so the themed producer emits a repo-global **header line** — always shown, even with no live workers: project (branch) + version, model·effort + context, open PRs + open issues, local diff vs `origin/main`, and (Pro/Max only, when the payload exposes them) the 5-hour and weekly usage windows `5h=…% 7d=…%`. **The Worker rows below it come from the daemon, not from this producer** (ADR 0130 rule 10, #2928) — see [Worker Statusline Modes And Config](#worker-statusline-modes-and-config) for what `redskilled statusline` prints. The `k=v` worker form below is the shape the `/afk monitor` dashboard and the historical Claude Code rows share, kept here as the vocabulary an agent decodes:

  ```
  w82UX  run=claude opus high  iss=1173  tests  00:04:41  loc=+10 -11  tks=34k  tls=11 rsn=13 txt=0
  ```

  Every `k=v` key on this line is **exactly 3 letters** (house rule). The `wID` is **bold + red**; then `run=<runner> <model> <effort>` (model shortened, e.g. `claude-opus-4-8` → `opus`; the effort word is omitted when unavailable), `iss=<issue-number>` (the bare ISSUE NUMBER from the worker's `current.number`, populated for BOTH `/afk` and `/go` lanes — not a `done/total` counter), the bare `<phase>` word (no `phase:` prefix, no standalone `#<n>` token), the required `HH:MM:SS` elapsed, `loc=+A -R`, `tks=<humanized>` (SI k/M/B token total), and the vitals as INDIVIDUAL 3-letter `k=v` pairs `tls=<t> rsn=<r> txt=<x>` (never a nested `stats=…:…` blob). The `/afk monitor` dashboard uses the same vitals vocabulary (`tls`/`rsn`/`txt`) while keeping its fuller row shape. The truncated issue TITLE, the live `activity`, the `[live]`/`[quiet]` badge, `wait`, and `log` are **dropped** here — that verbosity stays on the fuller `/afk monitor` line. The two surfaces share only the per-worker FIELD DATA (`workerFields`), never a renderer, so the terse statusline form never bleeds into the monitor. Zero live workers → only the header line.

  The **`/afk monitor` dashboard keeps its fuller per-worker row** (title, `[live]`/`[quiet]`, `wait`, `log`) — it is a full dashboard, not a compact statusline — but its vitals tokens are the same `tls`/`rsn`/`txt` vocabulary as the statusline.

  The same per-worker fields arrive as structured data from the castle `statusline_aggregate` and `worker_vitals` tools, so an agent decodes the tokens by reading the fields instead of the legend.
  For an on-demand human decode table — the no-MCP fallback — run `red-skills-dev statusline --legend` or `red-skills-dev monitor --legend`. The legend prints `token / name / gloss` rows and exits without rendering the live statusline or monitor surface.
- **Codex — single line.** The `tui.status_line` footer is single-line only, so the plain producer stays ONE aggregate line (project · model · context · usage · repo counts · the AFK block). The multi-line layout is Claude-Code-only.

The AFK rows are quiet when no worker is active. Hosts that cannot run a command-backed statusline still get a useful native footer plus `/afk monitor` for live AFK visibility.

**Host capabilities differ; the product architecture should not.** Treat the RedSkills statusline as:

1. A shared producer: the dev bundle's `statusline` subcommand.
2. Host adapters: Claude Code's command-backed `statusLine`; Codex's global `tui.status_line` list and plugin `SessionStart` hook.
3. Fallback visibility: `/afk monitor`, which works when a host has no command-backed footer.

This mirrors how Codex itself organizes customization: skills define reusable workflows, plugins distribute skills plus hooks/MCP/apps, `config.toml` stores host settings, and hooks attach lifecycle behavior next to the active plugin/config layer. Keep RedSkills logic in the bundle and keep host-specific wiring in the host sections below.

## Claude Code Adapter Recipe

1. Inspect the repo: `.red/config.yaml`, `.claude/settings.json`, and whether `jq` is available.

2. **Early exit — opt-out:** if `.red/config.yaml` has top-level `statusline: false` or nested `afk.statusline: false`, stop and tell the user it is disabled. Do not proceed.

3. **Early exit — already configured:** if `.claude/settings.json` already has `statusLine`, do not overwrite it unless the user explicitly asked to replace it (then replace only `statusLine`, preserving all other keys).

4. Write the RedSkills statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'N=$(command -v node 2>/dev/null || ls -1 /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node \"$HOME\"/.volta/bin/node \"$HOME\"/.asdf/shims/node \"$HOME\"/.nodenv/shims/node \"$HOME\"/.nvm/versions/node/*/bin/node \"$HOME\"/.local/share/fnm/node-versions/*/installation/bin/node \"$HOME\"/.fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -1); [ -z \"$N\" ] && exit 0; b=$(ls -1 \"$HOME\"/.cache/red-skills/bundles/dev-*.bundle.min.mjs 2>/dev/null | sort -V | tail -1); [ -z \"$b\" ] && b=$(ls -1 \"$HOME\"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | sort -V | tail -1); [ -n \"$b\" ] && \"$N\" \"$b\" statusline --no-workers; r=$(ls -1 \"$HOME\"/.cache/red-skills/bundles/redskilled*.bundle.min.mjs 2>/dev/null | sort -V | tail -1); [ -n \"$r\" ] && \"$N\" \"$r\" statusline 2>/dev/null'",
    "refreshInterval": 60
  }
}
```

**Why two producers and not one:** each prints the rows it owns and the host prints what it is handed. The dev bundle owns the **repo header** — project, branch, model/context, PR and issue counts, local diff — and is asked for it with `--no-workers`. The daemon owns the **Worker rows** (ADR 0130 rule 10) and serves them already rendered, so `redskilled statusline` is echoed verbatim. The host formats nothing, orders nothing, and truncates nothing. Before #2928 the dev bundle rendered the Worker rows too — the second renderer rule 10 exists to prevent, and the one actually on screen — while the daemon's own line went unread.

**Why this shape (cached-bundle-first, not `$CLAUDE_PLUGIN_ROOT`, not `afk.mjs` directly):** the command above is cached-bundle-first by design (ADR 0084) — never alter it to fetch synchronously in the render path.

Use a 60s refresh interval because the producer reads cached state: 5s ticks burn CPU and repeat calls without new information at that cadence, while 60s matches the real rate of change of fleet/PR state.

Use `jq` to merge when `.claude/settings.json` already exists; create `.claude/`
and a fresh file when it is missing. Keep unrelated settings intact.

5. Verify: confirm `.claude/settings.json` is valid JSON and has `.statusLine.command`. Unlike the old `$CLAUDE_PLUGIN_ROOT` form, you **can** prove this one renders by piping a minimal session JSON into the **same `sh -c '…'` command from step 4** (no need to re-type it):

```bash
printf '{"workspace":{"project_dir":"%s"},"model":{"display_name":"Opus"}}' "$PWD" \
  | <the step-4 statusLine command>
```

It should print the themed **header line** (e.g. `» red-skills (main) v… Opus·high …`) and, below it, whatever `redskilled statusline` returned — the local project's Workers, or a stated absence when no daemon answered. Probe the two halves separately when one is missing: the header is `<bundle> statusline --no-workers`, the Worker rows are `redskilled statusline`. Under `NO_COLOR` the header collapses to the single-line plain form `red-skills (main) · Opus·high · …`.

## Claude Code Rationale

**Why this shape, not `$CLAUDE_PLUGIN_ROOT`.** Claude Code does **not** export
`CLAUDE_PLUGIN_ROOT` (nor `CLAUDE_PROJECT_DIR`) to a `statusLine` command — those
are only set for plugin hooks and MCP/LSP subprocesses. A statusLine that
references `$CLAUDE_PLUGIN_ROOT` expands it to an empty string and fails with
`Cannot find module` — the statusline then silently renders blank.

**Why resolve `node` explicitly, not bare `exec node`.** Claude Code runs the
`statusLine` command in a **non-interactive shell** that does not source the
user's `~/.bashrc`/`~/.zshrc`, so a Node installed through a **version manager**
(nvm, fnm, volta, asdf, nodenv, …) is not on `PATH` — a bare `exec node …` then
fails with `node: not found` (exit 127) and the statusline silently renders
blank. The command resolves the interpreter itself, manager-agnostic:
**`command -v node` first** — which already covers every host with Node on `PATH`
(system package, Homebrew, or no version manager at all) — and only when that
misses does it scan the common install roots (nvm, fnm, volta, asdf, nodenv,
Homebrew, `/usr/local`, `/usr`), newest wins. So the line renders regardless of
how Node was installed or how the host shell was launched.

**Why the cached bundle, not `afk.mjs` directly.** Since ADR 0038, the installed
`afk.mjs` is a tiny **launcher that fetches** the real runtime bundle from the
GitHub release on first use (caching it at
`~/.cache/red-skills/bundles/dev-<version>.bundle.min.mjs`). Pointing the
statusLine straight at the launcher means **every plugin update** lands a new
version whose bundle is not cached yet, so the launcher tries a **synchronous
network download inside the statusline render** — which blows the render's tight
timeout (blank statusline), or fails outright if that version's release asset is
not published yet. The command instead runs the **highest-version
already-fetched bundle** (`ls -1 …/.cache/red-skills/bundles/dev-*.bundle.min.mjs | sort -V | tail -1`
— `sort -V` picks the highest semver, NOT `ls -t` which picks newest-by-mtime and
can resolve an OLD version when an older dir was touched/re-extracted more recently) —
no network in the hot path, so an update never blanks the line; it keeps showing
the last good bundle until a normal `afk` run (or a SessionStart pre-fetch)
caches the new one. It falls back to the launcher only when the cache is empty
(first-ever install), to bootstrap. The project root is **not** passed as an
argument: the AFK `statusline` subcommand reads it from `workspace.project_dir`
in the JSON Claude Code pipes on stdin, which the `sh -c` wrapper forwards
intact.

This respects ADR 0084: the documented command stays cached-bundle-first and
never fetches synchronously in a render path.

## Codex Adapter Recipe

Codex configures its footer through the `tui.status_line` key in `config.toml`
— an ordered list of **built-in** item identifiers (`project`, `git-branch`,
`model-with-reasoning`, `context-remaining`, `task-progress`, `current-dir`,
…). When unset, Codex currently uses `["model-with-reasoning",
"context-remaining", "current-dir"]`; set it to `[]` to hide the footer.
This skill offers the **global** `~/.codex/config.toml` path because the footer
is a personal host preference, not repo state. There is no command hook, so the
shared RedSkills `statusline` producer cannot be injected into the footer yet.

Codex has a native `/statusline` command for picking and reordering these
footer items and persisting them to `config.toml`. The dev bundle also exposes
an explicit inspector/fixer:

```bash
npx -y -p @reddb-io/red-skills@<version> red-skills-dev codex-statusline
npx -y -p @reddb-io/red-skills@<version> red-skills-dev codex-statusline --fix
```

The inspector reports the active `tui.status_line`, flags a missing
`task-progress` widget, prints the recommended order, and reminds the operator
that rich AFK worker state still lives in `/afk monitor`. `--fix` is explicit:
it appends `task-progress` to an existing visible footer or installs the
recommended footer when `status_line` is absent. If the user already has a
custom `tui.status_line`, preserve it unless they explicitly ask for `--fix`;
that custom value is the operator's host preference, not repo state.

Offer to set a useful footer (note: this is **global** Codex config, not
per-repo like the Claude path):

```toml
[tui]
status_line = ["project", "git-branch", "model-with-reasoning", "context-remaining", "task-progress"]
```

**Surviving Codex config resets.** A global `tui.status_line` gets dropped when Codex rewrites `~/.codex/config.toml`, but the dev plugin's Codex `SessionStart` hook re-asserts it so a reset self-heals on the next session start — why and how (the additive, atomic, absent-only re-write) is described below.

This is intentionally host-global and plugin-gated. Codex stores footer
preferences in `~/.codex/config.toml`, while RedSkills gates global hook side
effects on the repo's `.red/config.yaml` `plugins.dev.enabled: true` flag. That
keeps the installed plugin available everywhere but inert outside opted-in
repos, matching the rest of the RedSkills hook model.

For live AFK visibility under Codex, `/afk monitor` remains the canonical
dashboard. Normal `/afk run` launches and `/afk fleet` launches also try to
attach one read-only Codex monitor agent when the host exposes a sub-agent
primitive; the prompt comes from `afk codex-monitor-agent --mode run|fleet`.
When the primitive is unavailable, Codex falls back to the monitor dashboard.
When Codex ships a command-backed statusline (openai/codex#17827 / #20244), this
skill can add a `{ type = "command", command = … }` entry pointing at the same
AFK bundle so the line matches Claude Code's.

## Codex Rationale

That global `tui.status_line` gets dropped whenever Codex rewrites
`~/.codex/config.toml` (e.g. re-syncing plugin `[hooks.state]` on update),
blanking the footer "every update". The dev plugin's Codex `SessionStart` hook
re-asserts it: `hooks/ensure-codex-statusline.mjs` inserts `status_line` **only
when absent** (never clobbers an operator's own value) via an **atomic** write
(temp + rename — a race with Codex's writer can lose the update but never corrupt
the file). So a reset self-heals on the next session start. The hook is additive
and idempotent; disable it by removing the second `SessionStart` entry in
`hooks/codex.hooks.json`.

## OpenCode Adapter

Nothing to install: OpenCode is an AFK API-auth runner lane (`--runner opencode`), not an interactive host UI, so it has no footer/statusline adapter — observe it through `/afk monitor`, `/afk dashboard`, and Actions output like any other runner.

## Worker Statusline Modes And Config

**The Worker line comes from the daemon finished; no host renders it.** `redskilled` serves two ops over one socket — `statusline-payload` for a surface that needs structure, `statusline-string` for one that needs a line — and the string is a **pure function of the payload**, proven by test rather than by discipline. ADR 0130 rule 10 moved rendering here precisely so Claude Code, Codex and OpenCode print identical lines without any of them reimplementing anything.

| Invocation | What it lists |
| --- | --- |
| `redskilled statusline` | the local project's Workers only — the quiet default |
| `redskilled statusline global` | every project's Workers, each entry naming its owning project |
| `redskilled statusline --max-width 60` | the same, under a narrower line |
| `redskilled statusline --verbose` | each listed Worker plus a second line: the last line it logged |
| `redskilled statusline global --verbose` | the same, machine-wide, each second line naming its Worker's owner |

**The second line comes from the Worker, never from its log file.** With `--verbose` each listed Worker gets one extra line carrying the last line it logged. The Worker **publishes** that line on its heartbeat and the daemon stores it as an opaque string — so a verbose global view is still one read and opens no other project's files. A statusline that read each Worker's log directly would cost a disk read per Worker per render and cross a project boundary on every tick. A Worker that has logged nothing renders no second line, and the annotation disappears entirely once the line degrades past the Worker entries — a second line belongs to a Worker entry, and an aggregate row has no Worker to be the second line of.

**A crowded machine degrades rather than overflowing.** Too many Workers for the count budget or the width drops the line to one entry per project; too many projects drops it to the host total (`host 6w/6p 1.5G`). The statusline answers "who is using this machine and how much" — the full picture stays with `/afk dashboard` and `/afk monitor`.

### The config block

Declare the defaults once under `plugins.dev.statusline.*` (the folded `dev.statusline.*` spelling is read too). Precedence is one sentence: **flag beats config beats built-in.**

```yaml
plugins:
  dev:
    statusline:
      mode: local          # `local` (default) or `global`
      max_workers: 4       # Worker entries before the line drops to projects
      max_projects: 4      # project entries before the line drops to the host total
      max_width: 120       # hard ceiling in characters; the line never exceeds it
      verbose: false       # `true` gives each Worker a second line: its last logged line
```

Config is read **client-side** and only decided values cross the socket — the daemon must never learn what a `.red/config.yaml` is (ADR 0130 rule 3). A malformed value is named on stderr and ignored: this line renders on every turn, and a blank statusline is the harder failure to diagnose than a wrong `max_width`.
