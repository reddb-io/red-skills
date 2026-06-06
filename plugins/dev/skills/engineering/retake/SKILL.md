---
name: retake
description: Reconstructs the local and GitHub state for a specific issue, including linked PRs, matching branches, local worktrees, HITL state, and the next command to finish it. Use when the user invokes `/retake #123`, asks to resume an issue, recover abandoned work, find the right worktree/PR, or organize an issue so it can be shipped.
argument-hint: "#ISSUE [--json] [--repo OWNER/REPO] [--pr-limit N]"
---

# /retake

Resume a specific issue by finding where its work currently lives and what has
to happen next. `/retake` is the front door; `/ship` remains the tail command
for a clean, committed worktree that is ready to land.

## Run

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" retake 123
```

Use `--json` when another tool or agent needs structured state. The runtime
accepts both `123` and `#123`; quote `'#123'` if invoking it through a shell.

## Behaviour

1. Read the GitHub issue and labels.
2. Find matching PRs from recent PRs plus `#ISSUE` search hits.
3. Find matching local and remote branches by issue number in the branch name.
4. Find matching local worktrees and mark them `clean` or `dirty`.
5. Print one next action:
   - `ready-for-human` issue -> run `/hitl #ISSUE`
   - open PR with failing/pending checks or changes requested -> fix the PR branch
   - dirty matching worktree -> continue in that worktree
   - clean open PR -> run `/ship --issue ISSUE` from the matching worktree
   - matching branch but no worktree -> recreate a `.red/tmp/work-ship-*` worktree
   - no local state -> create a fresh `.red/tmp/work-ship-*` branch from `origin/main`

`/retake` is intentionally non-destructive. It does not delete branches, close
issues, merge PRs, or switch the primary checkout's branch.
