#!/usr/bin/env bash
# Dev PreToolUse shell-command guard.
#
# Reads a Claude/Codex/OpenCode-style PreToolUse payload on stdin, extracts the
# shell command, and blocks it when it matches a deny rule from .red/config.yaml:
#
#   command_guard:
#     global:
#       - "sudo *"
#       - "rm -rf *"
#     main:
#       - "git rebase"
#     worktree:
#       - "git clean"
#
#   plugins:
#     dev:
#       enabled: true
#
# The hook is dormant unless plugins.dev.enabled is true. Once enabled, the dev
# invariant is built in: agent-created git worktrees must live under .red/tmp/,
# and branch-moving commands are blocked in the primary checkout. Missing/empty
# deny rules still allow every other command. `global` rules apply in every
# scope, `main` rules apply outside RedSkills runtime worktrees, and `worktree`
# rules apply inside `/afk` and `/go` worktrees. Deny rules accept explicit
# modes: `regex:<pattern>`, `prefix:<literal>`, `suffix:<literal>`,
# `exact:<literal>`, and `glob:<pattern>`. Bare rules with glob metacharacters
# are treated as globs; every other bare rule matches the exact command, a
# command prefix, or a command suffix at a shell-command boundary.

set -uo pipefail

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

command -v jq >/dev/null 2>&1 || allow

COMMAND="$(
  jq -r '
    def command_value:
      .tool_input.command? //
      .tool_input.cmd? //
      .tool_input.args.command? //
      .input.command? //
      .input.cmd? //
      .arguments.command? //
      .arguments.cmd? //
      .command? //
      .cmd? //
      empty;
    command_value
    | if type == "array" then map(tostring) | join(" ")
      elif type == "string" then .
      else ""
      end
  ' <<<"$INPUT" 2>/dev/null
)"
[[ -n "$COMMAND" && "$COMMAND" != "null" ]] || allow

ROOT="$(jq -r '.cwd // .workspace.current_dir // empty' <<<"$INPUT" 2>/dev/null)"
[[ -z "$ROOT" || "$ROOT" == "null" ]] && ROOT="${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-}}"
[[ -z "$ROOT" || "$ROOT" == "null" ]] && ROOT="$(pwd)"

if [[ -n "$ROOT" && ! -d "$ROOT/.git" ]]; then
  ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$ROOT")"
fi
[[ -n "$ROOT" ]] || allow

find_config() {
  local dir="$1"
  local i
  for ((i = 0; i < 64; i++)); do
    if [[ -f "$dir/.red/config.yaml" ]]; then
      printf '%s\n' "$dir/.red/config.yaml"
      return 0
    fi
    [[ "$dir" == "/" ]] && break
    dir="$(dirname "$dir")"
  done
  return 1
}

CONFIG="$(find_config "$ROOT" || true)"
[[ -n "$CONFIG" ]] || allow
REPO_ROOT="${CONFIG%/.red/config.yaml}"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

