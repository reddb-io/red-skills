# Worktree Base Resolution (ADR 0031)

When creating a worktree, AFK resolves the base branch with precedence **lock > pin > main**:

1. **Branch lock** — `.red/tmp/branch-lock.yaml` (written by the branch-lock skill). If set, use it.
2. **Pinned branch** — issue's `branch:` line, or its parent PRD's `branch:` line (ADR 0008). If set, use it.
3. **Main** — fallback.

When the resolved base is not `main`, AFK switches the primary checkout onto it for the merge and restores it to `main` on every exit path. This prevents subtle drift when a bot/human updates `main` mid-run.
