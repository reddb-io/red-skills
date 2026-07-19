#!/usr/bin/env bash
# branch-lock.sh — the CLI behind the /branch-lock command. Sets, clears, and
# reports the branch lock, keeping lib/lock-store.sh the single writer of the
# lock file. The lock always lives at <root>/.red/tmp/branch-lock.yaml, where
# <root> is CLAUDE_PROJECT_DIR (set by the harness) or the git toplevel.
#
# Usage:
#   branch-lock.sh set [branch]   lock to <branch> (default: current branch),
#                                 atomic relock-then-switch — rewrite the lock
#                                 target first so the move "back to the lock
#                                 target" is itself allowed by the hook, then
#                                 switch the working tree if not already there.
#   branch-lock.sh clear          release the lock.
#   branch-lock.sh status         print the locked branch, or "unlocked".

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/lock-store.sh
source "$HERE/lib/lock-store.sh"

resolve_root() {
  local root="${CLAUDE_PROJECT_DIR:-}"
  [[ -z "$root" ]] && root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -z "$root" ]] && { echo "branch-lock: not inside a git repo and CLAUDE_PROJECT_DIR unset" >&2; return 1; }
  printf '%s' "$root"
}

main() {
  local action="${1:-status}"
  local root lockfile
  root="$(resolve_root)" || return 1
  lockfile="$root/.red/tmp/branch-lock.yaml"

  case "$action" in
    set)
      local branch="${2:-}"
      [[ -z "$branch" ]] && branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
      [[ -z "$branch" ]] && { echo "branch-lock: no branch given and HEAD is detached" >&2; return 1; }
      # Atomic relock-then-switch: rewrite the target before moving, so the
      # subsequent switch is "return to the lock target" and the hook allows it.
      lock_store_write "$lockfile" "$branch" || return 1
      local current; current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
      if [[ -n "$current" && "$current" != "$branch" ]]; then
        git switch "$branch" || { echo "branch-lock: locked to '$branch' but switch failed (resolve manually)" >&2; return 1; }
      fi
      echo "branch-lock: locked to '$branch'"
      ;;
    clear)
      lock_store_clear "$lockfile"
      echo "branch-lock: cleared (unlocked)"
      ;;
    status)
      local b
      if b="$(lock_store_read "$lockfile")"; then
        echo "branch-lock: locked to '$b'"
      else
        echo "branch-lock: unlocked"
      fi
      ;;
    *)
      echo "usage: branch-lock.sh <set [branch]|clear|status>" >&2
      return 2
      ;;
  esac
}

main "$@"
