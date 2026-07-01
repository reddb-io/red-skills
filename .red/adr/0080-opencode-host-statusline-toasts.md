# OpenCode statusline + toasts — capitalize on the AFK statusline via session events + experimental.session.compacting

## Status

accepted. Refines the Slice 1 + 2 + 3 contract (ADR 0075, 0076, 0077,
0079) with the **statusline + toasts** surface (Slice 4). The
generator contract is unchanged; this ADR adds a new
`statusline.ts` module + a third event class in the Slice 2 hook
emission (`session-status.ts`).

## Context

The `/afk` skill ships a native statusline today (ADR 0034 /
`apps/dev/src/commands/statusline.ts`): a single short line that
aggregates the live worker state, the issue queue, the branch,
and the model. Claude Code invokes it through a `UserPromptSubmit`
hook (per-turn, footer render); Codex routes it through
`tui.status_line` (the per-message footer surface). A user
running `opencode .` after Slice 1 + 2 + 3 has the **same skills,
hooks, and MCPs** as Claude Code and Codex, but **no live
statusline** — the opencode TUI footer is hard-coded to built-in
widgets (model name + context window) with no plugin extension
point.

The Slice 4 generator capitalises on what opencode **does**
expose:

- **Plugin events** (`session.idle`, `session.error`,
  `tui.toast.show`, `tui.prompt.append`,
  `experimental.session.compacting`, `shell.env`) — verified
  against the opencode Plugins doc, June 2026. These are the
  only surface that lets a plugin inject text into the TUI
  without the user typing.
- **`tui.json` `attention` config** — built-in sound + desktop
  notification for `session.idle`, `session.error`, `permission`,
  `question`, `subagent_done`. The user can override the
  `sound_pack` and per-event sound files; opencode ships
  `opencode.default`.
- The `/afk` statusline source — a pure renderer in
  `apps/dev/src/core/statusline.ts` (the assembly) +
  `apps/dev/src/core/statusline-style.ts` (the themed output) +
  `apps/dev/src/commands/statusline.ts` (the IO half). The
  statusline reads `.red/tmp/workers/*/*/afk.state.json` and
  produces a single ANSI-coloured line.

Three concrete opencode surfaces capitalise on this:

1. **Toast on session idle** — when the LLM finishes a turn,
   opencode fires `session.idle`. The Slice 4 plugin module
   reads the AFK worker state (one `readFileSync` on the
   `afk.state.json` glob) and emits a `tui.toast.show` with
   a short summary: `AFK: 2 workers · 1 issue ready · branch=main`.
   The user sees the live state without typing a command.
2. **Inject worker state into the compaction prompt** — when the
   user runs `/compact`, opencode fires
   `experimental.session.compacting`. The Slice 4 plugin reads
   the worker state and appends a short context block to
   `output.context`, so the compaction summary knows about
   the live workers. The continuation prompt the LLM sees
   after compaction is informed.
3. **Enable `attention` by default** — the Slice 4 generator
   writes a `tui.json` with `attention.enabled: true` (and
   the relevant `sound_pack` / `sounds` paths) into the
   target install. Built-in `session.idle` and `session.error`
   events play the opencode default sounds out of the box.

The Slice 4 contract is intentionally small: one new event
class (`session-status.ts`) plus a `tui.json` write. The
existing AFK statusline subcommand (`node bin/afk.mjs
statusline <root>`) is the data source — the plugin module
spawns it via `Bun.$\`...\`` and parses the one-line output
into a structured summary.

## Decision

### 1. New event class: `session-status.ts`

The generator emits
`dist/opencode/<plugin>/.opencode/plugin/session-status.ts`,
a TS module that subscribes to four opencode events:

- **`session.idle`** — fires when the LLM finishes a turn. The
  module calls `bin/afk.mjs statusline <directory>` (the
  same Claude/Codex statusline source) and emits a
  `tui.toast.show` with the parsed one-line summary.
- **`session.error`** — fires when a turn errors. The module
  emits a `tui.toast.show` with the error message; the
  `tui.json` `attention` config plays the built-in `error`
  sound.
- **`experimental.session.compacting`** — fires before
  `/compact` summarises the session. The module reads the
  worker state and appends a one-line block to
  `output.context` so the summary knows about live workers.
- **`session.created`** — fires when a new session starts.
  The module emits a `tui.prompt.append` with a one-liner
  the user can accept or reject: `> /afk monitor — see live
  worker state` (the existing AFK monitor subcommand).

The module is **fail-closed best-effort**: the statusline
subcommand is `Bun.$\`-spawned and the output is parsed with
a regex. A non-zero exit, a missing `bin/afk.mjs`, or a parse
failure emits nothing — the TUI session continues normally.
The user sees a degraded experience (no statusline toast)
rather than a hard error.

### 2. New `tui.json` write: `attention` enabled by default

The Slice 4 generator writes a `tui.json` (or merges into
the existing one in `--global` mode) with:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4
  }
}
```

The `sound_pack` is left at `opencode.default` (the user's
`~/.local/share/opencode/sound/` ships the opencode sounds;
the user can override later). A custom sound pack is a
follow-up slice when we have audio assets to ship.

### 3. The AFK statusline subcommand is the data source

The plugin module does **not** re-implement the statusline
renderer. The source `apps/dev/src/commands/statusline.ts`
already produces a one-line ANSI-coloured output for the
Claude/Codex footer; the plugin module spawns it and parses
the one line. The renderer (the themed output, the
`·`-joins, the token humanizing) is exercised by
`apps/dev/tests/statusline.test.ts` and stays in `apps/dev/`.

