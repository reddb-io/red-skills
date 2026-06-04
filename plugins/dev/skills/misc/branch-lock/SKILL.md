---
name: branch-lock
description: Lock the agent to a branch and block it from switching away. Sets up self-contained pre-tool hooks that block the agent's git checkout/switch to any other branch while a lock is active, and gives you a /branch-lock command to set, change, and clear the lock. Use when you want the agent pinned to one branch for a session.
---

# Branch Lock

Pins the agent to a single branch in the primary checkout and blocks it from
switching away. The lock is a local fact — `./.red/tmp/branch-lock.yaml` whose
content is the branch name — under the gitignored `.red/tmp/`, so every checkout
and machine locks independently and nothing is committed. Absence of the file
means unlocked: protection is strictly opt-in.

The dev plugin also ships a dormant primary-checkout branch guard for the
interactive development loop (ADR 0043). When `.red/config.yaml` contains:

```yaml
dev:
  lock-primary-branch: true
```

the same pre-tool hook blocks the agent from changing the primary checkout's
branch (`git switch <branch>`, `git checkout <branch>`, `git switch -b <new>`)
even without a `branch-lock.yaml` file. Missing config or a missing key means
off. `git commit`, `git worktree add`, read-only git, and `.red/tmp/work-*/`
worktrees stay allowed.

Enforcement is **agent-only**, via runner pre-tool hooks — Claude Code
`PreToolUse(Bash)` and Codex plugin `PreToolUse` — that intercept the agent's own
tool calls, not the human's terminal. The plugin-level hook is dormant until a
lock file exists or `dev.lock-primary-branch` is true. See
[ADR 0006](../../../../../.red/adr/0006-branch-lock-agent-only-enforcement.md).
The hook logic is self-contained: it depends on neither the
`git-guardrails-claude-code` skill nor anything else, and the two stack
harmlessly if both are installed.

`/afk` and `/ship` worktrees under `.red/tmp/work-*/` are always exempt — the lock protects
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

### Codex

The `dev` plugin ships Codex wiring in
`plugins/dev/.codex-plugin/plugin.json` (`"hooks": "./hooks/codex.hooks.json"`).
That manifest calls `plugins/dev/hooks/branch-lock-codex.sh`, which reads Codex
`PreToolUse` payloads and reuses the same `lock-store`, `scope-resolver`, and
`git-command-classifier` modules as the Claude hook.

Codex must load the updated `dev` plugin, and plugin hooks must be enabled.
Current Codex builds list `plugin_hooks` as stable/enabled; older builds may
need `[features].plugin_hooks = true` in `~/.codex/config.toml`. Once that is
true, no per-repo `.codex/` copy is needed: set the lock with
`scripts/branch-lock.sh set` or the `/branch-lock` skill command and the Codex
hook enforces it for shell-command tool calls. If Codex has plugin hooks
disabled, the lock file may exist but Codex will not enforce it.

### Claude Code

The `dev` plugin ships Claude wiring in
`plugins/dev/.claude-plugin/plugin.json` (`"hooks": "./hooks/claude.hooks.json"`).
That manifest registers `branch-lock-hook.sh` under `PreToolUse`/matcher `Bash`
at the plugin level, so no per-repo `.claude/settings.json` copy is needed for
the dormant primary-branch guard. The hook reads `.red/config.yaml` at runtime
and stays silent until `dev.lock-primary-branch: true` or a branch-lock file is
present.

Manual per-repo installation is only needed for older/pluginless Claude setups:
copy [scripts/branch-lock-hook.sh](scripts/branch-lock-hook.sh),
[scripts/branch-lock-session-start.sh](scripts/branch-lock-session-start.sh),
and `scripts/lib/` together into `.claude/hooks/branch-lock/`, make the scripts
executable, and register `branch-lock-hook.sh` under `PreToolUse`/matcher `Bash`.
The optional SessionStart hook only injects an instruction asking whether to
lock; it never writes the lock itself.

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
├── ../../../hooks/
│   ├── codex.hooks.json          ← Codex plugin hook manifest
│   └── branch-lock-codex.sh      ← Codex PreToolUse hook
└── scripts/
    ├── branch-lock.sh            ← /branch-lock CLI (set | clear | status)
    ├── branch-lock-hook.sh       ← Claude PreToolUse(Bash) hook
    ├── branch-lock-session-start.sh ← SessionStart hook (offers to lock at start)
    ├── lib/
    │   ├── dev-config.sh          ← read dev.lock-primary-branch from .red/config.yaml
    │   ├── lock-store.sh          ← read/write/clear branch-lock.yaml
    │   ├── scope-resolver.sh      ← primary enforces, .red/tmp/work-*/ exempt
    │   └── git-command-classifier.sh ← branch-switch + work-loss family = block
    └── tests/
        ├── lock-store.test.sh
        ├── scope-resolver.test.sh
        ├── git-command-classifier.test.sh
        ├── dev-config.test.sh
        ├── session-start.test.sh
        ├── claude-plugin-hook.test.sh
        ├── codex-hook.test.sh
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

With `dev.lock-primary-branch: true` and no branch-lock file, the primary guard
blocks only branch-changing commands in the primary checkout:

- blocks `git switch <branch>`, `git checkout <branch>`, `git switch -b <new>`,
  `git checkout -b <new>`, and `git switch -`
- allows `git commit`, `git worktree add`, `git status` / read-only git,
  targeted path checkout, and every `.red/tmp/work-*/` worktree

## Tests

Pure-module unit tests, run directly with bash:

```bash
for t in scripts/tests/*.test.sh; do bash "$t"; done
```

Each prints `summary: N passed, 0 failed` and exits non-zero on any failure.

## Scope of this slice

Part of PRD #59. The lock-store, scope-resolver, classifier (branch-switch +
work-loss family), Claude and Codex PreToolUse hooks, the SessionStart hook that
offers to lock at session start, and the `/branch-lock` command are shipped. Not
yet included
(later slices): the PRD/issue branch pin read by `/afk`, and making
`git-guardrails` lock-aware.

</supporting-info>
