#!/usr/bin/env bash
# Codex PreToolUse hook for branch-lock. Mirrors the Claude Code hook but reads
# Codex payloads and prints `{}` on allowed/no-op paths.

set -uo pipefail

PLUGIN_ROOT="${CODEX_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

INPUT="$(cat 2>/dev/null || true)"

BRANCH_LOCK_DIR="$PLUGIN_ROOT/skills/misc/branch-lock/scripts"
[[ -d "$BRANCH_LOCK_DIR/lib" ]] || { printf '{}'; exit 0; }

# shellcheck source=../skills/misc/branch-lock/scripts/lib/lock-store.sh
source "$BRANCH_LOCK_DIR/lib/lock-store.sh"
# shellcheck source=../skills/misc/branch-lock/scripts/lib/scope-resolver.sh
source "$BRANCH_LOCK_DIR/lib/scope-resolver.sh"
# shellcheck source=../skills/misc/branch-lock/scripts/lib/git-command-classifier.sh
source "$BRANCH_LOCK_DIR/lib/git-command-classifier.sh"

COMMAND="$(
  jq -r '
    .tool_input.command // .tool_input.cmd //
    .input.command // .input.cmd //
    .arguments.command // .arguments.cmd //
    .command // .cmd // empty
  ' <<<"$INPUT" 2>/dev/null
)"
[[ -z "$COMMAND" ]] && { printf '{}'; exit 0; }

ROOT="$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null)"
[[ -z "$ROOT" || "$ROOT" == "null" ]] && ROOT="${CODEX_PROJECT_DIR:-}"
[[ -z "$ROOT" || "$ROOT" == "null" ]] && ROOT="$(pwd)"
if [[ -n "$ROOT" && ! -d "$ROOT/.git" ]]; then
  ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$ROOT")"
fi
[[ -z "$ROOT" ]] && { printf '{}'; exit 0; }

scope_should_enforce "$ROOT" || { printf '{}'; exit 0; }

LOCKFILE="$ROOT/.red/tmp/branch-lock.yaml"
LOCK_BRANCH="$(lock_store_read "$LOCKFILE")" || { printf '{}'; exit 0; }

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

printf '{}'
exit 0
