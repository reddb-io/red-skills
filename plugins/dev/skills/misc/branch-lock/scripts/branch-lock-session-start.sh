#!/usr/bin/env bash
# branch-lock-session-start.sh — SessionStart hook that offers, once at session
# start, to lock the agent to the current branch. Self-contained: reuses the
# same two pure modules as the PreToolUse hook (lock-store, scope-resolver) so
# the prompt obeys the exact same scope rule as enforcement.
#
# On SessionStart it:
#   1. resolves the project root (CLAUDE_PROJECT_DIR, else the git toplevel);
#   2. stays silent (exit 0, no output) inside an /afk worktree — the lock
#      protects the interactive primary checkout, never the autonomous loop;
#   3. stays silent when a lock is already present — nothing to offer;
#   4. stays silent on a detached HEAD — there is no branch to lock;
#   5. otherwise emits a SessionStart additionalContext block instructing the
#      agent to ask the user whether to lock to the current branch before doing
#      anything else.
#
# The hook never writes the lock itself: it only injects the instruction. The
# agent runs `branch-lock.sh set <branch>` (or the user's /branch-lock command)
# on a "yes", and leaves the repo unlocked on a "no".

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/lock-store.sh
source "$HERE/lib/lock-store.sh"
# shellcheck source=lib/scope-resolver.sh
source "$HERE/lib/scope-resolver.sh"

# session_start_should_prompt <root> <lockfile> <branch>
#   Returns 0 (prompt) only in the primary checkout, while unlocked, with a real
#   branch checked out. Returns 1 (stay silent) otherwise. No output.
session_start_should_prompt() {
  local _root="$1" _lockfile="$2" _branch="$3"
  scope_should_enforce "$_root" || return 1          # worktree => exempt
  lock_store_is_locked "$_lockfile" && return 1      # already locked => nothing to offer
  [[ -z "$_branch" || "$_branch" == "HEAD" ]] && return 1   # detached / no branch
  return 0
}

# session_start_prompt_text <branch>
#   The instruction injected into the agent's context.
session_start_prompt_text() {
  local _branch="$1"
  cat <<EOF
branch-lock: this session is on branch '$_branch' in the primary checkout, and the branch is not locked. Before doing anything else, ask the user whether to lock the agent to '$_branch' for this session, showing the branch name. If they say yes, lock it with the /branch-lock command (or run scripts/branch-lock.sh set '$_branch'). If they say no, leave the repo unlocked and proceed. Do not lock without an explicit yes.
EOF
}

main() {
  # Drain stdin (SessionStart sends a JSON payload we don't need to inspect).
  cat >/dev/null 2>&1 || true

  local root="${CLAUDE_PROJECT_DIR:-}"
  if [[ -z "$root" ]]; then
    root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  [[ -z "$root" ]] && exit 0

  local lockfile="$root/.red/tmp/branch-lock.yaml"
  local branch
  branch="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

  session_start_should_prompt "$root" "$lockfile" "$branch" || exit 0

  local text
  text="$(session_start_prompt_text "$branch")"

  if command -v jq >/dev/null 2>&1; then
    jq -nc --arg ctx "$text" \
      '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
  else
    # Fallback: bare stdout is added to the session context too.
    printf '%s\n' "$text"
  fi
  exit 0
}

# Run main only when executed directly, not when sourced by tests.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
