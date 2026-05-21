---
name: branch-lock
description: Lock the agent to a branch and block it from switching away. Sets up a self-contained PreToolUse(Bash) hook that blocks the agent's git checkout/switch to any other branch while a lock is active, and gives you a /branch-lock command to set, change, and clear the lock. Use when you want the agent pinned to one branch for a session.
---

# Branch Lock

Pins the agent to a single branch in the primary checkout and blocks it from
switching away. The lock is a local fact — `./.red/tmp/branch-lock.yaml` whose
content is the branch name — under the gitignored `.red/tmp/`, so every checkout
and machine locks independently and nothing is committed. Absence of the file
means unlocked: protection is strictly opt-in.

Enforcement is **agent-only**, via a Claude Code `PreToolUse(Bash)` hook — it
intercepts the agent's own tool calls, not the human's terminal. See
[ADR 0006](../../../../../.red/adr/0006-branch-lock-agent-only-enforcement.md).
The hook is self-contained: it depends on neither the `git-guardrails-claude-code`
skill nor anything else, and the two stack harmlessly if both are installed.

`/afk` worktrees under `.red/tmp/work-*/` are always exempt — the lock protects
the interactive primary checkout, never the autonomous loop.

<what-to-do>

## Parse the request

The user invokes `/branch-lock <branch>` or `/branch-lock clear` (or just asks
to lock/unlock). Map it to one CLI action and run the bundled CLI:

- `/branch-lock <branch>` → `scripts/branch-lock.sh set <branch>`
- `/branch-lock` (no arg) → `scripts/branch-lock.sh set` (lock to the current branch)
- `/branch-lock clear` → `scripts/branch-lock.sh clear`
- "what's locked?" → `scripts/branch-lock.sh status`

The CLI does the **atomic relock-then-switch**: it rewrites the lock target
first, so the switch to that branch is itself "return to the lock target" and
the hook never blocks the very change the user asked for. Never hand-edit
`branch-lock.yaml` — go through the CLI so `lock-store` stays the single writer.

## Install the hooks (first time only)

If the hooks are not yet wired in this repo, install them before relying on the lock:

1. Copy [scripts/branch-lock-hook.sh](scripts/branch-lock-hook.sh),
   [scripts/branch-lock-session-start.sh](scripts/branch-lock-session-start.sh),
   **and the `scripts/lib/` directory** to `.claude/hooks/branch-lock/` (both
   hooks source the modules from `lib/` relative to themselves — keep them
   together).
2. `chmod +x` both hooks.
3. Register them in `.claude/settings.json` (merge into any existing arrays —
   don't overwrite other hooks). `branch-lock-hook.sh` enforces the lock under
   `PreToolUse`/matcher `Bash`; `branch-lock-session-start.sh` offers the lock
   under `SessionStart`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "hooks": [
             { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/branch-lock/branch-lock-hook.sh" }
           ]
         }
       ],
       "SessionStart": [
         {
           "hooks": [
             { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/branch-lock/branch-lock-session-start.sh" }
           ]
         }
       ]
     }
   }
   ```

   The SessionStart hook only injects an instruction asking whether to lock — it
   never writes the lock itself. On a `yes` the agent runs `branch-lock.sh set`;
   a `no` leaves the repo unlocked. It stays silent inside `/afk` worktrees, when
   a lock is already present, and on a detached HEAD.

## DOs / DON'Ts

- ✅ Always route lock changes through `scripts/branch-lock.sh`.
- ✅ Confirm the resulting `status` to the user after `set`/`clear`.
- ❌ Don't hand-edit or `git add` `branch-lock.yaml` — it lives under gitignored `.red/tmp/`.
- ❌ Don't try to make the lock block the human terminal — out of scope by design (ADR 0006).

</what-to-do>

<supporting-info>

## Layout

```
branch-lock/
├── SKILL.md
└── scripts/
    ├── branch-lock.sh            ← /branch-lock CLI (set | clear | status)
    ├── branch-lock-hook.sh       ← PreToolUse(Bash) hook (composes the 3 modules)
    ├── branch-lock-session-start.sh ← SessionStart hook (offers to lock at start)
    ├── lib/
    │   ├── lock-store.sh          ← read/write/clear branch-lock.yaml
    │   ├── scope-resolver.sh      ← primary enforces, .red/tmp/work-*/ exempt
    │   └── git-command-classifier.sh ← branch-switch + work-loss family = block
    └── tests/
        ├── lock-store.test.sh
        ├── scope-resolver.test.sh
        ├── git-command-classifier.test.sh
        ├── session-start.test.sh
        └── branch-lock-cli.test.sh    ← /branch-lock set: atomic relock-then-switch
```

## What the hook blocks vs allows

Locked to `<branch>`, in the primary checkout, the hook blocks:

- `git checkout <other>` / `git switch <other>` — switching to any other branch
- `git checkout -b <new>` / `git switch -c <new>` — leaving via a new branch
- `git switch -` — switching to the previous branch
- `git stash` / `git stash push` / `git stash save` — shelving away the working tree
- `git clean -f` (any force flag: `-fd`, `-xfd`, `--force`) — deleting untracked files
- `git reset --hard` — discarding the working tree
- `git checkout .` / `git checkout -- .` / `git restore .` — whole-tree restore

It allows (exit 0, silent):

- `git checkout <branch>` / `git switch <branch>` — switching back to the lock target
- `git checkout -- <path>` / `git restore <path>` — targeted file-level restore
- `git stash list` / `git stash show` — read-only stash
- `git clean -n` / `--dry-run` — non-destructive clean
- `git reset --soft` / mixed reset, `git restore --staged <path>` — no working-tree loss
- `git worktree add …` — worktrees are how `/afk` works
- any other command

## Tests

Pure-module unit tests, run directly with bash:

```bash
for t in scripts/tests/*.test.sh; do bash "$t"; done
```

Each prints `summary: N passed, 0 failed` and exits non-zero on any failure.

## Scope of this slice

Part of PRD #59. The lock-store, scope-resolver, classifier (branch-switch +
work-loss family), PreToolUse hook, the SessionStart hook that offers to lock at
session start, and the `/branch-lock` command are shipped. Not yet included
(later slices): the PRD/issue branch pin read by `/afk`, and making
`git-guardrails` lock-aware.

</supporting-info>
