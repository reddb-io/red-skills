---
name: statusline
description: Install or inspect the RedSkills Claude Code statusline for the current repo. Wires `.claude/settings.json` to the shipped AFK statusline command, preserving existing statusLine config unless replacement is explicitly requested.
---

# Statusline

Install the RedSkills statusline for this repository.

The statusline is a Claude Code feature. It renders the project name, branch,
model/context data when Claude provides it, and the live AFK issue block:
workers, ready queue count, ready-for-human count, diffstat, and current issue
numbers. The script is quiet when no AFK worker is active.

## Process

1. Inspect the current repository:
   - `.red/config.yaml`
   - `.claude/settings.json`
   - whether `jq` is available

2. Respect opt-outs:
   - If `.red/config.yaml` contains top-level `statusline: false`, stop and tell the user it is disabled.
   - If `.red/config.yaml` contains nested `afk.statusline: false`, stop and tell the user it is disabled.

3. Preserve existing config:
   - If `.claude/settings.json` already has `statusLine`, do not overwrite it.
   - If the user explicitly asked to replace or force it, replace only `statusLine` and preserve all other keys.

4. Write the RedSkills statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ${CLAUDE_PLUGIN_ROOT}/skills/engineering/afk/scripts/statusline.sh \"$CLAUDE_PROJECT_DIR\"",
    "refreshInterval": 5
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code to the installed plugin
path, so the statusline always runs the newest installed version — never pin a
`…/cache/<version>/…` path. The trailing `"$CLAUDE_PROJECT_DIR"` is the
project root Claude Code was started in, passed as the script's first argument
so it reads that checkout's `.red/tmp/workers/` regardless of where the command
itself runs; when the variable is unset the script falls back to the stdin
payload's cwd.

Use `jq` to merge when `.claude/settings.json` already exists. If the file is
missing, create `.claude/` and write a new settings file. Keep unrelated
settings intact.

5. Verify:
   - Confirm `.claude/settings.json` is valid JSON.
   - Confirm `.claude/settings.json` now has `.statusLine.command`.
   - Do not run the statusline script as a final proof unless the repo already has the plugin mounted; the `${CLAUDE_PLUGIN_ROOT}` variable is resolved by Claude Code at render time.

## Notes

- This command can be invoked from Claude Code as `/statusline` or from Codex as `$statusline`.
- Even when invoked from Codex, write the literal `${CLAUDE_PLUGIN_ROOT}` command. Claude Code resolves it later when it renders the statusline.
- For full first-time RedSkills setup, `/setup-red-skills` also offers to wire this statusline as part of the project bootstrap.
