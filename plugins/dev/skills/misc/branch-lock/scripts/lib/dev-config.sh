#!/usr/bin/env bash
# lib/dev-config.sh — tiny runtime reader for `.red/config.yaml` dev flags.
#
# The hook must be dormant by default: missing config file or missing key means
# disabled. This parser intentionally mirrors the constrained YAML shape used by
# the dev runtime: nested 2-space mappings with scalar leaves. It only exposes
# the single flag ADR 0043 needs.

# dev_config_lock_primary_branch_enabled <config.yaml>
# Returns 0 when the primary-branch lock is on, 1 otherwise. The flag lives at
# `dev.lock.primary-branch` (top-level) or `plugins.dev.lock.primary-branch`
# (namespaced); either set to exactly `true` enables the guard.
dev_config_lock_primary_branch_enabled() {
  local _file="$1"
  [[ -f "$_file" ]] || return 1

  local -a _stack=()
  local -a _indents=()
  local _raw _line _indent_str _indent _rest _key _value _full _i
  local _inner _before_close _close_len _tail

  while IFS= read -r _raw || [[ -n "$_raw" ]]; do
    _raw="${_raw%$'\r'}"
    _line="$_raw"

    if [[ "$_line" != *\"* && "$_line" != *\'* ]]; then
      _line="${_line%%#*}"
    fi
    _line="${_line%"${_line##*[![:space:]]}"}"
    [[ -z "${_line//[[:space:]]/}" ]] && continue

    _indent_str="${_line%%[![:space:]]*}"
    _indent=${#_indent_str}
    (( _indent % 2 == 0 )) || return 1
    _rest="${_line:$_indent}"

    # Skip block-sequence items (`- value`) — they never contain dev flags.
    # A top-level sequence (empty stack) mirrors the TS parser: malformed → bail.
    if [[ "$_rest" =~ ^-([[:space:]]|$) ]]; then
      (( ${#_stack[@]} == 0 )) && return 1
      continue
    fi

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
      [[ -n "$_full" ]] && _full+="."
      _full+="${_stack[$_i]}"
    done
    [[ -n "$_full" ]] && _full+="."
    _full+="$_key"

    if [[ -z "$_value" ]]; then
      _stack+=("$_key")
      _indents+=("$_indent")
      continue
    fi

    # Strip an inline comment that follows a closing quote (e.g. `key: "v" # note`).
    if [[ "${_value:0:1}" == '"' ]]; then
      _inner="${_value:1}"
      _before_close="${_inner%%\"*}"
      if [[ "$_inner" == *'"'* ]]; then
        _close_len=$(( 1 + ${#_before_close} + 1 ))
        _tail="${_value:$_close_len}"
        if [[ "$_tail" =~ ^[[:space:]]*(#.*)?$ ]]; then
          _value="${_value:0:$_close_len}"
        fi
      fi
    elif [[ "${_value:0:1}" == "'" ]]; then
      _inner="${_value:1}"
      _before_close="${_inner%%\'*}"
      if [[ "$_inner" == *"'"* ]]; then
        _close_len=$(( 1 + ${#_before_close} + 1 ))
        _tail="${_value:$_close_len}"
        if [[ "$_tail" =~ ^[[:space:]]*(#.*)?$ ]]; then
          _value="${_value:0:$_close_len}"
        fi
      fi
    fi

    if [[ "$_value" == \"*\" && "$_value" == *\" ]]; then
      _value="${_value:1:${#_value}-2}"
    elif [[ "$_value" == \'*\' && "$_value" == *\' ]]; then
      _value="${_value:1:${#_value}-2}"
    fi

    if [[ "$_full" == "dev.lock.primary-branch" || "$_full" == "plugins.dev.lock.primary-branch" ]]; then
      [[ "$_value" == "true" ]] && return 0
    fi
  done < "$_file"

  return 1
}
