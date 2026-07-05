# Host notes — why each host branch is shaped the way it is

Reference material for the three host branches in `SKILL.md`. Read the section for
the branch you are wiring; each is rationale, not an extra step.

## Claude Code — why the statusLine command is shaped this way

**Why this shape, not `$CLAUDE_PLUGIN_ROOT`.** Claude Code does **not** export
`CLAUDE_PLUGIN_ROOT` (nor `CLAUDE_PROJECT_DIR`) to a `statusLine` command — those
are only set for plugin hooks and MCP/LSP subprocesses. A statusLine that
references `$CLAUDE_PLUGIN_ROOT` expands it to an empty string and fails with
`Cannot find module` — the statusline then silently renders blank.

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

## Codex — surviving config resets

That global `tui.status_line` gets dropped whenever Codex rewrites
`~/.codex/config.toml` (e.g. re-syncing plugin `[hooks.state]` on update),
blanking the footer "every update". The dev plugin's Codex `SessionStart` hook
re-asserts it: `hooks/ensure-codex-statusline.mjs` inserts `status_line` **only
when absent** (never clobbers an operator's own value) via an **atomic** write
(temp + rename — a race with Codex's writer can lose the update but never corrupt
the file). So a reset self-heals on the next session start. The hook is additive
and idempotent; disable it by removing the second `SessionStart` entry in
`hooks/codex.hooks.json`.
