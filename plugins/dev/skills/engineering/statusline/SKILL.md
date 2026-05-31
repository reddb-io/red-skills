---
name: statusline
description: Install or inspect the RedSkills statusline for the current repo. On Claude Code, wires `.claude/settings.json` to a command that runs the AFK bundle's `statusline` subcommand (resolving the installed bundle itself — Claude Code does not expose `$CLAUDE_PLUGIN_ROOT` to a statusLine). On Codex, configures the built-in `tui.status_line` footer. Preserves existing config unless replacement is explicitly requested.
---

# Statusline

Install the RedSkills statusline for this repository.

It renders the project name, branch, and model/context data when the host
provides it, and — on Claude Code — the live AFK issue block: workers, ready
queue count, ready-for-human count, diffstat, and current issue numbers. The
line is quiet when no AFK worker is active.

**Host capabilities differ.** Claude Code supports a *command-backed* statusline
(it runs a command and renders its stdout), so it shows the full AFK block.
Codex, as of this writing, only supports *built-in* footer items via
`tui.status_line` and has **no** command-backed statusline (open feature
requests openai/codex#17827, #20244) — so the AFK worker block cannot render in
Codex's footer; track AFK under Codex with `/afk monitor` instead.

## Claude Code

1. Inspect the repo: `.red/config.yaml`, `.claude/settings.json`, and whether `jq` is available.

2. Respect opt-outs: if `.red/config.yaml` has top-level `statusline: false` or nested `afk.statusline: false`, stop and tell the user it is disabled.

3. Preserve existing config: if `.claude/settings.json` already has `statusLine`, do not overwrite it unless the user explicitly asked to replace it (then replace only `statusLine`, preserving all other keys).

4. Write the RedSkills statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'b=$(ls -t \"$HOME\"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | head -1); [ -n \"$b\" ] && exec node \"$b\" statusline'",
    "refreshInterval": 5
  }
}
```

**Why this shape, not `$CLAUDE_PLUGIN_ROOT`.** Claude Code does **not** export
`CLAUDE_PLUGIN_ROOT` (nor `CLAUDE_PROJECT_DIR`) to a `statusLine` command — those
are only set for plugin hooks and MCP/LSP subprocesses. A statusLine that
references `$CLAUDE_PLUGIN_ROOT` expands it to an empty string and fails with
`Cannot find module` — the statusline then silently renders blank. The command
above instead resolves the newest installed AFK bundle straight from the plugin
cache (`ls -t … | head -1`), so it stays valid across plugin updates without
pinning a `…/cache/<version>/…` path. The project root is **not** passed as an
argument: the AFK `statusline` subcommand reads it from `workspace.project_dir`
in the JSON Claude Code pipes on stdin, which the `sh -c` wrapper forwards
intact.

Use `jq` to merge when `.claude/settings.json` already exists; create `.claude/`
and a fresh file when it is missing. Keep unrelated settings intact.

5. Verify: confirm `.claude/settings.json` is valid JSON and has `.statusLine.command`. Unlike the old `$CLAUDE_PLUGIN_ROOT` form, you **can** prove this one renders by piping a minimal session JSON to it:

```bash
printf '{"workspace":{"project_dir":"%s"},"model":{"display_name":"Opus"}}' "$PWD" \
  | sh -c 'b=$(ls -t "$HOME"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | head -1); [ -n "$b" ] && exec node "$b" statusline'
```

It should print a line like `red-skills (main) · Opus`.

## Codex

Codex configures its footer through the **global** `tui.status_line` key in
`~/.codex/config.toml` — an ordered list of **built-in** item identifiers
(`project`, `git-branch`, `model-with-reasoning`, `context-remaining`,
`task-progress`, `spinner`, `current-dir`, …). Default is `["spinner",
"project"]`; `null` disables the footer. There is no command hook, so the
RedSkills AFK block cannot be injected.

Offer to set a useful footer (note: this is **global** Codex config, not
per-repo like the Claude path):

```toml
[tui]
status_line = ["project", "git-branch", "model-with-reasoning", "context-remaining", "task-progress"]
```

For live AFK visibility under Codex, point the user at `/afk monitor` (fleet
spawns a read-only monitor agent; otherwise it falls back to the monitor
dashboard). When Codex ships a command-backed statusline (openai/codex#17827 /
#20244), this skill can add a `{ type = "command", command = … }` entry pointing
at the same AFK bundle so the line matches Claude Code's.

## Notes

- Invoke as `/statusline` (Claude Code) or `$statusline` (Codex). Wire the host you are running under — the AFK bundle's `statusline` subcommand is the shared producer of the line; only the host integration differs.
- `/setup-red-skills` also offers to wire the Claude Code statusline as part of project bootstrap (Section F).
