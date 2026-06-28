#!/usr/bin/env bash
# Dev PreToolUse shell-command guard.
#
# Reads a Claude/Codex/OpenCode-style PreToolUse payload on stdin, extracts the
# shell command, and blocks it when it matches a deny rule from .red/config.yaml:
#
#   command_guard:
#     deny:
#       - "sudo *"
#       - "rm -rf *"
#
#   plugins:
#     dev:
#       enabled: true
#
# The hook is dormant unless plugins.dev.enabled is true. Missing/empty deny
# rules allow the command. Deny rules accept explicit modes:
# `regex:<pattern>`, `prefix:<literal>`, `suffix:<literal>`, `exact:<literal>`,
# and `glob:<pattern>`. Bare rules with glob metacharacters are treated as globs;
# every other bare rule matches the exact command, a command prefix, or a command
# suffix at a shell-command boundary.

set -uo pipefail

INPUT="$(cat 2>/dev/null || true)"

allow() {
  printf '{}'
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

read_deny_patterns() {
  local -a STACK=()
  local -a INDENTS=()
  local raw line indent_str indent rest parent key value full item

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
      if [[ "$parent" == "command_guard.deny" ||
            "$parent" == "plugins.dev.command_guard.deny" ||
            "$parent" == "dev.command_guard.deny" ]]; then
        item="$(unquote_scalar "${rest#-}")"
        [[ -n "$item" ]] && printf '%s\n' "$item"
      fi
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

    if [[ "$full" == "command_guard.deny" ||
          "$full" == "plugins.dev.command_guard.deny" ||
          "$full" == "dev.command_guard.deny" ]]; then
      item="$(unquote_scalar "$value")"
      [[ -n "$item" ]] && printf '%s\n' "$item"
    fi
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

while IFS= read -r rule; do
  [[ -n "$rule" ]] || continue
  if matches_rule "$COMMAND" "$rule"; then
    cat >&2 <<EOF
BLOCKED by RedSkills command guard.
The command '$COMMAND' matched deny rule '$rule' from .red/config.yaml.

Remove or narrow command_guard.deny if this command is intentional.
EOF
    exit 2
  fi
done < <(read_deny_patterns)

allow
