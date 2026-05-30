#!/usr/bin/env bash
# On-demand AFK branch reaper (issue #275).
#
# Usage:
#   afk-reap.sh [project_root]
#
# Prints one branch-count line, then runs cleanup for:
#   - origin/afk/*
#   - origin/afk-attempts/*
#   - local afk/*
#
# It does not claim issues, spawn workers, or run lifecycle hooks.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-$(pwd)}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
export PROJECT_ROOT

log() { printf '[afk] %s\n' "$*" >&2; }

gh_repo() {
  local remote repo
  remote="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$remote" in
    git@github.com:*.git)
      repo="${remote#git@github.com:}"
      printf '%s\n' "${repo%.git}"
      return 0
      ;;
    git@github.com:*)
      printf '%s\n' "${remote#git@github.com:}"
      return 0
      ;;
    https://github.com/*.git)
      repo="${remote#https://github.com/}"
      printf '%s\n' "${repo%.git}"
      return 0
      ;;
    https://github.com/*)
      printf '%s\n' "${remote#https://github.com/}"
      return 0
      ;;
  esac
  gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true
}

command -v git >/dev/null || { log "ERROR: git not installed"; exit 2; }
command -v gh >/dev/null || { log "ERROR: gh not installed"; exit 2; }
command -v jq >/dev/null || { log "ERROR: jq not installed"; exit 2; }
git -C "$PROJECT_ROOT" rev-parse --show-toplevel >/dev/null 2>&1 || {
  log "ERROR: ${PROJECT_ROOT} is not a git repo"
  exit 2
}

# shellcheck source=./lib/remote-branch.sh
source "$SCRIPT_DIR/lib/remote-branch.sh"

run_afk_branch_reaper "$PROJECT_ROOT"
