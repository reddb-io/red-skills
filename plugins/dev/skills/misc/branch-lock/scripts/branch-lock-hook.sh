#!/usr/bin/env bash
# branch-lock-hook.sh — PreToolUse(Bash) hook that blocks the agent from
# switching away from the locked branch. Self-contained: composes the three
# pure modules (lock-store, scope-resolver, git-command-classifier) into one
# allow/block verdict, with no dependency on the git-guardrails skill.
#
# Reads the Claude Code PreToolUse payload on stdin, extracts the Bash command,
# and:
#   1. resolves the project root (CLAUDE_PROJECT_DIR, else the git toplevel);
#   2. exits 0 (allow) when the checkout is an /afk worktree — scope exemption;
#   3. exits 0 (allow) when no lock file is present — unlocked is the default;
#   4. classifies the command; on "block" prints a clear message to stderr and
#      exits 2 (the Claude Code convention for "deny this tool call").
#
# Any verdict other than block is a silent exit 0, so the hook never adds noise
# to allowed commands.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/lock-store.sh
source "$HERE/lib/lock-store.sh"
# shellcheck source=lib/scope-resolver.sh
source "$HERE/lib/scope-resolver.sh"
# shellcheck source=lib/git-command-classifier.sh
source "$HERE/lib/git-command-classifier.sh"

INPUT="$(cat)"
COMMAND="$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null)"
[[ -z "$COMMAND" ]] && exit 0

# Project root: prefer the harness-provided dir, fall back to the git toplevel.
ROOT="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$ROOT" ]]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
[[ -z "$ROOT" ]] && exit 0

# Scope: /afk worktrees are exempt even when a lock is active.
scope_should_enforce "$ROOT" || exit 0

LOCKFILE="$ROOT/.red/tmp/branch-lock.yaml"
LOCK_BRANCH="$(lock_store_read "$LOCKFILE")" || exit 0   # absent => unlocked

if [[ "$(classify_git_command "$LOCK_BRANCH" "$COMMAND")" == "block" ]]; then
  cat >&2 <<EOF
BLOCKED by branch lock: this session is locked to '$LOCK_BRANCH'.
The command '$COMMAND' would switch the agent away from the locked branch or
discard working-tree changes (stash, clean -f, reset --hard, whole-tree restore).

Allowed while locked: switching back to '$LOCK_BRANCH', targeted file restore
('git checkout -- <path>', 'git restore <path>'), read-only stash, dry-run clean,
soft/mixed reset, and 'git worktree add'. To change or release the lock, ask the
user — they drive it with '/branch-lock <branch>' or '/branch-lock clear'.
EOF
  exit 2
fi

exit 0
