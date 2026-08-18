#!/usr/bin/env bash
# Codex PreToolUse hook for branch-lock. Mirrors the Claude Code hook but reads
# Codex payloads and prints `{}` on allowed/no-op paths.

set -uo pipefail

PLUGIN_ROOT="${CODEX_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

INPUT="$(timeout "${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat 2>/dev/null || true)"

allow() {
  printf '{}'
  exit 0
}

deny() {
  local reason="$1"
  printf '%s\n' "$reason" >&2
  jq -nc --arg reason "$reason" '{
    decision: "block",
    reason: $reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

BRANCH_LOCK_DIR="$PLUGIN_ROOT/skills/misc/branch-lock/scripts"
[[ -d "$BRANCH_LOCK_DIR/lib" ]] || allow

# shellcheck source=../skills/misc/branch-lock/scripts/lib/lock-store.sh
source "$BRANCH_LOCK_DIR/lib/lock-store.sh"
# shellcheck source=../skills/misc/branch-lock/scripts/lib/scope-resolver.sh
source "$BRANCH_LOCK_DIR/lib/scope-resolver.sh"
# shellcheck source=../skills/misc/branch-lock/scripts/lib/git-command-classifier.sh
source "$BRANCH_LOCK_DIR/lib/git-command-classifier.sh"
# shellcheck source=../skills/misc/branch-lock/scripts/lib/dev-config.sh
source "$BRANCH_LOCK_DIR/lib/dev-config.sh"

COMMAND="$(
  jq -r '
    .tool_input.command // .tool_input.cmd //
    .input.command // .input.cmd //
    .arguments.command // .arguments.cmd //
    .command // .cmd // empty
  ' <<<"$INPUT" 2>/dev/null
)"
[[ -z "$COMMAND" ]] && allow

ROOT="$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null)"
[[ -z "$ROOT" || "$ROOT" == "null" ]] && ROOT="${CODEX_PROJECT_DIR:-}"
[[ -z "$ROOT" || "$ROOT" == "null" ]] && ROOT="$(pwd)"
if [[ -n "$ROOT" && ! -d "$ROOT/.git" ]]; then
  ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$ROOT")"
fi
[[ -z "$ROOT" ]] && allow

# Per-directory plugin gate (ADR 0067): stay fully inert unless the dev plugin is
# enabled in this repo. Mirrors branch-lock-hook.sh.
dev_plugin_enabled "$ROOT/.red/config.yaml" || allow

scope_should_enforce "$ROOT" || allow

# Untouchable primary (ADR 0083 §2): an agent may never move the primary
# checkout's branch. Unconditional — no longer armed by the
# `dev.lock.primary-branch` toggle (kept readable for backward compatibility but
# unable to *enable* switching). Agent-only hook, so human terminals are
# unaffected (ADR 0006). Mirrors branch-lock-hook.sh.
if [[ "$(classify_primary_branch_switch_guard "$COMMAND")" == "block" ]]; then
  deny "$(cat <<EOF
BLOCKED by the untouchable-primary rule (ADR 0083): an agent can never switch
the primary checkout's branch, regardless of configuration or lock state.
The command '$COMMAND' would move the agent's primary checkout to another branch.

Allowed in the primary checkout: git commit, git worktree add, read-only git,
and non-branch-changing commands. To work on another branch, create/use a
worktree under .red/tmp/work-*/ or ask the user to change the primary branch.
EOF
  )"
fi

LOCKFILE="$ROOT/.red/tmp/branch-lock.yaml"
LOCK_BRANCH="$(lock_store_read "$LOCKFILE")" || allow

if [[ "$(classify_git_command "$LOCK_BRANCH" "$COMMAND")" == "block" ]]; then
  deny "$(cat <<EOF
BLOCKED by branch lock: this session is locked to '$LOCK_BRANCH'.
The command '$COMMAND' would switch the agent away from the locked branch or
discard working-tree changes (stash, clean -f, reset --hard, whole-tree restore).

Allowed while locked: switching back to '$LOCK_BRANCH', targeted file restore
('git checkout -- <path>', 'git restore <path>'), read-only stash, dry-run clean,
soft/mixed reset, and 'git worktree add'. To change or release the lock, ask the
user — they drive it with '/branch-lock <branch>' or '/branch-lock clear'.
EOF
  )"
fi

allow
