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
#
#   3. Primary branch guard — when `.red/config.yaml` sets
#      `dev.lock-primary-branch: true`, the hook blocks branch-switching in the
#      primary checkout even without a branch-lock file. This is also
#      self-contained and keeps the same worktree exemption.

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

# Runtime reader for the one dev flag ADR 0043 needs. Missing file/key or
# malformed input is disabled, so the plugin-level hook is dormant by default.
_dev_lock_primary_branch_enabled() {
  local _file="$1"
  [ -f "$_file" ] || return 1

  local -a _stack=()
  local -a _indents=()
  local _raw _line _indent_str _indent _rest _key _value _full _i

  while IFS= read -r _raw || [ -n "$_raw" ]; do
    _raw="${_raw%$'\r'}"
    _line="$_raw"
    if [[ "$_line" != *\"* && "$_line" != *\'* ]]; then
      _line="${_line%%#*}"
    fi
    _line="${_line%"${_line##*[![:space:]]}"}"
    [ -z "${_line//[[:space:]]/}" ] && continue

    _indent_str="${_line%%[![:space:]]*}"
    _indent=${#_indent_str}
    (( _indent % 2 == 0 )) || return 1
    _rest="${_line:$_indent}"

    [[ "$_rest" =~ ^[A-Za-z_][A-Za-z0-9_-]*: ]] || return 1
    _key="${_rest%%:*}"
    _value="${_rest#*:}"
    _value="${_value#"${_value%%[![:space:]]*}"}"

    while ((${#_indents[@]} > 0 && _indents[${#_indents[@]} - 1] >= _indent)); do
      local _last_stack=$(( ${#_stack[@]} - 1 ))
      local _last_indent=$(( ${#_indents[@]} - 1 ))
      unset "_stack[$_last_stack]"
      unset "_indents[$_last_indent]"
    done

    _full=""
    for ((_i = 0; _i < ${#_stack[@]}; _i++)); do
      [ -n "$_full" ] && _full+="."
      _full+="${_stack[$_i]}"
    done
    [ -n "$_full" ] && _full+="."
    _full+="$_key"

    if [ -z "$_value" ]; then
      _stack+=("$_key")
      _indents+=("$_indent")
      continue
    fi

    if [[ "$_value" == \"*\" && "$_value" == *\" ]]; then
      _value="${_value:1:${#_value}-2}"
    elif [[ "$_value" == \'*\' && "$_value" == *\' ]]; then
      _value="${_value:1:${#_value}-2}"
    fi

    if [ "$_full" = "dev.lock-primary-branch" ]; then
      [ "$_value" = "true" ] && return 0
      return 1
    fi
  done < "$_file"

  return 1
}

_primary_branch_switch_verdict() {
  local _cmd="$1"
  read -ra _pb_toks <<<"$_cmd"
  local _pb_n=${#_pb_toks[@]} _pb_i _pb_j
  for ((_pb_i = 0; _pb_i < _pb_n; _pb_i++)); do
    [ "${_pb_toks[_pb_i]}" = "git" ] || continue
    local _pb_sub="${_pb_toks[_pb_i + 1]:-}"
    case "$_pb_sub" in
      worktree)
        echo "allow"; return 0 ;;
      checkout|switch)
        local _pb_target="" _pb_sawdd=0
        for ((_pb_j = _pb_i + 2; _pb_j < _pb_n; _pb_j++)); do
          local _pb_t="${_pb_toks[_pb_j]}"
          if [ "$_pb_t" = "--" ]; then _pb_sawdd=1; continue; fi
          if [ "$_pb_t" = "-" ]; then _pb_target="-"; break; fi
          case "$_pb_t" in -*) continue ;; esac
          _pb_target="$_pb_t"; break
        done
        [ "$_pb_sawdd" -eq 1 ] && { echo "allow"; return 0; }
        [ -z "$_pb_target" ] && { echo "allow"; return 0; }
        [ "$_pb_target" = "." ] && { echo "allow"; return 0; }
        echo "block"; return 0 ;;
    esac
  done
  echo "allow"; return 0
}

if _dev_lock_primary_branch_enabled "$ROOT/.red/config.yaml" &&
  [ "$(_primary_branch_switch_verdict "$COMMAND")" = "block" ]; then
  cat >&2 <<EOF
BLOCKED by primary branch guard: dev.lock-primary-branch is true.
The command '$COMMAND' would switch the agent's primary checkout branch.

Allowed in the primary checkout: git commit, git worktree add, read-only git,
and non-branch-changing commands. To work on another branch, create/use a
worktree under .red/tmp/work-*/ or ask the user to change the primary branch.
EOF
  exit 2
fi

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
