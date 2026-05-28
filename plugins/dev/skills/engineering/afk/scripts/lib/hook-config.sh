#!/usr/bin/env bash
# hook-config.sh — loader for `afk.hooks.<name>` in .red/config.yaml.
#
# Public surface:
#   hook_config_load [FILE]
#     Parse the `afk.hooks` block of FILE (defaults to
#     "$PROJECT_ROOT/.red/config.yaml") and call hook_register for every
#     declared command, merging built-in defaults (gated by
#     `afk.hooks.defaults.<name>` toggles) before user hooks. Unknown hook
#     names abort with rc=3 and a `[afk:hooks] unknown hook name` line on
#     stderr. The minimal YAML grammar accepted:
#       afk:
#         hooks:
#           pre_session: "echo boot"           # bare string shorthand
#           post_session:                      # block list
#             - "echo done"
#             - "/usr/local/bin/notify"
#           defaults:
#             cargo: false                     # toggle for built-in default
#     Anything that does not parse against this grammar is reported and
#     ignored (load continues — a malformed line is not a session boot
#     failure on its own; only an unknown hook *name* aborts).
#
#   hook_config_register_defaults
#     Register the AFK-shipped built-in default hooks at their lifecycle
#     points, gated by `afk.hooks.defaults.<name>` toggles. The first
#     tracer (issue #208) ships none — the function exists so subsequent
#     slices can register migrated defaults without touching the loader
#     wiring.

[[ "${_AFK_HOOK_CONFIG_LOADED:-}" == "1" ]] && return 0
_AFK_HOOK_CONFIG_LOADED=1

_HOOK_CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./hook-dispatcher.sh
source "$_HOOK_CONFIG_DIR/hook-dispatcher.sh"

declare -gA HOOK_DEFAULTS_DISABLED=()

_hook_config_log() {
  printf '[afk:hooks] %s\n' "$*" >&2
}

