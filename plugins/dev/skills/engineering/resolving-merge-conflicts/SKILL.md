---
name: resolving-merge-conflicts
working-mode: interactive
description: Guided merge-conflict resolution loop. Inspect state → find each side's intent → resolve every hunk preserving both intents → run the project's checks. Never abort. Use when a merge, rebase, or cherry-pick leaves conflict markers in tracked files.
---

# Resolving Merge Conflicts

**Intent preservation is the only goal — not picking a winner.** Each side touched that line for a reason; your job is to honour both reasons in the resolved output.

<what-to-do>

### Step 1 — Inspect state

Before touching any file, understand what kind of operation produced the conflicts:

```bash
git status          # lists every file with conflict markers
git log --merge     # shows the two commits being reconciled
```

Identify the operation type — `MERGE_HEAD` means a merge, `REBASE_HEAD` means a rebase, `CHERRY_PICK_HEAD` means a cherry-pick. The semantics differ:

- **Merge**: two independent branches are being joined. Both sides' changes are equally valid.
- **Rebase**: commits are being replayed on top of a new base. The "ours" side is the base, the "theirs" side is the patch being applied.
- **Cherry-pick**: a single commit is being applied. "Theirs" is the patch; "ours" is the current state.

### Step 2 — Find each side's primary source and original intent

For each conflicted file, read the full diff for each branch **before** looking at the conflict markers. Use:

```bash
git diff ORIG_HEAD...HEAD -- <file>     # what "ours" changed vs the merge base
git diff MERGE_HEAD...HEAD -- <file>    # what "theirs" changed vs the merge base (merge)
git show REBASE_HEAD -- <file>          # theirs during rebase
```

For each conflict block, answer two questions before resolving it:

1. *Why did "ours" change this?* — find the commit message, PR, or issue that explains it.
2. *Why did "theirs" change this?* — same.

**Never resolve a hunk you cannot explain both sides of.** If the intent is unclear, read the surrounding commit history (`git log --oneline -10 -- <file>`) or the linked PR/issue rather than guessing.

### Step 3 — Resolve every hunk, preserving both intents

For each conflict block (`<<<<<<<` … `=======` … `>>>>>>>`):

1. **If both sides changed different things** (different lines, no semantic overlap): include both changes. Edit the block so both modifications appear in the output; order them to maintain the file's logical flow.
2. **If both sides changed the same lines** (semantic overlap): produce a version that achieves both intentions. Write the merged result explicitly — do not just pick one side.
3. **If one side deleted what the other modified**: include the modification, not the deletion, unless the deletion's intent makes the modification meaningless. Explain your reasoning in the commit message.

Hard rules:

- ❌ Do **not** run `git merge --abort`, `git rebase --abort`, or `git cherry-pick --abort`. Aborting discards work; resolve instead.
- ❌ Do **not** accept "ours" or "theirs" wholesale with `git checkout --ours` / `--theirs` without verifying the other side's intent is preserved.
- ❌ Do **not** leave conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in any file when you are done.
- ✅ **Do** remove the markers and all three sections, replacing them with a single coherent resolution.

### Step 4 — Discover and run the project's automated checks

After resolving all hunks, find the project's test and lint commands. Look for them in this order:

1. `package.json` → `scripts` block (`test`, `lint`, `typecheck`, `build`)
2. `Makefile` → `make test`, `make lint`
3. `README.md` → "how to run tests" section
4. CI config (`.github/workflows/`, `.circleci/config.yml`, etc.) — the commands the pipeline runs

Run every check that covers the conflicted files. A resolution that breaks a test is not a resolution.

### Step 5 — Complete the operation

Once all conflicts are resolved and all checks pass:

```bash
git add -- <each resolved file>   # stage by name, never git add -A
git merge --continue              # or git rebase --continue / git cherry-pick --continue
```

Write a commit message that names both intents that were reconciled, e.g.:

> "Merge: preserve both the cache-invalidation fix (#42) and the retry-backoff refactor (#67)"

</what-to-do>

<supporting-info>

## Reading conflict markers

```
<<<<<<< HEAD (ours)
  const timeout = 5000
=======
  const timeout = retryConfig.timeoutMs
>>>>>>> feature/retry-backoff (theirs)
```

- `HEAD` / `ours` — the branch you were on when you ran `git merge`/`git cherry-pick`, or the new base during a rebase.
- `theirs` — the branch being merged in, the patch being applied, or the commit being replayed.
- The merge base (the common ancestor) is visible via `git merge-base HEAD MERGE_HEAD` and can be checked out to a temp file with `git show $(git merge-base HEAD MERGE_HEAD):<file>`.

## Diff3 style for three-way context

Enable extended conflict markers to see the merge-base version alongside both sides:

```bash
git config merge.conflictstyle diff3
```

With `diff3`, conflict blocks show three sections:

```
<<<<<<< HEAD
  const timeout = 5000
||||||| merged common ancestors
  const timeout = 3000
=======
  const timeout = retryConfig.timeoutMs
>>>>>>> feature/retry-backoff
```

The middle `|||||||` section is the merge base — it shows what the file looked like before either branch touched it. This makes each side's intent immediately clear.

## When a file is marked "both deleted" or "both added"

- **Both deleted**: the file is already gone on both sides. Stage with `git rm -- <file>` and move on.
- **Both added** (same path, different content): treat the whole file as one large conflict block. Follow Step 3 to produce a single merged file.

## When a binary file conflicts

Git cannot produce text conflict markers for binary files. Inspect the two versions:

```bash
git show HEAD:<file> > /tmp/ours.<ext>
git show MERGE_HEAD:<file> > /tmp/theirs.<ext>
```

Choose the correct version or produce a new merged binary through the appropriate tool (image editor, compiled output, etc.), then stage the result.

## Handling renames

If one side renamed a file while the other modified it, Git may detect this as `both modified` on the **new** path. Confirm with `git status` and check that the resolved file lives at the correct path before staging.

</supporting-info>
