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
#   prune_completed_local_branches [repo-dir]   (issue #274)
#     The boot-time local reaper for stale `afk/{wid}/{N}-slug` branches. It
#     reuses the same S1 issue-state classifier as the snapshot reaper, deletes
#     branches whose issue is CLOSED, keeps OPEN/unclassified branches, and
#     refuses to touch any branch checked out by a git worktree.
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

# _local_afk_issue_from_branch <branch>
#
# Extract the issue number from a well-formed local live branch:
# afk/{worker}/{N}-slug. Echoes nothing for malformed or non-live refs so the
# cleanup cannot accidentally act on adjacent namespaces such as afk-attempts/*.
_local_afk_issue_from_branch() {
  local branch="$1" rest issue
  [[ "$branch" =~ ^afk/[^/]+/[0-9]+-[a-z0-9-]+$ ]] || return 0
  rest="${branch#afk/*/}"  # {N}-slug
  issue="${rest%%-*}"      # {N}
  [[ "$issue" =~ ^[0-9]+$ ]] || return 0
  printf '%s\n' "$issue"
}

# _local_checked_out_branches <repo-dir>
#
# Print branch short names currently checked out by any registered worktree.
# `git branch -d` would reject these too, but this explicit guard is the safety
# contract for the boot reaper: checked-out branches are skipped before issue
# classification or deletion.
_local_checked_out_branches() {
  local repo_dir="$1" line
  git -C "$repo_dir" worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
    [[ "$line" == branch\ refs/heads/* ]] || continue
    printf '%s\n' "${line#branch refs/heads/}"
  done
}

# prune_completed_local_branches [repo-dir]
#
# Boot-time cleanup for local `afk/*` live-worker branches left behind after
# their issue has already closed. Best-effort and always rc 0. Safety rules:
#   - checked-out branches are skipped without classification.
#   - OPEN, missing, and transiently unclassifiable issues are kept.
#   - CLOSED issues are deleted with `git branch -d` only, so an unexpectedly
#     unmerged branch survives for manual inspection instead of being forced.
prune_completed_local_branches() {
  local repo_dir="${1:-${PROJECT_ROOT:-$(pwd)}}"
  local repo now_s
  repo="$(gh_repo 2>/dev/null)" || return 0
  [[ -n "$repo" ]] || return 0
  now_s="$(date +%s)"

  local branches
  branches="$(git -C "$repo_dir" for-each-ref --format='%(refname:short)' refs/heads/afk 2>/dev/null)" || return 0
  [[ -n "$branches" ]] || return 0

  local -A checked=()
  local b
  while IFS= read -r b; do
    [[ -n "$b" ]] && checked["$b"]=1
  done < <(_local_checked_out_branches "$repo_dir")

  local deleted=0 branch issue class
  while IFS= read -r branch; do
    [[ -n "$branch" ]] || continue
    [[ -z "${checked[$branch]+set}" ]] || continue
    issue="$(_local_afk_issue_from_branch "$branch")"
    [[ -n "$issue" ]] || continue

    class="$(_attempt_snapshot_issue_state_from_gh "$repo" "$issue" "$now_s" 0)"
    case "$class" in
      closed-within-grace|closed-past-grace)
        if git -C "$repo_dir" branch -d "$branch" >/dev/null 2>&1; then
          deleted=$((deleted + 1))
        else
          _remote_branch_log "warn: failed to delete local live branch ${branch}, survives for cleanup later"
        fi
        ;;
      open|not-found|unresolved-transient)
        ;;
      *)
        ;;
    esac
  done <<<"$branches"

  [[ $deleted -gt 0 ]] && _remote_branch_log "local cleanup: deleted $deleted closed-issue afk branch(es)"
  return 0
}

# _attempt_snapshot_grace_s  →  prints the resolved grace window in seconds
# (default 7 days). A completed issue's snapshot branches survive this long after
# the issue closed; a 404 issue's branch survives this long after the branch's
# last commit. Defensive: a non-numeric
# RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S falls back to the default so an operator typo
# can never silently disable the grace. 0 is honoured (delete immediately on
# completion) — unlike the count/age caps, a zero grace is a meaningful config.
_attempt_snapshot_grace_s() {
  local v="${RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S:-$((7 * 86400))}"
  if [[ "$v" =~ ^[0-9]+$ ]]; then echo "$v"; else echo $((7 * 86400)); fi
}

# _attempt_snapshot_issue_from_branch <branch>
#
# Extract the issue number from afk-attempts/{worker}/{N}-slug. Echoes nothing
# for malformed refs so callers can skip them without treating bad remote data as
# fatal.
_attempt_snapshot_issue_from_branch() {
  local branch="$1" rest issue
  [[ "$branch" == afk-attempts/*/* ]] || return 0
  rest="${branch#afk-attempts/*/}"  # {N}-slug
  issue="${rest%%-*}"               # {N}
  [[ "$issue" =~ ^[0-9]+$ ]] || return 0
  printf '%s\n' "$issue"
}

