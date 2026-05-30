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
# The live-push lifecycle above (push_initial / install_post_commit_hook /
# delete_remote) deliberately touches ONLY the `afk/{wid}/{N}-slug` namespace.
# The `afk-attempts/{wid}/{N}-slug` failure-push namespace stays the canonical
# 'failed work' marker the terminal-failure envelope links to — `afk/*` is the
# live-iteration namespace, `afk-attempts/*` is the failure namespace, and the
# two never overlap.
#
#   prune_completed_attempt_branches [root]   (issue #258)
#     The one reaper of the `afk-attempts/*` namespace. Remote side of completion
#     cleanup: once an issue has been *closed* longer than a configurable grace
#     window, its snapshot branches are deleted from origin; within the grace
#     window (so a reopened issue can still recover prior attempts) and for any
#     still-open issue, they are left strictly in place. Best-effort, boot-time,
#     never on the close path. Complements the local-disk completion sweep
#     (completion_sweep_issue, issue #257).

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

# _attempt_snapshot_grace_s  →  prints the resolved grace window in seconds
# (default 7 days). A completed issue's snapshot branches survive this long after
# the issue closed before they are deleted. Defensive: a non-numeric
# RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S falls back to the default so an operator typo
# can never silently disable the grace. 0 is honoured (delete immediately on
# completion) — unlike the count/age caps, a zero grace is a meaningful config.
_attempt_snapshot_grace_s() {
  local v="${RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S:-$((7 * 86400))}"
  if [[ "$v" =~ ^[0-9]+$ ]]; then echo "$v"; else echo $((7 * 86400)); fi
}

# prune_completed_attempt_branches [root]
#
# Remote-side completion cleanup (issue #258, PRD #244). Enumerate the
# `afk-attempts/{wid}/{N}-slug` snapshot branches on origin, group them by the
# issue number in the ref, and for each issue:
#   - still OPEN                          → never touched (leave every branch).
#   - CLOSED, closed <= grace ago         → kept (a reopen can still recover it).
#   - CLOSED, closed >  grace ago         → every snapshot branch deleted.
#   - unclassifiable (gh error/no close)  → left strictly untouched.
# The grace window is _attempt_snapshot_grace_s. Best-effort and always rc 0:
# called at boot, never on the close path, so a slow/failing `gh` or `git` can
# never block a completion. `gh_repo` is provided by the orchestrator that
# sources this lib.
prune_completed_attempt_branches() {
  local repo_dir="${PROJECT_ROOT:-$(pwd)}"
  local repo grace now_s
  repo="$(gh_repo 2>/dev/null)" || return 0
  [[ -n "$repo" ]] || return 0
  grace="$(_attempt_snapshot_grace_s)"
  now_s="$(date +%s)"

  local refs
  refs="$(git -C "$repo_dir" ls-remote --heads origin 'refs/heads/afk-attempts/*' 2>/dev/null)" || return 0
  [[ -n "$refs" ]] || return 0

  # Group branch names by the issue number embedded in afk-attempts/{wid}/{N}-slug.
  local -A issue_branches=()
  local line ref branch issue rest
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    ref="${line#*$'\t'}"          # drop the leading "<sha><TAB>"
    branch="${ref#refs/heads/}"   # afk-attempts/{wid}/{N}-slug
    rest="${branch#afk-attempts/*/}"  # {N}-slug
    issue="${rest%%-*}"               # {N}
    [[ "$issue" =~ ^[0-9]+$ ]] || continue
    issue_branches["$issue"]+="${branch}"$'\n'
  done <<<"$refs"

  local deleted=0 issue
  for issue in "${!issue_branches[@]}"; do
    local meta state closed_at closed_s
    meta="$(gh -R "$repo" issue view "$issue" --json state,closedAt 2>/dev/null)" || continue
    [[ -n "$meta" ]] || continue
    state="$(jq -r '.state // ""' <<<"$meta" 2>/dev/null)"
    # Only a provably-CLOSED issue is eligible; OPEN or unknown → never touched.
    [[ "$state" == "CLOSED" ]] || continue
    closed_at="$(jq -r '.closedAt // ""' <<<"$meta" 2>/dev/null)"
    [[ -n "$closed_at" ]] || continue
    closed_s="$(date -d "$closed_at" +%s 2>/dev/null)" || continue
    [[ -n "$closed_s" ]] || continue
    (( now_s - closed_s > grace )) || continue   # still within grace → keep

    while IFS= read -r branch; do
      [[ -n "$branch" ]] || continue
      if git -C "$repo_dir" push origin --delete "$branch" >/dev/null 2>&1; then
        deleted=$((deleted + 1))
      else
        _remote_branch_log "warn: failed to delete remote snapshot ${branch}, survives on origin for cleanup later"
      fi
    done <<<"${issue_branches[$issue]}"
  done

  [[ $deleted -gt 0 ]] && _remote_branch_log "snapshot cleanup: deleted $deleted completed-issue attempt branch(es) past the grace window"
  return 0
}
