#!/usr/bin/env bash
# config.sh — single source of truth for .red/config.yaml.
#
# Public surface:
#   config_load [path]    — populate CONFIG_VALUES from defaults, then merge
#                           the file at `path` (defaults to
#                           "$PROJECT_ROOT/.red/config.yaml" then "$PWD/.red/config.yaml").
#                           Missing file → all defaults. Malformed YAML → one
#                           warning line on stderr, all defaults.
#   config_get KEY        — print the value for dotted KEY (e.g.
#                           afk.fleet.target). Empty string if unset.
#
# The parser is deliberately tiny: it accepts the flat schema documented in
# PRD #16 — nested mappings keyed by [a-zA-Z_][a-zA-Z0-9_-]* with 2-space
# indentation, scalar leaves only. It does NOT depend on yq. Unknown keys
# parse fine (forward compatibility); they just end up in CONFIG_VALUES and
# never get read by any documented accessor.
#
# Source guard so re-sourcing from afk.sh + supervisor.sh + tests is idempotent.

[[ "${_AFK_CONFIG_SH_LOADED:-}" == "1" ]] && return 0
_AFK_CONFIG_SH_LOADED=1

declare -gA CONFIG_VALUES=()

# Documented v1 defaults. Adding a key here is the only way to expand the
# schema — keep this list and the PRD #16 schema block in sync.
_config_set_defaults() {
  CONFIG_VALUES=(
    [afk.default_runner]=claude
    [afk.fleet.target]=2
    [afk.hooks.defaults.cargo]=true
    [afk.hooks.defaults.gradle]=true
  )
}

config_load() {
  local file="${1:-}"
  if [[ -z "$file" ]]; then
    file="${PROJECT_ROOT:-$PWD}/.red/config.yaml"
  fi

  _config_set_defaults
  [[ -f "$file" ]] || return 0

  local parsed
  if ! parsed="$(_config_parse_yaml "$file")"; then
    printf '[afk:config] warn: malformed YAML in %s — using defaults\n' "$file" >&2
    _config_set_defaults
    return 0
  fi

  local line key value
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ -z "$key" ]] && continue
    CONFIG_VALUES["$key"]="$value"
  done <<< "$parsed"
}

config_get() {
  local key="${1:-}"
  printf '%s\n' "${CONFIG_VALUES[$key]:-}"
}

# _config_parse_yaml FILE
# Emits `dotted.key=value` lines on stdout. Returns non-zero (and silently —
# the caller owns the warning) if the file violates the tiny-YAML grammar.
_config_parse_yaml() {
  local file="$1"
  local -a stack=()
  local -a indents=()
  local lineno=0 line stripped indent_str indent rest key value parent full

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"

    # strip inline comments. Quoted-string-aware enough for the v1 schema:
    # if a value is a quoted string we trust it to be closed (validated
    # below); otherwise # always starts a comment.
    stripped="$line"
    if [[ "$stripped" != *\"*\"* && "$stripped" != *\'*\'* ]]; then
      stripped="${stripped%%#*}"
    fi

    # skip blank
    [[ -z "${stripped//[[:space:]]/}" ]] && continue

    indent_str="${stripped%%[![:space:]]*}"
    indent=${#indent_str}
    if (( indent % 2 != 0 )); then
      return 1
    fi

    rest="${stripped#"$indent_str"}"
    # trim trailing whitespace
    rest="${rest%"${rest##*[![:space:]]}"}"

    if [[ ! "$rest" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*: ]]; then
      return 1
    fi

    key="${rest%%:*}"
    value="${rest#*:}"
    # trim leading whitespace from value
    value="${value#"${value%%[![:space:]]*}"}"

    # unclosed-quote detection
    if [[ "$value" == \"* ]]; then
      if [[ "${value: -1}" != '"' || ${#value} -lt 2 ]]; then
        return 1
      fi
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'* ]]; then
      if [[ "${value: -1}" != "'" || ${#value} -lt 2 ]]; then
        return 1
      fi
      value="${value:1:${#value}-2}"
    fi

    # pop parents whose indent is >= current
    while (( ${#indents[@]} > 0 )) && (( indents[${#indents[@]} - 1] >= indent )); do
      unset 'stack[${#stack[@]}-1]'
      unset 'indents[${#indents[@]}-1]'
      # re-pack to avoid sparse-array indexing surprises
      stack=("${stack[@]}")
      indents=("${indents[@]}")
    done

    if (( ${#stack[@]} > 0 )); then
      parent="$(IFS=.; printf '%s' "${stack[*]}")"
      full="${parent}.${key}"
    else
      full="$key"
    fi

    if [[ -z "$value" ]]; then
      stack+=("$key")
      indents+=("$indent")
    else
      printf '%s=%s\n' "$full" "$value"
    fi
  done < "$file"

  return 0
}