# attempt_snapshot_cleanup_plan <refs> <classifier-fn> <now-s> <grace-s>
#
# Pure keep/reap decider for the `afk-attempts/*` namespace. <refs> is a
# synthetic ls-remote-shaped list:
#
#   <sha><TAB>refs/heads/afk-attempts/{worker}/{issue}-slug[<TAB><commit-s>]
#
# The optional third field is the branch's last-commit epoch and is required only
# for `not-found`, where there is no issue closedAt timestamp to anchor grace.
# <classifier-fn> is called as `<classifier-fn> <issue>` and must echo one of:
# open, closed-within-grace, closed-past-grace, not-found, unresolved-transient.
# The function performs no git/gh/date I/O and emits:
#
#   keep|reap<TAB><branch><TAB><issue><TAB><classification>
attempt_snapshot_cleanup_plan() {
  local refs="$1" classifier="$2" now_s="$3" grace_s="$4"
  [[ "$now_s" =~ ^[0-9]+$ ]] || return 0
  [[ "$grace_s" =~ ^[0-9]+$ ]] || grace_s=$((7 * 86400))
  declare -F "$classifier" >/dev/null 2>&1 || return 0

  local -A issue_class=()
  local line sha ref branch commit_s issue class action
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS=$'\t' read -r sha ref commit_s _ <<<"$line"
    [[ "$ref" == refs/heads/afk-attempts/* ]] || continue
    branch="${ref#refs/heads/}"
    issue="$(_attempt_snapshot_issue_from_branch "$branch")"
    [[ -n "$issue" ]] || continue

    if [[ -n "${issue_class[$issue]+set}" ]]; then
      class="${issue_class[$issue]}"
    else
      class="$("$classifier" "$issue" 2>/dev/null || true)"
      case "$class" in
        open|closed-within-grace|closed-past-grace|not-found|unresolved-transient) ;;
        *) class="unresolved-transient" ;;
      esac
      issue_class["$issue"]="$class"
    fi

    action="keep"
    case "$class" in
      closed-past-grace)
        action="reap"
        ;;
      not-found)
        if [[ "$commit_s" =~ ^[0-9]+$ ]] && (( now_s - commit_s > grace_s )); then
          action="reap"
        fi
        ;;
      open|closed-within-grace|unresolved-transient)
        action="keep"
        ;;
    esac

    printf '%s\t%s\t%s\t%s\n' "$action" "$branch" "$issue" "$class"
  done <<<"$refs"
}

# _attempt_snapshot_branch_commit_s <repo-dir> <sha> <branch>
#
# Best-effort branch last-commit epoch for 404 grace decisions. Prefer a local
# object lookup, then shallow-fetch that one remote branch into a remote-tracking
# ref. Echoes nothing if the date cannot be proved, which makes not-found refs
# stay in the keep plan.
_attempt_snapshot_branch_commit_s() {
  local repo_dir="$1" sha="$2" branch="$3" remote_ref
  if [[ -n "$sha" ]] && git -C "$repo_dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    git -C "$repo_dir" show -s --format=%ct "$sha" 2>/dev/null && return 0
  fi
  remote_ref="refs/remotes/origin/${branch}"
  if git -C "$repo_dir" fetch --quiet --depth=1 origin "refs/heads/${branch}:${remote_ref}" >/dev/null 2>&1; then
    git -C "$repo_dir" show -s --format=%ct "$remote_ref" 2>/dev/null && return 0
  fi
  return 0
}

# _attempt_snapshot_refs_with_commit_dates <repo-dir> <refs>
#
# Add a third `<commit-s>` field to ls-remote rows for the pure decider. Tests may
# pass a synthetic third field already; production rows are augmented
# best-effort.
_attempt_snapshot_refs_with_commit_dates() {
  local repo_dir="$1" refs="$2"
  local line sha ref commit_s branch
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS=$'\t' read -r sha ref commit_s _ <<<"$line"
    [[ "$ref" == refs/heads/afk-attempts/* ]] || continue
    branch="${ref#refs/heads/}"
    if [[ ! "$commit_s" =~ ^[0-9]+$ ]]; then
      commit_s="$(_attempt_snapshot_branch_commit_s "$repo_dir" "$sha" "$branch")"
    fi
    printf '%s\t%s\t%s\n' "$sha" "$ref" "$commit_s"
  done <<<"$refs"
}

# _attempt_snapshot_issue_state_from_gh <repo> <issue> <now-s> <grace-s>
#
# Translate the side-effecting GitHub issue lookup into the small state vocabulary
# consumed by the pure decider. A definitive 404 is `not-found`; every other
# lookup/parsing problem is `unresolved-transient`, which the planner keeps.
_attempt_snapshot_issue_state_from_gh() {
  local repo="$1" issue="$2" now_s="$3" grace_s="$4"
  local meta state closed_at closed_s lower
  meta="$(gh -R "$repo" issue view "$issue" --json state,closedAt 2>&1)" || {
    lower="${meta,,}"
    if [[ "$lower" == *"404"* || "$lower" == *"not found"* || "$lower" == *"could not resolve"* ]]; then
      printf 'not-found\n'
    else
      printf 'unresolved-transient\n'
    fi
    return 0
  }

  state="$(jq -r '.state // ""' <<<"$meta" 2>/dev/null)"
  case "$state" in
    OPEN)
      printf 'open\n'
      ;;
    CLOSED)
      closed_at="$(jq -r '.closedAt // ""' <<<"$meta" 2>/dev/null)"
      [[ -n "$closed_at" ]] || { printf 'unresolved-transient\n'; return 0; }
      closed_s="$(date -d "$closed_at" +%s 2>/dev/null)" || { printf 'unresolved-transient\n'; return 0; }
      [[ "$closed_s" =~ ^[0-9]+$ ]] || { printf 'unresolved-transient\n'; return 0; }
      if (( now_s - closed_s > grace_s )); then
        printf 'closed-past-grace\n'
      else
        printf 'closed-within-grace\n'
      fi
      ;;
    *)
      printf 'unresolved-transient\n'
      ;;
  esac
}

# prune_completed_attempt_branches [root]
#
# Remote-side completion cleanup (issue #258, PRD #244). Enumerate the
# `afk-attempts/{wid}/{N}-slug` snapshot branches on origin, group them by the
# issue number in the ref, and for each issue:
#   - still OPEN                          → never touched (leave every branch).
#   - CLOSED, closed <= grace ago         → kept (a reopen can still recover it).
#   - CLOSED, closed >  grace ago         → every snapshot branch deleted.
#   - issue API 404, branch age > grace   → that snapshot branch deleted.
#   - unclassifiable/transient gh error   → left strictly untouched.
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

  local refs_with_dates plan
  refs_with_dates="$(_attempt_snapshot_refs_with_commit_dates "$repo_dir" "$refs")"

  _attempt_snapshot_prune_classifier() {
    _attempt_snapshot_issue_state_from_gh "$repo" "$1" "$now_s" "$grace"
  }
  plan="$(attempt_snapshot_cleanup_plan "$refs_with_dates" _attempt_snapshot_prune_classifier "$now_s" "$grace")"
  unset -f _attempt_snapshot_prune_classifier 2>/dev/null || true

  local deleted=0 action branch issue class
  while IFS=$'\t' read -r action branch issue class; do
    [[ "$action" == "reap" && -n "$branch" ]] || continue
    if git -C "$repo_dir" push origin --delete "$branch" >/dev/null 2>&1; then
      deleted=$((deleted + 1))
    else
      _remote_branch_log "warn: failed to delete remote snapshot ${branch}, survives on origin for cleanup later"
    fi
  done <<<"$plan"

  [[ $deleted -gt 0 ]] && _remote_branch_log "snapshot cleanup: deleted $deleted attempt snapshot branch(es) past the grace window"
  return 0
}
