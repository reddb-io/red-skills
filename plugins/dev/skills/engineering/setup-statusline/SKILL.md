---
name: setup-statusline
description: Install or inspect the RedSkills statusline for the active host. RedSkills has one shared `statusline` producer in the dev bundle; Claude Code wires it through `.claude/settings.json` as a command-backed statusLine, while Codex configures the built-in `tui.status_line` footer and the dev plugin's SessionStart self-heal hook. Preserves existing config unless replacement is explicitly requested.
---

# Statusline

**Wire the RedSkills statusline surface for the host the agent is running under — stop immediately if a gate condition is met.** RedSkills is client/CLI/coder/runner agnostic: the dev bundle owns one `statusline` producer, and each host gets the richest integration it actually supports. Claude Code can render the shared producer directly as a command-backed statusLine. Codex currently exposes only native footer widgets, so the skill configures those widgets and relies on the dev plugin's SessionStart hook to keep the footer present across Codex config rewrites.

Install or inspect the RedSkills statusline for this repository. The shared producer renders the project name, branch, model/context data when the host provides it, repo counters, and the live AFK issue block: workers, ready queue count, ready-for-human count, diffstat, current issue numbers, and runner labels. The line is quiet when no AFK worker is active. Hosts that cannot run a command-backed statusline still get a useful native footer plus `/afk monitor` for live AFK visibility.

**Host capabilities differ; the product architecture should not.** Treat the RedSkills statusline as:

1. A shared producer: the dev bundle's `statusline` subcommand.
2. Host adapters: Claude Code's command-backed `statusLine`; Codex's global `tui.status_line` list and plugin `SessionStart` hook.
3. Fallback visibility: `/afk monitor`, which works when a host has no command-backed footer.

This mirrors how Codex itself organizes customization: skills define reusable workflows, plugins distribute skills plus hooks/MCP/apps, `config.toml` stores host settings, and hooks attach lifecycle behavior next to the active plugin/config layer. Keep RedSkills logic in the bundle and keep host-specific wiring in the host sections below.

## Claude Code

1. Inspect the repo: `.red/config.yaml`, `.claude/settings.json`, and whether `jq` is available.

2. **Early exit — opt-out:** if `.red/config.yaml` has top-level `statusline: false` or nested `afk.statusline: false`, stop and tell the user it is disabled. Do not proceed.

3. **Early exit — already configured:** if `.claude/settings.json` already has `statusLine`, do not overwrite it unless the user explicitly asked to replace it (then replace only `statusLine`, preserving all other keys).

4. Write the RedSkills statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'b=$(ls -1 \"$HOME\"/.cache/red-skills/bundles/dev-*.bundle.min.mjs 2>/dev/null | sort -V | tail -1); [ -z \"$b\" ] && b=$(ls -1 \"$HOME\"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | sort -V | tail -1); [ -n \"$b\" ] && exec node \"$b\" statusline'",
    "refreshInterval": 5
  }
}
```

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
not published yet. The command above instead runs the **highest-version
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

Use `jq` to merge when `.claude/settings.json` already exists; create `.claude/`
and a fresh file when it is missing. Keep unrelated settings intact.

5. Verify: confirm `.claude/settings.json` is valid JSON and has `.statusLine.command`. Unlike the old `$CLAUDE_PLUGIN_ROOT` form, you **can** prove this one renders by piping a minimal session JSON to it:

```bash
printf '{"workspace":{"project_dir":"%s"},"model":{"display_name":"Opus"}}' "$PWD" \
  | sh -c 'b=$(ls -1 "$HOME"/.cache/red-skills/bundles/dev-*.bundle.min.mjs 2>/dev/null | sort -V | tail -1); [ -z "$b" ] && b=$(ls -1 "$HOME"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | sort -V | tail -1); [ -n "$b" ] && exec node "$b" statusline'
```

It should print a line like `red-skills (main) · Opus`.

## Codex

Codex configures its footer through the `tui.status_line` key in `config.toml`
— an ordered list of **built-in** item identifiers (`project`, `git-branch`,
`model-with-reasoning`, `context-remaining`, `task-progress`, `current-dir`,
…). When unset, Codex currently uses `["model-with-reasoning",
"context-remaining", "current-dir"]`; set it to `[]` to hide the footer.
This skill offers the **global** `~/.codex/config.toml` path because the footer
is a personal host preference, not repo state. There is no command hook, so the
shared RedSkills `statusline` producer cannot be injected into the footer yet.

Codex has a native `/statusline` command for picking and reordering these
footer items and persisting them to `config.toml`. If the user already has a
custom `tui.status_line`, preserve it; that custom value is the operator's host
preference, not repo state.

Offer to set a useful footer (note: this is **global** Codex config, not
per-repo like the Claude path):

```toml
[tui]
status_line = ["project", "git-branch", "model-with-reasoning", "context-remaining", "task-progress"]
```

**Surviving Codex config resets.** That global `tui.status_line` gets dropped
whenever Codex rewrites `~/.codex/config.toml` (e.g. re-syncing plugin
`[hooks.state]` on update), blanking the footer "every update". The dev plugin's
Codex `SessionStart` hook re-asserts it: `hooks/ensure-codex-statusline.mjs`
inserts `status_line` **only when absent** (never clobbers an operator's own
value) via an **atomic** write (temp + rename — a race with Codex's writer can
lose the update but never corrupt the file). So a reset self-heals on the next
session start. The hook is additive and idempotent; disable it by removing the
second `SessionStart` entry in `hooks/codex.hooks.json`.

This is intentionally host-global and plugin-gated. Codex stores footer
preferences in `~/.codex/config.toml`, while RedSkills gates global hook side
effects on the repo's `.red/config.yaml` `plugins.dev.enabled: true` flag. That
keeps the installed plugin available everywhere but inert outside opted-in
repos, matching the rest of the RedSkills hook model.

For live AFK visibility under Codex, point the user at `/afk monitor` (fleet
spawns a read-only monitor agent; otherwise it falls back to the monitor
dashboard). When Codex ships a command-backed statusline (openai/codex#17827 /
#20244), this skill can add a `{ type = "command", command = … }` entry pointing
at the same AFK bundle so the line matches Claude Code's.

## Notes

- Invoke as `/setup-statusline` (Claude Code) or `$setup-statusline` (Codex). Wire the host you are running under; do not imply the statusline feature belongs to only one client.
- `/setup-red-skills` may offer the Claude Code command-backed adapter during project bootstrap. Under Codex, use this skill to inspect or configure the native footer path.