# Strip leading/trailing whitespace.
_hook_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Unquote a YAML scalar if it is single- or double-quoted.
_hook_unquote() {
  local v="$1" inner
  if [[ "${v:0:1}" == '"' && "${v: -1}" == '"' && ${#v} -ge 2 ]]; then
    inner="${v:1:${#v}-2}"
    # Minimal YAML double-quote escape handling: \" → " and \\ → \.
    inner="${inner//\\\"/\"}"
    inner="${inner//\\\\/\\}"
    printf '%s' "$inner"
  elif [[ "${v:0:1}" == "'" && "${v: -1}" == "'" && ${#v} -ge 2 ]]; then
    # Single-quoted YAML: only '' is an escape for a single quote.
    inner="${v:1:${#v}-2}"
    inner="${inner//\'\'/\'}"
    printf '%s' "$inner"
  else
    printf '%s' "$v"
  fi
}

# Register built-in defaults at their lifecycle points. Called BEFORE
# user-declared hooks so user hooks always run last at any point. Defaults
# register in a fixed alphabetical order at each point; users can only
# *disable* individual defaults via `afk.hooks.defaults.<name>: false`,
# never reorder them (see SKILL.md "Lifecycle Hooks").
#
# Currently shipped (issue #211, PRD #207):
#   pre_worktree:
#     - cargo   → defaults/cargo-pre-worktree.sh
#     - gradle  → defaults/gradle-pre-worktree.sh
hook_config_register_defaults() {
  # Always derive the defaults dir from this file's own location — lib/
  # lives at <plugin>/scripts/lib, so climbing two levels lands at the
  # plugin root. RED_AFK_PLUGIN_DIR can point at a co-installed copy of
  # the skill that does not yet ship these defaults (e.g. when a worktree
  # adds new ones), so we deliberately anchor on this file instead.
  local plugin_dir
  plugin_dir="$(cd "$_HOOK_CONFIG_DIR/../.." && pwd)"
  local defaults_dir="$plugin_dir/defaults"

  if [[ -z "${HOOK_DEFAULTS_DISABLED[cargo]:-}" \
        && -x "$defaults_dir/cargo-pre-worktree.sh" ]]; then
    hook_register pre_worktree "$defaults_dir/cargo-pre-worktree.sh"
  fi
  if [[ -z "${HOOK_DEFAULTS_DISABLED[gradle]:-}" \
        && -x "$defaults_dir/gradle-pre-worktree.sh" ]]; then
    hook_register pre_worktree "$defaults_dir/gradle-pre-worktree.sh"
  fi
}

# hook_config_load [FILE]
hook_config_load() {
  local file="${1:-}"
  if [[ -z "$file" ]]; then
    file="${PROJECT_ROOT:-$PWD}/.red/config.yaml"
  fi

  # Reset state on every load.
  HOOK_LISTS=()
  HOOK_DEFAULTS_DISABLED=()

  if [[ ! -f "$file" ]]; then
    hook_config_register_defaults
    return 0
  fi

  local -a lines=()
  local raw
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    lines+=("$raw")
  done < "$file"

  local n=${#lines[@]} i=0
  local in_afk=0 in_hooks=0 in_defaults=0
  local current_list_name=""
  local -a current_list_items=()
  local -a user_order=()    # hook names in declaration order
  declare -A user_lists=()  # name → newline-joined commands
  local line stripped indent_str indent rest key value

  _stash_user_cmd() {
    local _name="$1" _cmd="$2"
    if [[ -z "${user_lists[$_name]:-}" ]]; then
      user_order+=("$_name")
      user_lists[$_name]="$_cmd"
    else
      user_lists[$_name]="${user_lists[$_name]}"$'\n'"$_cmd"
    fi
  }

  _flush_list() {
    if [[ -n "$current_list_name" ]]; then
      if ! hook_is_canonical "$current_list_name"; then
        _hook_config_log "unknown hook name '$current_list_name' in $file"
        return 3
      fi
      local _item
      for _item in "${current_list_items[@]}"; do
        _stash_user_cmd "$current_list_name" "$_item"
      done
    fi
    current_list_name=""
    current_list_items=()
    return 0
  }

  while (( i < n )); do
    line="${lines[$i]}"
    i=$((i + 1))

    # Strip inline comments outside quoted strings (cheap heuristic).
    stripped="$line"
    if [[ "$stripped" != *\"*\"* && "$stripped" != *\'*\'* ]]; then
      stripped="${stripped%%#*}"
    fi
    # Skip blank lines.
    if [[ -z "${stripped//[[:space:]]/}" ]]; then
      continue
    fi

    indent_str="${stripped%%[![:space:]]*}"
    indent=${#indent_str}
    rest="${stripped#"$indent_str"}"
    rest="$(_hook_trim "$rest")"

    # List item under a hook list?
    if [[ -n "$current_list_name" && "$rest" == -* ]]; then
      if (( indent >= 6 )); then
        local item="${rest#-}"
        item="$(_hook_trim "$item")"
        item="$(_hook_unquote "$item")"
        current_list_items+=("$item")
        continue
      fi
    fi

    # Any non-list line closes the previous pending list.
    _flush_list || return $?

    # Block transitions are indent-based.
    if (( indent == 0 )); then
      in_afk=0; in_hooks=0; in_defaults=0
      if [[ "$rest" == "afk:" ]]; then
        in_afk=1
      fi
      continue
    fi

    if (( in_afk == 0 )); then
      continue
    fi

    if (( indent == 2 )); then
      in_hooks=0; in_defaults=0
      if [[ "$rest" == "hooks:" ]]; then
        in_hooks=1
      fi
      continue
    fi

    if (( in_hooks == 0 )); then
      continue
    fi

    # We are inside `afk.hooks`.
    if (( indent == 4 )); then
      in_defaults=0
      # Two shapes:
      #   <name>: <scalar>     → bare-string shorthand
      #   <name>:              → block list opens at indent 6
      #   defaults:            → opens defaults sub-block at indent 6
      if [[ ! "$rest" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*: ]]; then
        _hook_config_log "unparseable line under afk.hooks: $line"
        continue
      fi
      key="${rest%%:*}"
      value="${rest#*:}"
      value="$(_hook_trim "$value")"

      if [[ "$key" == "defaults" ]]; then
        in_defaults=1
        continue
      fi

      if ! hook_is_canonical "$key"; then
        _hook_config_log "unknown hook name '$key' in $file"
        return 3
      fi

      if [[ -z "$value" ]]; then
        # Block list opens.
        current_list_name="$key"
        current_list_items=()
        continue
      fi

      # Bare-string shorthand → one-element list.
      value="$(_hook_unquote "$value")"
      _stash_user_cmd "$key" "$value"
      continue
    fi

    if (( indent == 6 && in_defaults == 1 )); then
      if [[ ! "$rest" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*: ]]; then
        continue
      fi
      key="${rest%%:*}"
      value="$(_hook_trim "${rest#*:}")"
      value="$(_hook_unquote "$value")"
      if [[ "$value" == "false" ]]; then
        HOOK_DEFAULTS_DISABLED[$key]=1
      fi
      continue
    fi
  done

  _flush_list || return $?

  # Defaults register first so they always run before user-declared hooks
  # at the same lifecycle point.
  hook_config_register_defaults

  # Now replay user-declared hooks in declaration order.
  local name cmd
  for name in "${user_order[@]}"; do
    while IFS= read -r cmd; do
      [[ -z "$cmd" ]] && continue
      hook_register "$name" "$cmd"
    done <<< "${user_lists[$name]}"
  done

  return 0
}