This is the same single-source-of-truth property the rest
of the opencode-host adapter enforces: the AFK statusline
is the canonical renderer, the plugin module is a thin
adapter that calls it. Editing the statusline in `apps/dev/`
is visible to the opencode TUI on the next session, with no
rebuild.

### 4. `bin/afk.mjs` is the resolved launcher (per Slice 5's release-asset model)

The plugin module's `Bun.$\`node <abs>/bin/afk.mjs
statusline <directory>\`` resolves the launcher against the
plugin root the same way Slice 3's `mcp-passthrough.ts`
resolves `bootstrap.mjs`. The Slice 5 (remote install via
release asset) plan accommodates this: the release pipeline
bundles `bin/afk.mjs` into the release tarball, the dist
generator bakes the absolute path into the emitted TS, and
the user's install resolves correctly. The Slice 4 plan
deliberately does not change Slice 3's path-resolution
algorithm; it reuses it.

### 5. The statusline payload is parsed, not echoed

The `bin/afk.mjs statusline <root>` output is a single ANSI-
coloured line. The plugin module strips the ANSI codes, trims
whitespace, and emits the cleaned line as the toast body.
For example:

```
[afk] 2 workers · 1 issue ready · branch=main · model=openai/gpt-4o
```

is the toast body. The user sees the same line they'd see
in the Claude Code footer, in the opencode toast.

### 6. Compaction injection is conservative

The `experimental.session.compacting` hook appends to
`output.context` (an array of strings). The Slice 4 module
appends a single block:

```text
## AFK live state
2 workers active (1 DONE, 1 blocked:quota).
3 issues in `ready-for-agent`.
Branch: main · model: openai/gpt-4o.

If the user resumes this session, /afk monitor is the source
of truth for current worker state — re-run it before acting
on any compaction summary.
```

The block is hard-coded; future slices can add a `--json`
flag for structured injection. The current slice is
deliberately conservative: a 5-line block that the LLM can
parse in one glance.

## Considered options

- **Re-implement the statusline renderer in the plugin module**
  — rejected: the source `apps/dev/src/core/statusline.ts` is
  exercised by `tests/statusline.test.ts`; re-implementing
  forks the canonical renderer and the two paths drift the
  first time the design changes. The thin-spawn approach is
  the Slice 2 / Slice 3 pattern (single source, three
  consumers); Slice 4 extends it to the runtime output
  surface.
- **Use the opencode `tui.status_line` field** — rejected:
  the field is not exposed in `tui.json` for opencode v1.16.2
  (verified against the opencode TUI doc, June 2026; the
  field is only in legacy v0.x). The plugin-event path is
  what v1.16.2 supports. A future slice may add a legacy
  `tui.status_line` write gated on opencode version, but
  the toast-on-session-idle path works on every supported
  version.
- **Fire a toast on every tool call** — rejected: noisy. The
  `session.idle` event is the natural granularity (one
  toast per LLM turn) and matches what the user expects.
  Firing on every tool call would bury the user in toasts.
- **Pre-cache the statusline result** — rejected: the worker
  state changes between turns (workers exit, new workers
  start, issues get claimed). The spawn cost (one
  `Bun.$\`node afk.mjs statusline\`` call per turn, ~10ms)
  is negligible.

## Consequences

- A user running `opencode .` after Slice 1 + 2 + 3 + 4 sees
  a toast after every LLM turn summarising the live AFK
  state. The toast body is the same line the Claude Code
  footer shows.
- The `experimental.session.compacting` injection gives the
  LLM context about live workers when the user runs
  `/compact`. The continuation prompt the LLM sees after
  compaction is informed; the user does not have to
  re-explain the worker state.
- The `tui.json` `attention` write enables built-in sound +
  desktop notification for `session.idle` and
  `session.error` (and `permission`, `question`,
  `subagent_done`). The user does not have to edit
  `tui.json` to get the notifications.
- A new build-time error class: a missing `bin/afk.mjs`.
  The Slice 4 generator emits a warning and skips the
  `session-status.ts` module. The user sees the warning at
  `generate` time; the rest of the install (Slice 1 + 2 + 3)
  is unaffected.
- The Slice 4 module is **plugin-only**; the per-plugin
  dist tree is the only place the file lives. There is no
  `opencode.json` field for it. The Slice 5 (remote install)
  release pipeline will package the module alongside the
  Slice 1 + 2 + 3 outputs.
- A `bin/afk.mjs` that's not the local checkout version (a
  release-asset install) is supported: the Slice 4 module
  resolves the same way Slice 3 resolves `bootstrap.mjs`,
  and the AFK statusline subcommand is stable across
  versions.

## Status

Accepted. Implements the Slice 4 statusline + toasts surface of
the opencode-host plan. The Slice 1 + 2 + 3 + 3.1 contracts (ADR
0075, 0076, 0077, 0078, 0079) are unchanged; this ADR adds the
`session-status.ts` event class and the `tui.json` write.

## Related

- **0075** — Slice 1 (provider block).
- **0076** — Slice 2 (skills).
- **0077** — Slice 2 (hooks).
- **0078** — Slice 2.1 (install path); the install script
  writes the new `tui.json` in the same `--local` / `--global`
  flow.
- **0079** — Slice 3 (MCP passthrough); the
  `bin/afk.mjs`-resolution algorithm is reused for the
  Slice 4 statusline spawn.
- **0034** — `apps/<plugin>/` layout; the Slice 4 plugin
  module reads from the same `plugins/dev/skills/.../afk/`
  source.
