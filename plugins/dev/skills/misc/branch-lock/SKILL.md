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

The dev plugin also ships an **unconditional** primary-checkout branch guard
(ADR 0083 §2, untouchable primary). Once the dev plugin is enabled
(`plugins.dev.enabled: true`), the pre-tool hook blocks the agent from changing
the primary checkout's branch (`git switch <branch>`, `git checkout <branch>`,
`git switch -b <new>`) — always, with no lock file and no config toggle. The
answer to "may an agent switch the primary checkout's branch" is not
configurable: it is always **no**. `git commit`, `git worktree add`, read-only
git, and `.red/tmp/work-*/` worktrees stay allowed.

The historical `dev.lock.primary-branch` key stays **readable** for backward
compatibility but can no longer enable or disable switching; the guard fires
regardless of its value. `/doctor` may note it as redundant.

```yaml
# retained for backward compatibility only — no longer toggles the guard
dev:
  lock:
    primary-branch: true
```

Enforcement is **agent-only**, via runner pre-tool hooks — Claude Code
`PreToolUse(Bash)` and Codex plugin `PreToolUse` — that intercept the agent's own
tool calls, not the human's terminal (ADR 0006, unaffected). See
[ADR 0006](../../../../../.red/adr/0006-branch-lock-agent-only-enforcement.md).
The hook logic is self-contained: it depends on neither the
`git-guardrails-claude-code` skill nor anything else, and the two stack
harmlessly if both are installed.

`/afk` and `/ship` worktrees under `.red/tmp/work-*/` are always exempt — the lock protects
the interactive primary checkout, never the autonomous loop.

<what-to-do>

**Never hand-edit `branch-lock.yaml` — route every lock change through `scripts/branch-lock.sh` so the lock-store stays single-writer.**

## Parse the request

The user invokes `/branch-lock <branch>` or `/branch-lock clear` (or just asks
to lock/unlock). Map it to one CLI action and run the bundled CLI:

- `/branch-lock <branch>` → `scripts/branch-lock.sh set <branch>`
- `/branch-lock` (no arg) → `scripts/branch-lock.sh set` (lock to the current branch)
- `/branch-lock clear` → `scripts/branch-lock.sh clear`
- "what's locked?" → `scripts/branch-lock.sh status`

The CLI does the **atomic relock-then-switch**: it rewrites the lock target
first, so the switch to that branch is itself "return to the lock target" and
the hook never blocks the very change the user asked for.

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
the primary-branch guard. The hook reads `.red/config.yaml` at runtime; once
`plugins.dev.enabled: true` it enforces the untouchable-primary rule and, when a
branch-lock file is present, the work-loss family too.

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
- ❌ Never hand-edit `branch-lock.yaml` — route via CLI so the lock-store stays single-writer.
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
    │   ├── dev-config.sh          ← read dev.lock.primary-branch from .red/config.yaml
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

In the primary checkout, once `plugins.dev.enabled: true`, the hook blocks (the
first three are the unconditional untouchable-primary rule; the rest are the
work-loss family, blocked only while a branch-lock file is present):

- `git checkout <any>` / `git switch <any>` — switching to any branch, including
  the lock target (untouchable primary — the agent can never move the primary)
- `git checkout -b <new>` / `git switch -c <new>` — leaving via a new branch
- `git switch -` — switching to the previous branch
- `git stash` / `git stash push` / `git stash save` — shelving away the working tree
- `git clean -f` (any force flag: `-fd`, `-xfd`, `--force`) — deleting untracked files
- `git reset --hard` — discarding the working tree
- `git checkout .` / `git checkout -- .` / `git restore .` — whole-tree restore

It allows (exit 0, silent):

- `git checkout -- <path>` / `git restore <path>` — targeted file-level restore
- `git stash list` / `git stash show` — read-only stash
- `git clean -n` / `--dry-run` — non-destructive clean
- `git reset --soft` / mixed reset, `git restore --staged <path>` — no working-tree loss
- `git worktree add .red/tmp/...` — worktrees are how `/afk` and `/ship` work
- `git commit`, `git status` / read-only git, and any other command

Even with no branch-lock file, the untouchable-primary guard still blocks every
branch-changing command (`git switch <branch>`, `git checkout <branch>`,
`git switch -b <new>`, `git checkout -b <new>`, `git switch -`) while allowing
`git commit`, `git worktree add`, read-only git, targeted path checkout, and
every `.red/tmp/work-*/` worktree.

The dev command proxy has a stricter host-wide invariant when
`plugins.dev.enabled: true`: any agent-created `git worktree add` destination
must resolve under the repo's `.red/tmp/`. Branch-lock allows the command class;
the dev proxy decides whether the destination path is inside the repo-owned
runtime area.

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
