# Branch lock enforces on the agent only, not the human terminal

The `branch-lock` skill (PRD #59) lets a developer pin work to one branch and
block switching away. The enforcement question is *whose* git operations the
lock should constrain: the agent's, the human's own terminal, or both.

## Decision

The branch lock blocks the **agent only**, through a Claude Code
`PreToolUse(Bash)` hook. The human's own terminal is intentionally **out of
scope**. The same applies to every future work-losing block the lock grows
(`git stash`, `git clean`, `git reset --hard`): all are agent-only.

## Why

- **It matches what the tooling can actually intercept.** A Claude Code hook
  sees the agent's tool calls and nothing else. Constraining the human terminal
  would need a different mechanism — repo-level git hooks — with a different
  install path, different failure modes, and the ability to get in the human's
  way during legitimate manual recovery.
- **It matches the constraint the user expressed**: protection on what the
  *agent* does to the branch ("toda vez que VOCÊ colocar a mão no código"), not
  a lock on the human's own hands.
- **It keeps the blast radius small.** An agent-only hook can only ever deny an
  agent tool call; it can never wedge a human mid-rebase. The human stays the
  escape hatch — they change or clear the lock with `/branch-lock`.

## Rejected alternatives

- **Git-level hooks blocking everyone, including the human terminal.** Broader
  coverage, but intrusive, easy to fight during manual recovery, and a separate
  install surface. Rejected.
- **Both layers (agent hook + git hook).** Doubles the mechanism and the
  surprise for marginal benefit over the agent-only hook. Rejected in favour of
  agent-only.

## Consequences

- The lock is enforced via `PreToolUse(Bash)`; a denied switch exits 2 with a
  message naming the locked branch and the allowed same-branch operations.
- The hook is **self-contained** — it composes the `lock-store`,
  `scope-resolver`, and `git-command-classifier` modules and depends on no other
  skill, so installing `branch-lock` alone gives full protection. If
  `git-guardrails-claude-code` is also installed (and later made lock-aware),
  the two hooks stack idempotently.
- `/afk` worktrees under `.red/tmp/work-*/` are exempt by toplevel location, so
  the autonomous loop is never strangled by an interactive session's lock.
- A human who needs to do something the lock forbids changes or clears the lock
  rather than fighting a terminal-level block that does not exist.
