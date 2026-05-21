#!/bin/bash
# block-dangerous-git.sh — git-guardrails PreToolUse(Bash) hook.
#
# Two independent layers, both ending in exit 2 (Claude Code's "deny this tool
# call") with a message on stderr:
#
#   1. Always-on dangerous patterns — push, reset --hard, clean -f, branch -D,
#      whole-tree checkout/restore. These fire regardless of any branch lock and
#      are the skill's original purpose.
#
#   2. Branch-lock awareness — when a branch lock is active in the primary
#      checkout (an opt-in `.red/tmp/branch-lock.yaml` whose content is the
#      locked branch), the hook ALSO blocks the branch-leaving / work-loss family
#      (switch/checkout to another branch, `switch -`, bare `git stash`). This is
#      a self-contained re-implementation: git-guardrails reads the lock and
#      classifies the command on its own and never sources or requires the
#      branch-lock skill (issue #65 — independent, no dependency). If branch-lock
#      is also installed the two hooks reach the same verdict and stack
#      idempotently — both deny, neither conflicts.
#
# The lock layer stays silent (no block) when there is no lock file, and is
# scope-exempt inside /afk worktrees under .red/tmp/work-*/, mirroring the
# branch-lock hook so the autonomous loop is never strangled.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

DANGEROUS_PATTERNS=(
  "git push"
  "git reset --hard"
  "git clean -fd"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
  "push --force"
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

# --- Branch-lock awareness (self-contained; no branch-lock skill dependency) ---

[ -z "$COMMAND" ] && exit 0

# Project root: prefer the harness-provided dir, fall back to the git toplevel.
ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi
[ -z "$ROOT" ] && exit 0

# Scope: /afk worktrees under .red/tmp/work-*/ are exempt even when locked.
case "$ROOT" in
  */.red/tmp/work-*) exit 0 ;;
  */.red/tmp/work-*/*) exit 0 ;;
esac

# Read the lock target (first line, trailing whitespace stripped). Absent or
# empty file means unlocked — nothing more to enforce.
LOCKFILE="$ROOT/.red/tmp/branch-lock.yaml"
[ -s "$LOCKFILE" ] || exit 0
IFS= read -r LOCK_BRANCH < "$LOCKFILE"
LOCK_BRANCH="${LOCK_BRANCH%"${LOCK_BRANCH##*[![:space:]]}"}"
[ -z "$LOCK_BRANCH" ] && exit 0

# Classify the command against the lock. Scans the token stream for a `git` token
# followed by a recognised subcommand, so compound commands (`cd x && git switch
# y`) are still caught. Only the branch-leaving / work-loss family blocks; the
# work-loss members already caught by the dangerous patterns above are harmless
# duplicates here.
read -ra _toks <<<"$COMMAND"
_n=${#_toks[@]}
_verdict="allow"
for ((_i = 0; _i < _n; _i++)); do
  [ "${_toks[_i]}" = "git" ] || continue
  _sub="${_toks[_i + 1]:-}"
  case "$_sub" in
    worktree)
      _verdict="allow"; break ;;
    stash)
      _op="${_toks[_i + 2]:-}"
      if [ -z "$_op" ] || [ "$_op" = "push" ] || [ "$_op" = "save" ]; then
        _verdict="block"
      fi
      break ;;
    checkout|switch)
      _target=""; _sawdd=0
      for ((_j = _i + 2; _j < _n; _j++)); do
        _t="${_toks[_j]}"
        if [ "$_t" = "--" ]; then _sawdd=1; continue; fi
        if [ "$_t" = "-" ]; then _target="-"; break; fi   # `switch -` = previous branch
        case "$_t" in -*) continue ;; esac               # skip flags (-b, -c, --track, …)
        _target="$_t"; break
      done
      if [ "$_target" = "." ]; then _verdict="block"; break; fi   # whole-tree restore (already a pattern)
      [ "$_sawdd" -eq 1 ] && break                                # file restore: allow
      [ -z "$_target" ] && break                                  # bare checkout: allow
      [ "$_target" = "$LOCK_BRANCH" ] && break                    # back to the lock target: allow
      _verdict="block"; break ;;
  esac
done

if [ "$_verdict" = "block" ]; then
  cat >&2 <<EOF
BLOCKED by branch lock: this session is locked to '$LOCK_BRANCH'.
The command '$COMMAND' would switch the agent away from the locked branch or
shelve the working tree. To change or release the lock, ask the user — they
drive it with '/branch-lock <branch>' or '/branch-lock clear'.
EOF
  exit 2
fi

exit 0