strip_comment() {
  local s="$1"
  if [[ "$s" != *\"* && "$s" != *\'* ]]; then
    s="${s%%#*}"
  fi
  trim "$s"
}

strip_line_comment() {
  local s="$1"
  if [[ "$s" != *\"* && "$s" != *\'* ]]; then
    s="${s%%#*}"
  fi
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

unquote_scalar() {
  local s
  s="$(strip_comment "$1")"
  local q="${s:0:1}"
  if [[ "$q" == '"' || "$q" == "'" ]]; then
    local rest="${s:1}"
    local before="${rest%%"$q"*}"
    if [[ "$rest" == *"$q"* ]]; then
      local close_len=$((1 + ${#before} + 1))
      local tail="${s:$close_len}"
      if [[ "$tail" =~ ^[[:space:]]*(#.*)?$ ]]; then
        s="${s:1:${#before}}"
      fi
    fi
  fi
  trim "$s"
}

join_stack() {
  local joined="" item
  for item in "${STACK[@]}"; do
    [[ -n "$joined" ]] && joined+="."
    joined+="$item"
  done
  printf '%s' "$joined"
}

read_config_scalar() {
  local wanted="$1"
  local -a STACK=()
  local -a INDENTS=()
  local raw line indent_str indent rest key value full

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    line="$(strip_line_comment "$raw")"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    indent_str="${raw%%[![:space:]]*}"
    indent=${#indent_str}
    ((indent % 2 == 0)) || return 1
    rest="${line:$indent}"

    [[ "$rest" =~ ^[A-Za-z_][A-Za-z0-9_-]*: ]] || continue
    key="${rest%%:*}"
    value="${rest#*:}"
    value="$(trim "$value")"

    while ((${#INDENTS[@]} > 0 && INDENTS[${#INDENTS[@]} - 1] >= indent)); do
      unset "STACK[$((${#STACK[@]} - 1))]"
      unset "INDENTS[$((${#INDENTS[@]} - 1))]"
    done

    full="$(join_stack)"
    [[ -n "$full" ]] && full+="."
    full+="$key"

    if [[ -z "$value" ]]; then
      STACK+=("$key")
      INDENTS+=("$indent")
      continue
    fi

    if [[ "$full" == "$wanted" ]]; then
      unquote_scalar "$value"
      return 0
    fi
  done <"$CONFIG"

  return 1
}

enabled="$(read_config_scalar "plugins.dev.enabled" || true)"
[[ "$enabled" == "true" ]] || allow

scope_is_command_guard_worktree() {
  local root="$1"
  case "$root" in
    */.red/tmp/work-* | */.red/tmp/work-*/*) return 0 ;;
    */.red/tmp/workers/*/worktree | */.red/tmp/workers/*/worktree/*) return 0 ;;
    *) return 1 ;;
  esac
}

COMMAND_GUARD_SCOPE="main"
scope_is_command_guard_worktree "$ROOT" && COMMAND_GUARD_SCOPE="worktree"

canonical_path() {
  local base="$1"
  local path="$2"
  if [[ "$path" == /* ]]; then
    realpath -m -- "$path" 2>/dev/null || printf '%s\n' "$path"
  else
    realpath -m -- "$base/$path" 2>/dev/null || printf '%s/%s\n' "$base" "$path"
  fi
}

git_subcommand_index() {
  local -n tokens_ref="$1"
  local git_index="$2"
  local -n cwd_ref="$3"
  local k=$((git_index + 1))
  local len=${#tokens_ref[@]}
  while ((k < len)); do
    local tok="${tokens_ref[k]}"
    case "$tok" in
      -C)
        if ((k + 1 < len)); then
          cwd_ref="$(canonical_path "$cwd_ref" "${tokens_ref[k + 1]}")"
        fi
        k=$((k + 2))
        continue
        ;;
      -c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)
        k=$((k + 2))
        continue
        ;;
      --*=*|-*)
        k=$((k + 1))
        continue
        ;;
      *)
        break
        ;;
    esac
  done
  printf '%s\n' "$k"
}

skip_git_worktree_add_option() {
  local -n tokens_ref="$1"
  local -n index_ref="$2"
  local len=${#tokens_ref[@]}
  local tok="${tokens_ref[index_ref]}"
  case "$tok" in
    -b|-B|--orphan|--reason)
      index_ref=$((index_ref + 2))
      return 0
      ;;
    --reason=*|--orphan=*)
      index_ref=$((index_ref + 1))
      return 0
      ;;
    --detach|--checkout|--no-checkout|--guess-remote|--no-guess-remote|--force|-f|--lock)
      index_ref=$((index_ref + 1))
      return 0
      ;;
    --)
      index_ref=$((index_ref + 1))
      return 1
      ;;
    --*)
      index_ref=$((index_ref + 1))
      return 0
      ;;
    -*)
      # Unknown short option. Treat it as a flag so the destination is still the
      # first non-option token; if the option actually consumed an argument, the
      # guard fails closed on a non-.red/tmp "destination".
      index_ref=$((index_ref + 1))
      return 0
      ;;
    *)
      ((index_ref < len))
      return 1
      ;;
  esac
}

worktree_add_destination() {
  local tokens_name="$1"
  local -n tokens_ref="$tokens_name"
  local git_index="$2"
  local cwd="$ROOT"
  local s
  s="$(git_subcommand_index "$tokens_name" "$git_index" cwd)"
  [[ "${tokens_ref[s]:-}" == "worktree" && "${tokens_ref[s + 1]:-}" == "add" ]] || return 1

  local j=$((s + 2))
  local len=${#tokens_ref[@]}
  while ((j < len)); do
    if skip_git_worktree_add_option "$tokens_name" j; then
      continue
    fi
    [[ -n "${tokens_ref[j]:-}" ]] || return 1
    printf '%s\t%s\n' "$cwd" "${tokens_ref[j]}"
    return 0
  done
  return 1
}

primary_branch_movement_reason() {
  local tokens_name="$1"
  local -n tokens_ref="$tokens_name"
  local n=${#tokens_ref[@]}
  local i j s sub

  for ((i = 0; i < n; i++)); do
    if [[ "${tokens_ref[i]}" == "gh" && "${tokens_ref[i + 1]:-}" == "pr" && "${tokens_ref[i + 2]:-}" == "checkout" ]]; then
      printf 'gh pr checkout changes the primary checkout; create or reuse a .red/tmp worktree for the PR branch instead'
      return 0
    fi

    [[ "${tokens_ref[i]}" == "git" ]] || continue
    local cwd="$ROOT"
    s="$(git_subcommand_index "$tokens_name" "$i" cwd)"
    sub="${tokens_ref[s]:-}"
    case "$sub" in
      checkout|switch)
        local target="" saw_doubledash=0
        for ((j = s + 1; j < n; j++)); do
          local t="${tokens_ref[j]}"
          case "$t" in
            --)
              saw_doubledash=1
              continue
              ;;
            -b|-B|-c|-C|--create|--force-create|--orphan|--track)
              printf 'git %s creates or checks out a branch in the primary checkout; use git worktree add .red/tmp/work-<slug> -b <branch> ... instead' "$sub"
              return 0
              ;;
            --create=*|--force-create=*|--orphan=*)
              printf 'git %s creates a branch in the primary checkout; use git worktree add .red/tmp/work-<slug> -b <branch> ... instead' "$sub"
              return 0
              ;;
            -*)
              continue
              ;;
            *)
              target="$t"
              break
              ;;
          esac
        done
        ((saw_doubledash)) && continue
        [[ -z "$target" || "$target" == "." ]] && continue
        printf 'git %s changes the primary checkout branch; create or enter a .red/tmp worktree instead' "$sub"
        return 0
        ;;
    esac
  done

  return 1
}

enforce_dev_worktree_policy() {
  local -a tokens
  read -ra tokens <<<"$COMMAND"
  local n=${#tokens[@]}
  ((n > 0)) || return 0

  local i
  for ((i = 0; i < n; i++)); do
    [[ "${tokens[i]}" == "git" ]] || continue
    local pair cwd dest abs allowed_root
    pair="$(worktree_add_destination tokens "$i" || true)"
    [[ -n "$pair" ]] || continue
    cwd="${pair%%$'\t'*}"
    dest="${pair#*$'\t'}"
    abs="$(canonical_path "$cwd" "$dest")"
    allowed_root="$(canonical_path "$REPO_ROOT" ".red/tmp")"
    case "$abs" in
      "$allowed_root"/*)
        ;;
      *)
        deny "$(cat <<EOF
BLOCKED by RedSkills dev worktree guard.
plugins.dev.enabled is true, so agent-created git worktrees must live under .red/tmp/.

Requested worktree path: $dest
Resolved worktree path:  $abs
Allowed root:            $allowed_root/

Use: git worktree add .red/tmp/work-<slug> -b <branch> origin/main
EOF
        )"
        ;;
    esac
  done

  if [[ "$COMMAND_GUARD_SCOPE" == "main" ]]; then
    local reason
    reason="$(primary_branch_movement_reason tokens || true)"
    if [[ -n "$reason" ]]; then
      deny "$(cat <<EOF
BLOCKED by RedSkills dev primary-checkout guard.
plugins.dev.enabled is true, so agents must not create or switch branches in the primary checkout.

$reason.
EOF
      )"
    fi
  fi
}

enforce_dev_worktree_policy

is_gh_write_command() {
  local upper
  upper="$(printf '%s' "$COMMAND" | tr '[:lower:]' '[:upper:]')"
  [[ "$upper" =~ (^|[[:space:]\;\&\|])GH[[:space:]]+ISSUE[[:space:]]+(COMMENT|CREATE|EDIT)([[:space:]]|$) ]] && return 0
  [[ "$upper" =~ (^|[[:space:]\;\&\|])GH[[:space:]]+PR[[:space:]]+(COMMENT|CREATE|EDIT|REVIEW)([[:space:]]|$) ]] && return 0
  [[ "$upper" =~ (^|[[:space:]\;\&\|])GH[[:space:]]+RELEASE[[:space:]]+(CREATE|EDIT)([[:space:]]|$) ]] && return 0
  [[ "$upper" =~ (^|[[:space:]\;\&\|])GH[[:space:]]+GIST[[:space:]]+CREATE([[:space:]]|$) ]] && return 0
  [[ "$upper" =~ (^|[[:space:]\;\&\|])RSP[[:space:]]+GH[[:space:]]+ISSUE[[:space:]]+(COMMENT|CREATE|EDIT)([[:space:]]|$) ]] && return 0
  [[ "$upper" =~ (^|[[:space:]\;\&\|])RSP[[:space:]]+GH[[:space:]]+PR[[:space:]]+(COMMENT|CREATE|EDIT|REVIEW)([[:space:]]|$) ]] && return 0
  return 1
}

has_gh_body_home_path() {
  [[ "$COMMAND" =~ (^|[[:space:]])(--body|-b)(=|[[:space:]]+).*(/home/[^[:space:]\'\"]+|/Users/[^[:space:]\'\"]+) ]]
}

has_sensitive_assignment() {
  local upper
  upper="$(printf '%s' "$COMMAND" | tr '[:lower:]' '[:upper:]')"
  [[ "$upper" =~ [A-Z0-9_]*(TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|API-KEY)[A-Z0-9_-]*=[^[:space:]\'\"]+ ]]
}

enforce_no_leak_gh_write_policy() {
  is_gh_write_command || return 0
  local reason=""
  if [[ "$COMMAND" == *"claude.ai/code/session_"* ]]; then
    reason="Claude session link"
  elif has_gh_body_home_path; then
    reason="absolute home path in gh body text"
  elif has_sensitive_assignment; then
    reason="sensitive KEY=value assignment"
  fi

  [[ -n "$reason" ]] || return 0
  deny "$(cat <<EOF
BLOCKED by RedSkills no-leak command guard.
The gh write command contains a public-output leak pattern: $reason.

Redact and retry. Use placeholders such as [REDACTED_HOME], [REDACTED_SECRET], or [REDACTED_CLAUDE_SESSION] when the reference is unavoidable.
EOF
  )"
}

enforce_no_leak_gh_write_policy

# Returns the filename component if path targets the .red/tmp/ root directly
# (no named-lane subdirectory after the root).  Returns nothing otherwise.
tmp_root_blocked_path() {
  local raw="$1"
  local s="$raw"
  [[ "$s" == \'* ]] && s="${s:1}" && s="${s%\'}"
  [[ "$s" == \"* ]] && s="${s:1}" && s="${s%\"}"
  local rel
  case "$s" in
    "$REPO_ROOT/.red/tmp/"*)
      rel="${s#$REPO_ROOT/.red/tmp/}"
      ;;
    ".red/tmp/"*)
      rel="${s#.red/tmp/}"
      ;;
    *)
      return 1
      ;;
  esac
  [[ -n "$rel" && "$rel" != */* ]] || return 1
  printf '%s' "$rel"
}

deny_tmp_root_write() {
  local path="$1"
  deny "$(cat <<EOF
BLOCKED by RedSkills tmp-root write guard.
plugins.dev.enabled is true, so files must not be created directly at .red/tmp/.

Requested path: $path
Correct lanes:  .red/tmp/logs/<YYYY-MM-DD>/ for session logs
                .red/tmp/scratch/ for ad-hoc scratch files

Write to the appropriate named lane instead.
EOF
  )"
}

enforce_tmp_root_write_policy() {
  local -a tokens
  read -ra tokens <<<"$COMMAND"
  local n=${#tokens[@]}
  ((n > 0)) || return 0

  local i j leaf

  for ((i = 0; i < n; i++)); do
    local tok="${tokens[i]}"
    local redir_target=""

    # Standalone or concatenated redirection operators
    case "$tok" in
      '>'|'>>'|[0-9]'>'|[0-9]'>>'|'&>'|'&>>')
        redir_target="${tokens[i+1]:-}"
        ;;
      '>'?*|'>>'?*)
        if [[ "$tok" == '>>'* ]]; then
          redir_target="${tok#>>}"
        else
          redir_target="${tok#>}"
        fi
        ;;
      [0-9]'>'?*|[0-9]'>>'?*)
        local re_fd_append='^[0-9]+>>(.+)'
        local re_fd_write='^[0-9]+>(.+)'
        if [[ "$tok" =~ $re_fd_append ]]; then
          redir_target="${BASH_REMATCH[1]}"
        elif [[ "$tok" =~ $re_fd_write ]]; then
          redir_target="${BASH_REMATCH[1]}"
        fi
        ;;
      '&>'?*|'&>>'?*)
        if [[ "$tok" == '&>>'* ]]; then
          redir_target="${tok#&>>}"
        else
          redir_target="${tok#&>}"
        fi
        ;;
    esac

    if [[ -n "$redir_target" ]]; then
      leaf="$(tmp_root_blocked_path "$redir_target" || true)"
      [[ -n "$leaf" ]] && deny_tmp_root_write "$redir_target"
    fi

    # File-creating commands: touch, tee, cp, mv
    case "$tok" in
      touch|tee)
        for ((j = i + 1; j < n; j++)); do
          local arg="${tokens[j]}"
          case "$arg" in '>'|'>>'|'|'|'&&'|'||'|';') break ;; esac
          [[ "${arg:0:1}" == "-" ]] && continue
          leaf="$(tmp_root_blocked_path "$arg" || true)"
          [[ -n "$leaf" ]] && deny_tmp_root_write "$arg"
        done
        ;;
      cp|mv)
        local -a positional=()
        for ((j = i + 1; j < n; j++)); do
          local arg="${tokens[j]}"
          case "$arg" in '>'|'>>'|'|'|'&&'|'||'|';') break ;; esac
          [[ "${arg:0:1}" == "-" ]] && continue
          positional+=("$arg")
        done
        if [[ ${#positional[@]} -ge 2 ]]; then
          local dest="${positional[${#positional[@]}-1]}"
          leaf="$(tmp_root_blocked_path "$dest" || true)"
          [[ -n "$leaf" ]] && deny_tmp_root_write "$dest"
        fi
        ;;
    esac
  done
}

enforce_tmp_root_write_policy

strip_path_token() {
  local s="$1"
  [[ "$s" == \'* ]] && s="${s:1}" && s="${s%\'}"
  [[ "$s" == \"* ]] && s="${s:1}" && s="${s%\"}"
  printf '%s' "$s"
}

pid_file_live() {
  local pid_file="$1" raw
  [[ -f "$pid_file" ]] || return 1
  raw="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$raw" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$raw" 2>/dev/null
}

supervisor_delete_reason() {
  local abs="$1" dir
  for dir in \
    "$(canonical_path "$REPO_ROOT" ".red/state/afk")" \
    "$(canonical_path "$REPO_ROOT" ".red/tmp")"
  do
    case "$abs" in
      "$dir"/afk-supervisor.*|"$dir")
        if pid_file_live "$dir/afk-supervisor.pid"; then
          printf 'refusing to delete live supervisor artifacts under %s' "$dir"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

worker_delete_reason() {
  local abs="$1" tmp_root ns prefix rel worker worker_dir
  tmp_root="$(canonical_path "$REPO_ROOT" ".red/tmp")"
  for ns in workers go-workers scout-workers; do
    prefix="$tmp_root/$ns/"
    case "$abs" in
      "$prefix"*)
        rel="${abs#$prefix}"
        worker="${rel%%/*}"
        [[ -n "$worker" ]] || continue
        worker_dir="$prefix$worker"
        if pid_file_live "$worker_dir/worker.pid"; then
          printf 'refusing to delete live worker artifacts under %s' "$worker_dir"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

delete_target_reason() {
  local raw="$1" s abs tmp_root rel reason
  s="$(strip_path_token "$raw")"
  [[ -n "$s" ]] || return 1
  abs="$(canonical_path "$ROOT" "$s")"
  tmp_root="$(canonical_path "$REPO_ROOT" ".red/tmp")"

  if [[ "$abs" == "$tmp_root" ]]; then
    printf 'refusing to delete the .red/tmp root'
    return 0
  fi

  case "$abs" in
    "$tmp_root"/*)
      rel="${abs#$tmp_root/}"
      if [[ "$rel" == "*" ]]; then
        printf 'refusing to delete every entry under .red/tmp'
        return 0
      fi
      ;;
  esac

  reason="$(supervisor_delete_reason "$abs" || true)"
  if [[ -n "$reason" ]]; then
    printf '%s' "$reason"
    return 0
  fi

  reason="$(worker_delete_reason "$abs" || true)"
  if [[ -n "$reason" ]]; then
    printf '%s' "$reason"
    return 0
  fi

  return 1
}

deny_tmp_delete() {
  local path="$1" reason="$2"
  deny "$(cat <<EOF
BLOCKED by RedSkills tmp deletion guard.
plugins.dev.enabled is true, so cleanup commands must delete a named lane under .red/tmp/, not the tmp root or live liveness anchors.

Requested path: $path
Reason: $reason

Target a specific owned lane or stop the live supervisor/worker before removing its anchors.
EOF
  )"
}

enforce_tmp_delete_policy() {
  local -a tokens
  read -ra tokens <<<"$COMMAND"
  local n=${#tokens[@]}
  ((n > 0)) || return 0

  local i j arg reason
  for ((i = 0; i < n; i++)); do
    case "${tokens[i]}" in
      rm|/bin/rm|/usr/bin/rm)
        for ((j = i + 1; j < n; j++)); do
          arg="${tokens[j]}"
          case "$arg" in '>'|'>>'|'|'|'&&'|'||'|';') break ;; esac
          [[ "$arg" == -- ]] && continue
          [[ "${arg:0:1}" == "-" ]] && continue
          reason="$(delete_target_reason "$arg" || true)"
          [[ -n "$reason" ]] && deny_tmp_delete "$arg" "$reason"
        done
        ;;
    esac
  done
}

enforce_tmp_delete_policy

guard_scope_for_path() {
  local path="$1"
  case "$path" in
    command_guard.global | \
      command_guard.deny | \
      plugins.dev.command_guard.global | \
      plugins.dev.command_guard.deny | \
      dev.command_guard.global | \
      dev.command_guard.deny)
      printf 'global'
      ;;
    command_guard.main | plugins.dev.command_guard.main | dev.command_guard.main)
      printf 'main'
      ;;
    command_guard.worktree | plugins.dev.command_guard.worktree | dev.command_guard.worktree)
      printf 'worktree'
      ;;
    *)
      return 1
      ;;
  esac
}

emit_deny_pattern() {
  local path="$1"
  local raw_value="$2"
  local scope item
  scope="$(guard_scope_for_path "$path" || true)"
  [[ -n "$scope" ]] || return 0
  [[ "$scope" == "global" || "$scope" == "$COMMAND_GUARD_SCOPE" ]] || return 0
  item="$(unquote_scalar "$raw_value")"
  [[ -n "$item" ]] && printf '%s\t%s\n' "$scope" "$item"
}

read_deny_patterns() {
  local -a STACK=()
  local -a INDENTS=()
  local raw line indent_str indent rest parent key value full

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    line="$(strip_line_comment "$raw")"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    indent_str="${raw%%[![:space:]]*}"
    indent=${#indent_str}
    ((indent % 2 == 0)) || return 0
    rest="${line:$indent}"

    while ((${#INDENTS[@]} > 0 && INDENTS[${#INDENTS[@]} - 1] >= indent)); do
      unset "STACK[$((${#STACK[@]} - 1))]"
      unset "INDENTS[$((${#INDENTS[@]} - 1))]"
    done

    if [[ "$rest" =~ ^-([[:space:]]|$) ]]; then
      parent="$(join_stack)"
      emit_deny_pattern "$parent" "${rest#-}"
      continue
    fi

    [[ "$rest" =~ ^[A-Za-z_][A-Za-z0-9_-]*: ]] || continue
    key="${rest%%:*}"
    value="${rest#*:}"
    value="$(trim "$value")"
    full="$(join_stack)"
    [[ -n "$full" ]] && full+="."
    full+="$key"

    if [[ -z "$value" ]]; then
      STACK+=("$key")
      INDENTS+=("$indent")
      continue
    fi

    emit_deny_pattern "$full" "$value"
  done <"$CONFIG"
}

has_leading_command_boundary() {
  local value="$1"
  local first="${value:0:1}"
  [[ -z "$value" ||
    "$first" == ";" ||
    "$first" == "&" ||
    "$first" == "|" ||
    "$first" =~ [[:space:]] ]]
}

has_trailing_command_boundary() {
  local value="$1"
  local last="${value: -1}"
  [[ -z "$value" ||
    "$last" == ";" ||
    "$last" == "&" ||
    "$last" == "|" ||
    "$last" =~ [[:space:]] ]]
}

matches_rule() {
  local command="$1"
  local rule="$2"
  local mode="" pattern="$rule"
  case "$rule" in
    regex:*|re:*)
      pattern="${rule#*:}"
      [[ -n "$pattern" && "$command" =~ $pattern ]]
      return
      ;;
    prefix:*)
      mode="prefix"
      pattern="${rule#prefix:}"
      ;;
    suffix:*)
      mode="suffix"
      pattern="${rule#suffix:}"
      ;;
    exact:*)
      mode="exact"
      pattern="${rule#exact:}"
      ;;
    glob:*)
      mode="glob"
      pattern="${rule#glob:}"
      ;;
  esac

  local left right
  case "$mode" in
    prefix)
      right="${command#"$pattern"}"
      [[ "$right" != "$command" ]] && has_leading_command_boundary "$right"
      return
      ;;
    suffix)
      left="${command%"$pattern"}"
      [[ "$left" != "$command" ]] && has_trailing_command_boundary "$left"
      return
      ;;
    exact)
      [[ "$command" == "$pattern" ]]
      return
      ;;
    glob)
      [[ "$command" == $pattern ]]
      return
      ;;
  esac

  case "$rule" in
    *[\*\?\[]*)
      [[ "$command" == $rule ]]
      ;;
    *)
      if [[ "$command" == "$rule" ]]; then
        return 0
      fi
      right="${command#"$rule"}"
      left="${command%"$rule"}"
      ([[ "$right" != "$command" ]] && has_leading_command_boundary "$right") ||
        ([[ "$left" != "$command" ]] && has_trailing_command_boundary "$left")
      ;;
  esac
}

while IFS=$'\t' read -r rule_scope rule; do
  [[ -n "$rule" ]] || continue
  if matches_rule "$COMMAND" "$rule"; then
    deny "$(cat <<EOF
BLOCKED by RedSkills command guard.
The command '$COMMAND' matched command_guard.$rule_scope rule '$rule' from .red/config.yaml.

Remove or narrow command_guard.$rule_scope if this command is intentional.
EOF
    )"
  fi
done < <(read_deny_patterns)

allow
