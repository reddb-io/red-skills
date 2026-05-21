#!/usr/bin/env bash
# lib/merge.sh — merge / integrate / rollback primitives for the afk merge stage.
#
# Pure git operations against an explicit repo dir. No network beyond the refs
# a prior `git fetch` already populated, no `gh`, no orchestrator state. These
# exist so the merge path's two failure-prone steps — integrating a moved
# origin/main before merging, and rolling back the merge commit when the push
# is rejected — can be exercised by scripts/tests/merge-integrate.test.sh
# against temporary git repos with a local bare "origin".
#
# Public surface:
#   merge_integrate_origin <repo> <remote> <branch>
#     Sync local <branch> to <remote>/<branch> (assumes a prior fetch) so the
#     worker branch later merges onto the current remote tip rather than the
#     stale boot-time HEAD. Fast-forward when local is strictly behind;
#     otherwise rebase local commits (e.g. a pre-merge snapshot) onto the
#     remote tip. Returns 0 on success, 1 if the ref is missing or the rebase
#     conflicts (rebase is aborted first).
#
#   merge_rollback <repo> <pre_merge_sha>
#     Drop the merge commit, restoring the checked-out branch to
#     <pre_merge_sha> (the integrated tip captured before `git merge`). Used
#     when the push is rejected so no orphan merge commit lingers on local
#     main. Returns the reset's exit status.

# merge_integrate_origin <repo> <remote> <branch>
merge_integrate_origin() {
  local repo="$1" remote="$2" branch="$3"
  local remote_ref="${remote}/${branch}"
  local remote_sha local_sha base

  remote_sha="$(git -C "$repo" rev-parse --verify --quiet "$remote_ref" 2>/dev/null)" || return 1
  local_sha="$(git -C "$repo" rev-parse --verify --quiet "$branch" 2>/dev/null)" || return 1

  # Already in sync — nothing to integrate.
  [[ "$local_sha" == "$remote_sha" ]] && return 0

  base="$(git -C "$repo" merge-base "$branch" "$remote_ref" 2>/dev/null || true)"

  if [[ "$base" == "$local_sha" ]]; then
    # Local is strictly behind the remote tip — fast-forward.
    git -C "$repo" merge --ff-only "$remote_ref" >/dev/null 2>&1 || return 1
  else
    # Diverged (e.g. a local pre-merge snapshot) or unrelated — replay local
    # commits onto the remote tip. Abort and fail cleanly on conflict.
    if ! git -C "$repo" rebase "$remote_ref" >/dev/null 2>&1; then
      git -C "$repo" rebase --abort >/dev/null 2>&1 || true
      return 1
    fi
  fi
  return 0
}

# merge_rollback <repo> <pre_merge_sha>
merge_rollback() {
  local repo="$1" pre_merge_sha="$2"
  git -C "$repo" reset --hard "$pre_merge_sha" >/dev/null 2>&1
}
