#!/usr/bin/env bash
# lib/remote-branch.sh — continuous remote-branch push for AFK workers (issue #191).
#
# Today's failure mode: a worker dies mid-iteration (SIGKILL from supervisor crash,
# OOM, manual kill) **before** the terminal-failure envelope is built. The worker
# branch `afk/{wid}/{N}-slug` never reaches origin, the iter dir is rm'd by the
# next boot's Orphan Cleanup, and the diff is lost. We've recovered work by hand
# 6+ times across two sessions.
#
# Fix: keep `afk/{wid}/{N}-slug` mirrored on origin throughout the iteration.
#
#   push_initial <worktree> <branch>
#     Push HEAD to origin/<branch> at worktree-create time so the remote ref
#     exists from minute zero — any kill from here on preserves work. Always
#     returns 0; on failure logs `warn:` and continues (the afk-attempts/*
#     failure-push safety net is still in place).
#
#   install_post_commit_hook <worktree> <branch>
#     Drop an executable `.git/hooks/post-commit` into the worktree that
#     fire-and-forgets a `git push origin HEAD --force-with-lease`. Every inner-
#     agent commit hits origin within seconds. Always returns 0; on failure logs
#     a `warn:` line and continues — the worker is still useful without it.
#
#   delete_remote <branch>
#     Best-effort `git push origin --delete <branch>` from the primary checkout,
#     called only on DONE iterations (after `gh issue close --reason completed`
#     succeeds) so the remote branch graveyard stays manageable. Always returns
#     0; if delete fails (branch protection, network) the close path still
#     proceeds.
#
# What this lib deliberately does NOT touch: the `afk-attempts/{wid}/{N}-slug`
# failure-push namespace. That stays the canonical 'failed work' marker the
# terminal-failure envelope links to. `afk/*` is the live-iteration namespace;
# `afk-attempts/*` is the failure namespace; they never overlap.

# Logger — match the sibling lib/*.sh convention. afk.sh defines `log` as a
# function; when this lib is sourced into a context that doesn't (e.g. unit
# tests), we fall back to a stderr printf so calls still produce output.
_remote_branch_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$*"
  else
    printf '[afk] %s\n' "$*" >&2
  fi
}

# push_initial <worktree> <branch>
#
# Push the local HEAD of <worktree> to `refs/heads/<branch>` on origin using
# --force-with-lease (cheap defence against the rare case where a previous
# attempt's branch still lingers on the remote). Best-effort: always returns 0.
push_initial() {
  local worktree="$1" branch="$2"
  if [[ -z "$worktree" || -z "$branch" ]]; then
    _remote_branch_log "warn: push_initial called with empty worktree or branch — skipping"
    return 0
  fi
  if ! git -C "$worktree" push origin -u "HEAD:refs/heads/${branch}" --force-with-lease >/dev/null 2>&1; then
    _remote_branch_log "warn: initial push for ${branch} failed, continuing without remote backup"
  fi
  return 0
}

# install_post_commit_hook <worktree> <branch>
#
# Write `$worktree/.git/hooks/post-commit` (mode 0755) so every inner-agent
# commit triggers a non-blocking push to origin/<branch>. The trailing
# `|| true` is load-bearing: a non-zero exit from a post-commit hook does
# NOT abort the commit (git ignores its exit status), but we belt-and-braces
# it anyway so the hook is a pure side-effect.
#
# Git worktrees keep their hooks under `<worktree>/.git/hooks/` (which is the
# linked-checkout's gitdir, distinct from the main checkout's hooks dir), so a
# hook installed here cannot leak into other worktrees or the primary.
install_post_commit_hook() {
  local worktree="$1" branch="$2"
  if [[ -z "$worktree" || -z "$branch" ]]; then
    _remote_branch_log "warn: install_post_commit_hook called with empty worktree or branch — skipping"
    return 0
  fi

  local git_dir
  git_dir="$(git -C "$worktree" rev-parse --git-dir 2>/dev/null)"
  if [[ -z "$git_dir" ]]; then
    _remote_branch_log "warn: could not resolve .git dir for ${worktree} — post-commit hook not installed"
    return 0
  fi
  # `git rev-parse --git-dir` may return a relative path; resolve against worktree.
  if [[ "$git_dir" != /* ]]; then
    git_dir="$worktree/$git_dir"
  fi

  local hooks_dir="$git_dir/hooks"
  mkdir -p "$hooks_dir" 2>/dev/null || {
    _remote_branch_log "warn: could not create hooks dir at ${hooks_dir} — post-commit hook not installed"
    return 0
  }

  local hook_path="$hooks_dir/post-commit"
  if ! cat >"$hook_path" <<'HOOK'
#!/usr/bin/env bash
# AFK continuous-push hook (issue #191)
# Fire-and-forget: push the worker branch to origin after every commit so a
# SIGKILL of the orchestrator at any point preserves the diff on the remote.
git push origin HEAD --force-with-lease 2>/dev/null || true
HOOK
  then
    _remote_branch_log "warn: could not write ${hook_path} — post-commit hook not installed"
    return 0
  fi

  if ! chmod 0755 "$hook_path" 2>/dev/null; then
    _remote_branch_log "warn: could not chmod ${hook_path} — post-commit hook not installed"
    return 0
  fi

  return 0
}

# delete_remote <branch>
#
# Best-effort `git push origin --delete <branch>` from the primary checkout
# (PROJECT_ROOT). Called only after `gh issue close --reason completed`
# succeeds, before the local `git branch -D`. Failure here never blocks the
# close: branch protection, network blips, and races with a manual delete all
# log a warn and return 0.
delete_remote() {
  local branch="$1"
  if [[ -z "$branch" ]]; then
    _remote_branch_log "warn: delete_remote called with empty branch — skipping"
    return 0
  fi

  local repo_dir="${PROJECT_ROOT:-$(pwd)}"
  if ! git -C "$repo_dir" push origin --delete "$branch" >/dev/null 2>&1; then
    _remote_branch_log "warn: failed to delete remote ${branch} after close, branch survives on origin for cleanup later"
  fi
  return 0
}
