---
name: git-guardrails-claude-code
working-mode: interactive
description: Set up Claude Code hooks to block dangerous git commands (push, reset --hard, clean, branch -D, etc.) before they execute. Use when user wants to prevent destructive git operations, add git safety hooks, or block git push/reset in Claude Code.
disable-model-invocation: true
---

# Setup Git Guardrails

**Block destructive git ops before they run.**

Sets up a PreToolUse hook that intercepts and blocks dangerous git commands before Claude executes them.

<what-to-do>

## 1. Ask scope

Ask the user: install for **this project only** (`.claude/settings.json`) or **all projects** (`~/.claude/settings.json`)?

## 2. Copy the hook script

The bundled script is at: [scripts/block-dangerous-git.sh](scripts/block-dangerous-git.sh)

Copy it to the target location based on scope, then make it executable with `chmod +x`:

- **Project**: `.claude/hooks/block-dangerous-git.sh`
- **Global**: `~/.claude/hooks/block-dangerous-git.sh`

## 3. Add hook to settings

Add the `PreToolUse` hook to the appropriate settings file. The block is identical for both scopes — only the `command` path differs: **project** uses `"$CLAUDE_PROJECT_DIR"/.claude/hooks/block-dangerous-git.sh`, **global** uses `~/.claude/hooks/block-dangerous-git.sh`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/block-dangerous-git.sh"
          }
        ]
      }
    ]
  }
}
```

If the settings file already exists, merge the hook into the existing `hooks.PreToolUse` array — don't overwrite other settings.

## 4. Ask about customization

Ask if the user wants to add or remove any patterns from the blocked list. Edit the copied script accordingly.

## 5. Verify

Run a quick test:

```bash
echo '{"tool_input":{"command":"git push origin main"}}' | <path-to-script>
```

Should exit with code 2 and print a BLOCKED message to stderr.

</what-to-do>

<supporting-info>

## What gets blocked

- `git push` (all variants including `--force`)
- `git reset --hard`
- `git clean -f` / `git clean -fd`
- `git branch -D`
- `git checkout .` / `git restore .`

When blocked, Claude sees a message telling it that it does not have authority to access these commands.

## Primary branch guard

Once the dev plugin is enabled (`plugins.dev.enabled: true`), this hook blocks the
agent from switching the primary checkout's branch (`git switch <branch>`,
`git checkout <branch>`, `git switch -b <new>`) **unconditionally** — with no
branch-lock file and no config toggle (ADR 0083 §2, untouchable primary). `git
commit`, `git worktree add`, read-only git, and registered `.red/tmp/worktrees/<lane>/<slug>` worktrees stay
allowed; the human terminal is not intercepted. The historical
`dev.lock.primary-branch` key is retained as read-only legacy history only — it no
longer enables or disables the guard.

## Branch-lock awareness

When an opt-in branch lock is active, this hook also blocks the branch-leaving /
work-loss family in the primary checkout. That behaviour is documented in full at
[`branch-lock`](../branch-lock/SKILL.md); this hook is self-contained and reaches
the same verdict without sourcing it.

## Tests

The full behaviour (dangerous patterns + branch-lock awareness + worktree
scope + the no-dependency contract) is pinned by
[scripts/tests/block-dangerous-git.test.sh](scripts/tests/block-dangerous-git.test.sh),
run directly with `bash`.

</supporting-info>
