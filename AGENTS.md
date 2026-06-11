## Development workflow

- Work in an isolated worktree; do not change the primary checkout's branch for task work.
- Commit the worktree, push the branch early, then run `/ship` to open or reuse a PR.
- Let `/ship` monitor checks and reviews, then either merge the PR or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. The `dev.lock.primary-branch` flag in `.red/config.yaml` is the kill-switch for the primary-branch guard.
