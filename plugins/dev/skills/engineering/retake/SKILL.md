---
name: retake
description: Reconstructs the local and GitHub state for a specific issue, including linked PRs, matching branches, local worktrees, HITL state, and the next command to finish it. Use when the user invokes `/retake #123`, asks to resume an issue, recover abandoned work, find the right worktree/PR, or organize an issue so it can be shipped.
argument-hint: "#ISSUE [--apply] [--json] [--repo OWNER/REPO] [--pr-limit N]"
---

# /retake

**Find where the work lives and print the one next action — `/requeue` is the tail command for a committed worktree ready to land (the retired `/ship` is never suggested, ADR 0081); brand-new one-off work goes through `/go`.**

## Run

```bash
red-skills-dev retake 123
```

Use `--json` when another tool or agent needs structured state. The runtime
accepts both `123` and `#123`; quote `'#123'` if invoking it through a shell.

Use `--apply` to execute only safe local setup steps: create a missing
`.red/tmp/work-ship-*` worktree, recreate it from a matching branch, or fetch a
PR head branch and create the ship worktree. `--apply` never merges, closes
issues, edits labels, runs `/requeue`, or changes the primary checkout branch.

## Behaviour

1. Read the GitHub issue and labels.
2. Find matching PRs from recent PRs plus `#ISSUE` search hits.
3. Find matching local and remote branches by issue number in the branch name.
4. Find matching local worktrees and mark them `clean` or `dirty`.
5. Print one next action:
   - `ready-for-human` issue -> run `/hitl #ISSUE`
   - open PR with failing/pending checks or changes requested -> fix the PR branch
   - dirty matching worktree -> continue in that worktree
   - clean open PR -> run `/requeue ISSUE` to adopt and land it through the reconcile lane
   - matching branch but no worktree -> recreate a `.red/tmp/work-ship-*` worktree
   - no local state -> create a fresh `.red/tmp/work-ship-*` branch from `origin/main`
6. With `--apply`, run the safe local `git` operations for the selected action
   and print the next `cd`, `/requeue`, or `/go` command.

`/retake` is intentionally non-destructive. It does not delete branches, close
issues, merge PRs, or switch the primary checkout's branch.
